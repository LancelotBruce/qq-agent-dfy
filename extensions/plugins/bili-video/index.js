// B 站视频转发插件（确定性型 · 提供 media.download 能力）。
//
// ── 它解决什么 ────────────────────────────────────────────────────────────
// 群里有人粘 B 站链接（含 b23.tv 短链）→ 本插件下载视频并作为**视频**发到群里，
// 同时补一条文案（标题 / UP 主 / 时长 / 原链接）。整条链路不经过 LLM：条件满足必然执行。
//
// ── 为什么必须由本进程下载，而不是把直链交给协议端 ─────────────────────────
// B 站 CDN **不带 Referer 一律 403**（带则 206 正常）。协议端不会替我们带
// Referer，所以"把 playurl 直链丢给 OneBot 视频段"这条路是死的 —— 必须本进程下完，
// 再用本地文件路径发。
//
// ── 安全边界（刻意保留的取舍，别当成疏漏）──────────────────────────────────
// 核心的 safe-fetch 有 SSRF 校验，但它按"只允许预期域名"设计，而 B 站 CDN 主机
// 并不在 bilibili.com 域名下（实际拿到 某个非 bilibili.com 的 CDN 域名），
// 直接套用会把自己拦死。这里的边界改为：
//   · **只下载本插件通过 playurl 拿到的地址**，绝不下载消息里出现的任意 URL
//     （用户可控的输入只有"哪个 BV 号"，下载目标由 B 站接口决定）；
//   · 体积上限硬限制，超了立刻取消并删除半截文件；
//   · 非 200/206、Content-Type 是 HTML/JSON 的一律拒绝（防止把错误页当视频发出去）。
// 也就是说：SSRF 面被收窄成"只能连 api.bilibili.com 与它返回的 CDN"，而不是"能连任意地址"。

import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
// 0.5 的兼容垫片把 src/config.js 投影成"数据根 + DATA_DIR"，0.4 里它也在同一位置。
// 原来这里写死 <安装目录>\data\logs，等于把 0.5 的日志往旧版数据目录里塞。
import { DATA_DIR } from '../../src/config.js';
import {
  isBiliLink, pickBiliLink, pickBareVideoToken, resolveLink, fetchVideoInfo,
  getPlayUrl, downloadVideo, safeFileName, shareCaption, qualityLabel,
  searchVideos
} from './bili-api.js';

// ── 配置与依赖注入 ────────────────────────────────────────────────────────

let cfg = () => ({});
let log = () => {};
let warn = () => {};
// 0.5 的插件 ctx（含 send 通道）；0.4 下 setup 拿到的是旧 api，这里只用来兜底发送。
let apiRef = null;

// 插件自己的 log 只进宿主控制台，主日志文件里搜不到（2026-11-08 排查时
// "分片完成"、下载文件名一行都没有，等于下载阶段完全不可见）。这里额外落一份按天
// 的文件：异步写、失败静默，只加观测不改任何执行路径。
function pluginLogDir() {
  try {
    const dir = path.join(DATA_DIR, 'logs');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch { /* ignore */ }
  try {
    if (fs.existsSync(path.join(process.cwd(), 'data'))) return path.join(process.cwd(), 'data', 'logs');
  } catch { /* ignore */ }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'logs');
}

function writeFileLog(level, msg) {
  try {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hms = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    fs.promises.appendFile(path.join(pluginLogDir(), `bili-video-${ymd}.log`), `${ymd} ${hms} [${level}] ${msg}\n`)
      .catch(() => { /* 落盘失败不影响转发 */ });
  } catch { /* ignore */ }
}

// ── 串行闸门：同一时刻只让一条视频走「下载 + 上传」 ────────────────────────
//
// 宿主 src/sender.js 的 #chain 是**按会话**串行的：同一个群不会并发，但两个群
// 同时粘 B 站链接就会同时往协议端推视频。协议端那条 native 上传实现（Highway）
// 不是并发安全的 —— 2026-11-08 那次 0xC0000374 堆损坏就落在它身上。
// 这里补一道全局闸门，N 个群同时来链接也排队一条条走：代价是多等几秒，
// 换来少一次进程崩溃（崩一次群里要静默好几秒，还连带别的消息全丢）。
let shareChain = Promise.resolve();

function serializeShare(fn) {
  const next = shareChain.then(fn, fn);            // 前一个无论成败都放行，不让一次失败堵死后面
  shareChain = next.then(() => {}, () => {});      // 链上只存 fulfilled 状态，否则整条链会被拒绝态短路
  return next;
}

export function setup(api) {
  apiRef = api || null;
  cfg = api.config;
  log = (m) => { api.log(m); writeFileLog('INFO', m); };
  warn = (m) => { api.warn(m); writeFileLog('WARN', m); };
  registerTools(api);
}

/**
 * 把 0.5 的 ctx.send 包成 0.4 sender 的形态（sendMedia / sendTextBatch）。
 * 0.5 没有 sender 单例，只有 ctx.send(chatKey, segments, opts) —— 老代码全是
 * sender.sendMedia(...) 调用，包一层比逐处改分享逻辑安全。
 */
function sendAdapter(sendFn) {
  if (typeof sendFn !== 'function') return null;
  return {
    sendMedia: (chatKey, segments, opts = {}) => sendFn(chatKey, segments, opts || {}),
    sendTextBatch: async (chatKey, texts = []) => {
      const out = [];
      for (const text of texts) out.push(await sendFn(chatKey, [{ type: 'text', text: String(text) }]));
      return out;
    }
  };
}

/**
 * 补注册 bili_video 工具。
 *
 * 为什么必须有：提示词段一直在说「你只在有人要你找/推荐 B 站视频时才调 bili_video 工具」，
 * 但本插件原先只提供 media.download 能力，**没有 tools 导出** —— 运行时的 63 个工具里
 * 根本没有 bili_video。那就等于每轮花字符教模型去调一个不存在的工具：模型要么白调
 * 一次，要么干脆自己编个标题/链接出来。搜/发本来就在 bili-api.js 里写好了
 * （searchVideos 带风控重试与 WBI 签名），缺的只是把它按工具的形态接出来。
 */
function registerTools(api) {
  if (typeof api?.registerTool !== 'function') return;
  api.registerTool({
    id: 'bili_video',
    name: '搜B站视频',
    description: '在 B 站按关键词搜视频，返回标题/UP主/时长/播放量/链接。人让你找/推荐视频时用。默认只搜不发；要真发进群，带上次结果里的 bvid 并设 send=true，插件下载后发到当前会话。标题链接以结果为准，别编。',
    category: 'media',
    icon: '📺',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '搜索词。想指定某个 UP 主就写他的名字。' },
        bvid: { type: 'string', description: '要发送的 BV 号（来自上一次搜索结果）。' },
        send: { type: 'boolean', description: 'true=把 bvid 对应视频下载并发进当前会话。默认 false。' },
        limit: { type: 'number', description: '返回条数，默认 5，最多 10。' }
      }
    },
    async execute(ctx, args) {
      const a = args || {};
      const bvid = (String(a.bvid || '').match(/BV[0-9A-Za-z]{8,}/i) || [])[0] || '';
      const send = a.send === true || a.send === 'true';
      try {
        if (bvid && send) {
          // 0.5 里既没有 ctx.sender 也没有 src/sender.js：用 ctx.send / 插件 ctx.send 包一层
          const sender = ctx?.sender || await fallbackSender()
            || sendAdapter(ctx?.send) || sendAdapter(apiRef?.send);
          const r = await shareBiliVideo({
            url: `https://www.bilibili.com/video/${bvid}`,
            chatKey: ctx?.chatKey,
            sender
          });
          if (r?.skip) return { content: '没认出有效的 B 站视频号。' };
          if (!r?.ok) return { content: `没发成：${r?.friendly || r?.error || '未知原因'}` };
          if (!r.mediaSent) {
            return { content: `视频没发出去（已降级成文案），标题是《${r.title}》。原链接 ${r.url}` };
          }
          return { content: `已把《${r.title}》发进会话（${r.quality}，${(Number(r.bytes) / 1048576).toFixed(1)}MB）。` };
        }

        const kw = String(a.keyword || '').trim();
        if (!kw) return { content: '要搜什么？给我一个关键词。', isError: true };
        const c = cfg();
        const s = await searchVideos(kw, {
          limit: Math.max(1, Math.min(10, Number(a.limit) || 5)),
          sortBy: String(c.sortBy || 'up-first'),
          maxDurationSec: Number(c.maxDurationSec) || 0,
          minDurationSec: Number(c.minDurationSec) || 0,
          fuzzy: c.fuzzySearch !== false,
          log
        });
        if (!s.ok) return { content: `搜索失败：${s.error || '未知原因'}`, isError: true };
        if (!s.items?.length) return { content: `「${kw}」没搜到合适的视频。` };
        const lines = s.items.map((x, i) =>
          `${i + 1}. ${x.title} ／ ${x.author} ／ ${x.duration} ／ 播放 ${x.playText || x.play} ／ ${x.url}`);
        const head = s.usedKeyword && s.usedKeyword !== kw ? `（改用「${s.usedKeyword}」搜的）` : '';
        return { content: `${head}「${kw}」搜到 ${s.items.length} 条：\n${lines.join('\n')}\n要发哪条，把它的 bvid 带上并设 send=true。` };
      } catch (error) {
        return { content: `B 站操作失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

/**
 * sender 的兜底获取。
 *
 * dispatchMediaLinks 传进来的 ctx 里**应该有** sender，但这一条我无法在不启动整个
 * 应用的前提下验证（app.js 的调用点是闭包内的私有变量）。所以这里做一次兜底：
 * 真没传进来时，直接从应用源码 import 那个单例。找不到就降级成"只发文案"，绝不让
 * 整条链路因为发不出媒体而炸掉 —— 那会让群友连链接都看不到。
 */
let senderModulePromise = null;
async function fallbackSender() {
  if (!senderModulePromise) {
    const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
    const candidates = [
      path.join(appRoot, 'src', 'sender.js'),
      path.join(appRoot, 'src', 'app.js')
    ];
    senderModulePromise = (async () => {
      for (const file of candidates) {
        if (!fs.existsSync(file)) continue;
        try {
          // 带时间戳 import：与加载器的热重载口径一致，避免拿到旧模块实例
          const mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`);
          if (file.endsWith('sender.js') && mod?.sender) return mod.sender;
          if (mod?.sender) return mod.sender;
        } catch (error) {
          warn(`从 ${path.basename(file)} 取 sender 失败：${error?.message ?? error}`);
        }
      }
      return null;
    })();
  }
  return senderModulePromise;
}

function resolveMediaDir() {
  const configured = String(cfg().mediaDir || '').trim();
  if (configured) return configured;
  // 默认落在应用 data/ 旁边（与配置、会话、记忆同处），而不是安装目录：
  // 安装目录在 Program Files 下时通常不可写。
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  return path.join(appRoot, 'data', 'bili-media');
}

/** 清理过期媒体文件：下载下来的视频发完就没用了，留着只会撑爆磁盘。 */
function pruneOldFiles(dir, maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && now - st.mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* 单个文件清理失败不影响其它 */ }
    }
  } catch { /* 目录不存在/无权限：静默 */ }
}

// ── 发送重试：协议端崩溃会在 send_group_msg 上先报 ECONNRESET ──────────────
//
// 2026-11-08 20:33:44 实测：视频已完整下载（下载层无事），发视频时 SnowLuma 在
// 上传路径上堆损坏崩溃（0xC0000374 STATUS_HEAP_CORRUPTION），OneBot 的 ws 随即被
// 重置，send_group_msg 收到 [ECONNRESET]。协议端约 3 秒自动重启、5 秒重连，所以
// "立刻重试"必然连败；而"不重试"整条消息就静默丢了 —— 连降级文案都发不出去，
// 因为文案本身也要走发送，协议端死了它一样发不出。
//
// 策略：只对**连接类**错误重试，且先探 3001 端口是否真的回来了再发。
// 限频、去重命中、文件不存在这些非连接错误一律不重试 —— 重试只会把问题放大。

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 连接类错误：协议端进程没了 / ws 被重置，等它起来就能发。 */
const CONN_DROP_RE =
  /ECONNRESET|ECONNREFUSED|EPIPE|other side closed|socket hang up|OneBot\s*(未|不)在线/i;

/** 探测 OneBot 的 ws 端口是否已重新监听（TCP 能连 ≈ 协议端已就绪）。 */
function onebotPortOpen(port = 3001, timeoutMs = 1200) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    const done = (v) => { try { sock.destroy(); } catch { /* ignore */ } resolve(v); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

/** 等协议端回来，最多等 maxWaitMs。等不到就返回 false，让上层正常报错。 */
async function waitOnebotReady(maxWaitMs = 20000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    if (await onebotPortOpen()) return true;
    await sleep(1500);
  }
  return false;
}

/**
 * 发送媒体，遇连接类错误自动等协议端重启后重试。
 *
 * ⚠️ 刻意不改宿主 sender.js：那里是全机器人所有消息的出口，内部还是按会话串行的
 * chain，在那一层加等待会把整个会话的发送卡住（文字/表情/拍一拍全排队）。
 * 重试只属于本插件这种"一次失败整条内容就没了"的场景。
 *
 * 去重是安全的：sender.sendMedia 的 #markSent 在**发送成功之后**才记账，
 * 所以重试不会被误判成"重复刷屏"。
 */
async function sendMediaWithRetry(sender, chatKey, segs, options, { attempts = 2 } = {}) {
  let lastError = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await sender.sendMedia(chatKey, segs, options);
    } catch (error) {
      const msg = String(error?.message ?? error);
      // 去重命中不是失败，交回原逻辑按"已发过"处理
      if (msg.includes('刚刚发过')) throw error;
      // 非连接问题（限频 / 文件不存在 / 段非法）不重试
      if (!CONN_DROP_RE.test(msg) || i === attempts - 1) throw error;
      lastError = error;
      warn(`视频发送遇到连接中断（${msg.slice(0, 60)}），等协议端就绪后重试 ${i + 1}/${attempts - 1}`);
      const ready = await waitOnebotReady();
      if (!ready) {
        warn('协议端 20 秒内仍未就绪，放弃重试');
        throw error;
      }
      await sleep(1200);   // 端口起来后 OneBot 会话还要一点时间才 ready，再缓一拍
    }
  }
  throw lastError;
}

// ── 发送 ──────────────────────────────────────────────────────────────────

/**
 * 发视频段 + 可选的文案。
 *
 * ⚠️ **视频必须独占一条消息**（这一条很重要）：
 *   拼成 [{video},{text}] 一次发出，协议端直接拒：
 *   `retcode=1400 message element "video" must be the only segment in a message`
 *   而且它是**发送阶段**才拒 —— 视频已经下载完、文件也落在磁盘上了，才在最后一步
 *   失败。表现就是"下载成功但群里什么都没有"。
 *   所以顺序是：先单独发视频，**再**单独发文案。两条消息，不是一条。
 *
 * 优先 sendMedia（自带串行/限频/去重/留档四道保护），sender 拿不到时降级纯文字。
 * 文案里带原链接：就算视频因为体积被跳过，群友也点得进去 —— 这是刻意的降级路径。
 */
async function sendVideoWithCaption({ sender, chatKey, filePath, caption, replyToMessageId = null }) {
  if (!filePath) {
    if (sender?.sendTextBatch) await sender.sendTextBatch(chatKey, [caption]);
    return { sent: false, mediaSent: false };
  }
  if (!sender?.sendMedia) {
    const fb = await fallbackSender();
    if (fb?.sendMedia) sender = fb;
  }
  if (!sender?.sendMedia) {
    warn('拿不到 sender.sendMedia，降级为只发文案');
    if (sender?.sendTextBatch) await sender.sendTextBatch(chatKey, [caption]);
    return { sent: false, mediaSent: false, reason: 'no-sender' };
  }

  // 视频段：**只有它自己**
  let mediaSent = true;
  let deduped = false;
  try {
    await sendMediaWithRetry(sender, chatKey, [{ type: 'video', data: { file: filePath } }], {
      label: `[B站视频]${caption ? `:${caption.split('\n')[0].slice(0, 40)}` : ''}`,
      dedupeKey: filePath,
      replyToMessageId: replyToMessageId || null
    });
  } catch (error) {
    const msg = String(error?.message ?? error);
    // 视频"刚刚发过被跳过"不算失败：说明同一视频已经在本会话发出过（常见于
    // 同一张卡片同时解析出 b23 短链 + 完整链接，触发两次）。此时不该发
    // "没转发成功"误导群友，按成功处理即可。
    if (msg.includes('刚刚发过')) {
      mediaSent = false;
      deduped = true;
    } else {
      throw error;   // 真失败：冒泡给 provider 正常报错
    }
  }

  // 文案另发一条。失败不该把已成功的视频算成失败 —— 视频才是重点。
  // 视频真实发出（mediaSent）后，追加一句"机器人自述"：让群友/模型上下文里
  // 有"它知道自己转发了"的实感（仅视频发出时追加，降级只发链接/文案时不加）。
  // ⚠️ 去重命中（deduped）时视频与文案都已在本会话发过：整条跳过，不再刷屏。
  let captionSent = false;
  if (!deduped && caption && sender.sendTextBatch) {
    try {
      const finalCaption = mediaSent
        ? `${caption}\n\n（本鲸转发的~ 视频在这↑）`
        : caption;
      await sender.sendTextBatch(chatKey, [finalCaption]);
      captionSent = true;
    } catch (error) {
      warn(`视频已发出，但文案发送失败：${error?.message ?? error}`);
    }
  }
  return { sent: true, mediaSent, deduped, captionSent };
}

/** 从消息文本里抠出被引用消息的 id（消息流里的引用标记形态）。 */
function replyIdFromText(text) {
  const m = String(text || '').match(/\[引用[^\]]*?id[=:]\s*(-?\d+)/i);
  return m ? m[1] : null;
}

// ── 核心：处理一个链接 ────────────────────────────────────────────────────

/**
 * 下载并分享一个 B 站视频。
 * 抽成独立函数是为了让 provider 与 internals 自测共用同一条路径 —— 测试跑的是真代码。
 */
export async function shareBiliVideo({ url, chatKey, sender = null, onebot = null, replyToMessageId = null, onebotFallback = null }) {
  // 链接形态优先；没有链接时吃裸 BV/av 号（群里只粘一个 BV 号很常见）
  const link = pickBiliLink(url) || pickBareVideoToken(url) || String(url || '').trim();
  if (!link) return { ok: false, skip: true };

  const resolved = await resolveLink(link);
  if (resolved.error) return { ok: false, error: resolved.error, friendly: '这个 B 站链接我打不开，可能被删了或者失效了' };
  if (resolved.kind === 'unknown') return { ok: false, skip: true };

  const info = await fetchVideoInfo(resolved);
  if (!info.ok) return { ok: false, error: info.error, friendly: '视频信息拉不到，可能已删除或需要登录' };

  const pageUrl = info.bvid ? `https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}` : link;
  const caption = shareCaption(info, { link: pageUrl });
  const dir = resolveMediaDir();
  pruneOldFiles(dir);

  const play = await getPlayUrl(info.bvid, info.cid, { qn: Number(cfg().qn) || 16 });
  if (!play.ok) {
    // 取流失败（会员专享/需要登录）：降级发文案，别让群友什么都看不到
    const reason = String(play.error || '');
    await sendVideoWithCaption({ sender: sender || onebotFallback, chatKey, filePath: null, caption: `${caption}\n（这个视频我拉不到视频流，可能仅限登录/大会员观看）` });
    return { ok: true, degraded: true, platform: 'bilibili', title: info.title, url: pageUrl, error: reason };
  }

  const maxMB = Math.max(1, Math.min(600, Number(cfg().maxMB) || 100));
  const maxBytes = maxMB * 1024 * 1024;
  if (play.sizeBytes && play.sizeBytes > maxBytes) {
    await sendVideoWithCaption({
      sender: sender || onebotFallback, chatKey, filePath: null,
      caption: `${caption}\n（原视频 ${(play.sizeBytes / 1048576).toFixed(1)}MB，超过我设的 ${maxMB}MB 上限，直接给你链接）`
    });
    return { ok: true, degraded: true, reason: 'too-large', platform: 'bilibili', title: info.title, url: pageUrl, sizeBytes: play.sizeBytes };
  }

  fs.mkdirSync(dir, { recursive: true });
  const fileName = safeFileName(info);
  const dest = path.join(dir, fileName);
  const dlOpts = {
    maxBytes,
    referer: pageUrl,
    timeoutMs: Math.max(15000, Number(cfg().timeoutMs) || 60000),
    log: (m) => log(`${fileName} ${m}`)
  };
  let dl = await downloadVideo(play.urls, dest, dlOpts);
  // 断流重试：坏 CDN 节点重连同一条地址往往还是断，所以失败后重新取一次 playurl
  // 换节点/换签名再下（实测 2026-11-08 20:17 那次 2.39MB 视频就是节点掐流，换节点 3.9 秒下完）。
  if (!dl.ok && dl.aborted) {
    const play2 = await getPlayUrl(info.bvid, info.cid, { qn: Number(cfg().qn) || 16 });
    if (play2.ok && Array.isArray(play2.urls) && play2.urls.length) {
      log(`${fileName} 首次下载中断，换 CDN 节点重试（${((play2.sizeBytes || 0) / 1048576).toFixed(1)}MB）`);
      dl = await downloadVideo(play2.urls, dest, dlOpts);
      if (dl.ok && play2.sizeBytes && dl.bytes !== play2.sizeBytes) {
        dl = { ok: false, error: `下载不完整（${dl.bytes}/${play2.sizeBytes} 字节）`, aborted: true };
      }
    }
  }
  // 字节数对不上说明流提前结束（服务端正常 close 但数据不全），同样按失败处理
  if (dl.ok && play.sizeBytes && dl.bytes !== play.sizeBytes) {
    dl = { ok: false, error: `下载不完整（${dl.bytes}/${play.sizeBytes} 字节）`, aborted: true };
  }
  if (!dl.ok) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    // 失败也把文案发出去：链接本身是有价值的，静默失败才是真的糟
    await sendVideoWithCaption({
      sender: sender || onebotFallback, chatKey, filePath: null,
      caption: `${caption}\n（视频下载到一半断开了，我重连也没成功，链接直接给你）`
    });
    return { ok: false, error: dl.error, stage: 'download', friendly: dl.tooLarge ? `这个视频超过 ${maxMB}MB，我发不动，链接给你了` : '' };
  }

  const effSender = sender || onebotFallback;
  const r = await sendVideoWithCaption({ sender: effSender, chatKey, filePath: dest, caption, replyToMessageId });
  log(`已转发《${info.title}》（${info.author}，${qualityLabel(play.qn)}，${(dl.bytes / 1048576).toFixed(1)}MB）`);
  return {
    ok: true, platform: 'bilibili', title: info.title, url: pageUrl,
    bvid: info.bvid, quality: qualityLabel(play.qn), bytes: dl.bytes,
    mediaSent: r.mediaSent, filePath: dest
  };
}

// ── 0.5 契约：下载归我，发送归内核 ─────────────────────────────────────────

/**
 * 只下载不发送：0.5 的 media.download 是"认领"模型，内核拿到段自己发
 * （bundled/runtime-defaults/business.js 的 forwardLinkedMedia）。
 * 0.4 时代这里是把 sender 一起传进来自己发，两种契约不能混着用。
 */
async function prepareVideo(rawUrl) {
  const link = pickBiliLink(rawUrl) || pickBareVideoToken(rawUrl) || String(rawUrl || '').trim();
  if (!link) return { skip: true };

  const resolved = await resolveLink(link);
  if (resolved.error) return { ok: false, error: resolved.error, friendly: '这个 B 站链接我打不开，可能被删了或者失效了' };
  if (resolved.kind === 'unknown') return { skip: true };

  const info = await fetchVideoInfo(resolved);
  if (!info.ok) return { ok: false, error: info.error, friendly: '视频信息拉不到，可能已删除或需要登录' };

  const pageUrl = info.bvid ? `https://www.bilibili.com/video/${info.bvid}${info.page > 1 ? `?p=${info.page}` : ''}` : link;
  const caption = shareCaption(info, { link: pageUrl });

  const play = await getPlayUrl(info.bvid, info.cid, { qn: Number(cfg().qn) || 16 });
  if (!play.ok) {
    return { ok: true, degraded: true, title: info.title, url: pageUrl,
      text: `${caption}\n（这个视频我拉不到视频流，可能仅限登录/大会员观看）` };
  }

  const maxMB = Math.max(1, Math.min(600, Number(cfg().maxMB) || 100));
  const maxBytes = maxMB * 1024 * 1024;
  if (play.sizeBytes && play.sizeBytes > maxBytes) {
    return { ok: true, degraded: true, title: info.title, url: pageUrl,
      text: `${caption}\n（原视频 ${(play.sizeBytes / 1048576).toFixed(1)}MB，超过我设的 ${maxMB}MB 上限，直接给你链接）` };
  }

  const dir = resolveMediaDir();
  pruneOldFiles(dir);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = safeFileName(info);
  const dest = path.join(dir, fileName);
  const dlOpts = {
    maxBytes, referer: pageUrl,
    timeoutMs: Math.max(15000, Number(cfg().timeoutMs) || 60000),
    log: (m) => log(`${fileName} ${m}`)
  };
  let dl = await downloadVideo(play.urls, dest, dlOpts);
  if (!dl.ok && dl.aborted) {
    const play2 = await getPlayUrl(info.bvid, info.cid, { qn: Number(cfg().qn) || 16 });
    if (play2.ok && Array.isArray(play2.urls) && play2.urls.length) {
      log(`${fileName} 首次下载中断，换 CDN 节点重试（${((play2.sizeBytes || 0) / 1048576).toFixed(1)}MB）`);
      dl = await downloadVideo(play2.urls, dest, dlOpts);
      if (dl.ok && play2.sizeBytes && dl.bytes !== play2.sizeBytes) {
        dl = { ok: false, error: `下载不完整（${dl.bytes}/${play2.sizeBytes} 字节）`, aborted: true };
      }
    }
  }
  if (dl.ok && play.sizeBytes && dl.bytes !== play.sizeBytes) {
    dl = { ok: false, error: `下载不完整（${dl.bytes}/${play.sizeBytes} 字节）`, aborted: true };
  }
  if (!dl.ok) {
    try { if (fs.existsSync(dest)) fs.unlinkSync(dest); } catch { /* ignore */ }
    return { ok: false, error: dl.error, stage: 'download',
      text: `${caption}\n（视频下载到一半断开了，我重连也没成功，链接直接给你）` };
  }
  return {
    ok: true, title: info.title, url: pageUrl, bvid: info.bvid,
    filePath: dest, caption, quality: qualityLabel(play.qn), bytes: dl.bytes
  };
}

/**
 * 发送者白名单：只转发这些 QQ 号贴出来的 B 站链接。
 *
 * allowSenders 支持逗号 / 空格分隔；留空或未配置 = 不限（保持默认行为）。
 * 0.5 的 entry 一定带 senderId，严格判定；0.4 各版本 sender 形态不一，
 * 拿不到 id 时按"不限"放行，避免把 0.4 那台整条链路掐死。
 */
function senderIdOf(payload = {}) {
  const e = payload?.entry || {};
  const s = payload?.sender || {};
  return String(e.senderId ?? e.sender?.id ?? e.sender?.userId
    ?? s.uin ?? s.id ?? s.userId ?? s.qq
    ?? payload?.senderId ?? payload?.userId ?? '').replace(/\D/g, '');
}

function allowedSenders() {
  const list = String(cfg().allowSenders ?? '')
    .split(/[,，\s]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean);
  return list.length ? new Set(list) : null;
}

function senderAllowed(payload = {}, { strict = false } = {}) {
  const allow = allowedSenders();
  if (!allow) return true;                 // 没配置 = 不限
  const id = senderIdOf(payload);
  if (!id) return strict ? false : true;   // 0.5 严格拒绝未知；0.4 保旧行为
  return allow.has(id);
}

/**
 * 0.5 的认领入口。
 * 返回 {status:'skip'} = 不归我管；返回 {segments:[...]} = 认领，由内核发送。
 * 视频必须独占一条消息（协议端会拒 video+text 同条），所以这里先自己发视频，
 * 再把文案作为 segments 交回内核 —— provider 的 await 都在内核发送之前完成，
 * 顺序天然是"视频 → 文案"。
 */
async function claimFor05({ chatKey, text, signal, entry } = {}) {
  if (!senderAllowed({ entry }, { strict: true })) {
    log(`链接来自白名单外的 ${senderIdOf({ entry }) || '未知发送者'}，跳过转发`);
    return { status: 'skip' };
  }
  const body = String(text || '');
  if (!/https?:\/\/(?:www\.)?(?:bilibili\.com|b23\.tv)\//i.test(body)) return { status: 'skip' };
  const url = (body.match(/https?:\/\/(?:www\.)?(?:bilibili\.com|b23\.tv)\/[^\s"'<>]+/i) || [])[0];
  if (!url) return { status: 'skip' };

  return serializeShare(async () => {
    try {
      const prep = await prepareVideo(url);
      if (prep.skip) return { status: 'skip' };
      if (!prep.ok) {
        return { segments: [{ type: 'text', text: prep.text || `${prep.friendly || '这个 B 站视频我没转发成功'} ${url}` }] };
      }
      if (prep.degraded) return { segments: [{ type: 'text', text: prep.text }] };

      const send = typeof apiRef?.send === 'function' ? apiRef.send.bind(apiRef) : null;
      if (!send) {
        warn('0.5 发送通道不可用，降级为只发文案');
        return { segments: [{ type: 'text', text: `${prep.caption}\n（视频没发出去：拿不到 0.5 发送通道）` }] };
      }
      await send(chatKey, [{ type: 'video', file: prep.filePath }], { signal });
      log(`已转发《${prep.title}》（${prep.quality}，${(prep.bytes / 1048576).toFixed(1)}MB）`);
      return { segments: [{ type: 'text', text: `${prep.caption}\n\n（本鲸转发的~ 视频在这↑）` }] };
    } catch (error) {
      const msg = String(error?.message ?? error);
      if (/ECONNRESET|EPIPE|socket hang up|OneBot \S+ 请求失败/i.test(msg)) {
        warn(`发送失败，协议端连接异常（可能 SnowLuma 已崩溃）：${msg}`);
      } else {
        warn(`发送失败：${msg}`);
      }
      // 认领了就得给群友一个交代：视频发不出去至少把链接发出去，不静默失败
      return { segments: [{ type: 'text', text: `这个 B 站视频我没转发成功，链接给你：${url}` }] };
    }
  });
}

// ── 能力提供者 ────────────────────────────────────────────────────────────

export const providers = {
  /**
   * 认领消息里的 B 站链接。
   *
   * 0.4 契约（src/media-links.js）：
   *   {skip:true} 不认领 / {ok:false,friendly} 认领但失败 / {ok:true,…} 成功（自己发）
   * 0.5 契约（bundled/runtime-defaults/business.js + capability.claimAsync）：
   *   {status:'skip'} 不认领 / {segments:[…]} 认领，内核负责发
   * 两套都保留：同一个函数按入参形态分派，0.4 任一侧不用改。
   */
  'media.download': async (payload = {}) => {
    if (payload && payload.chatKey && !payload.url) return claimFor05(payload);

    const { url, sender, onebot, kind, chatId, text } = payload;
    if (!isBiliLink(url)) return { skip: true };   // 不是 B 站 → 让抖音之类的插件去认领
    if (!senderAllowed(payload)) {
      log(`链接来自白名单外的 ${senderIdOf(payload) || '未知发送者'}，跳过转发`);
      return { skip: true };
    }
    const chatKey = `${kind}:${chatId}`;
    // 走全局闸门：多个群同时发链接时排队处理，不让协议端同时接两路上传
    return serializeShare(async () => {
      try {
        return await shareBiliVideo({
          url,
          chatKey,
          sender: sender || null,
          onebot: onebot || null,
          replyToMessageId: replyIdFromText(text)
        });
      } catch (error) {
        // 失败要能看出是"我们这边"还是"协议端"：SnowLuma 崩溃时这里只会收到 ECONNRESET，
        // 以前被上层统一记成"下载失败"，排查时整整跑偏三轮（2026-11-08）。
        const msg = String(error?.message ?? error);
        if (/ECONNRESET|EPIPE|socket hang up|OneBot \S+ 请求失败/i.test(msg)) {
          warn(`发送失败，协议端连接异常（可能 SnowLuma 已崩溃）：${msg}`);
        } else {
          warn(`发送失败：${msg}`);
        }
        return { ok: false, error: msg, stage: 'send', friendly: '这个 B 站视频我没转发成功' };
      }
    });
  }
};

/**
 * 可用性自检。
 *
 * 与抽帧插件同样的坑：SkillManager 的可用性判定是**同步链**，返回 Promise 会被当成
 * truthy（永远"可用"）。本插件没有外部可执行文件依赖，所以这里可以诚实地同步返回
 * —— 只在配置明显非法时报告原因，让界面上的状态和实际行为一致。
 */
export function available() {
  const maxMB = Number(cfg().maxMB);
  if (cfg().maxMB !== undefined && (!Number.isFinite(maxMB) || maxMB <= 0)) {
    return { ok: false, reason: '体积上限（maxMB）配置不是正数，插件不会生效' };
  }
  return { ok: true };
}

/**
 * 提示词片段统一放在 plugin.json 的 prompt.sections（面板可维护、可关）。
 * 这里返回空数组：loader 会同时读 manifest.prompt.sections 和本导出函数，
 * 两处都写同一段会让它在 system 里出现两遍（2026-11-23 去重）。
 */
export function promptSections() {
  return [];
}

/** 排障与测试入口：跑的就是上面那条真实路径。 */
export const internals = {
  shareBiliVideo,
  senderAllowed,
  senderIdOf,
  prepareVideo,
  resolveMediaDir,
  pruneOldFiles,
  replyIdFromText
};
