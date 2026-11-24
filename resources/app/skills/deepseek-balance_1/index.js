// DeepSeek 余额 / 当日用量查询（v1.3.0：3 个工具合并成 1 个）
//
// ── 为什么合并 ─────────────────────────────────────────────────────────────
// v1.2.0 注册了 3 个工具：
//   deepseek_balance_query（模型自调）
//   deepseek_balance_admin（口令「查余额」，与 query 完全重复，真实调用 0 次）
//   deepseek_usage_admin  （口令「当日用量」）
// 另外还声明了一段约 370 字的 prompt 段，每轮都进系统提示词。
// 三者合计每轮白烧约 770 字符。v1.3.0 的做法：
//   ① 只留 1 个工具，意图由**触发消息原文**判断（"用量/花费/token…"→用量，否则余额）；
//   ② 两种模式都查完直接发到会话，工具返回"已发送"→ 模型不必再发一遍（省一轮）；
//   ③ 删掉 prompt 段，规则全部压进工具描述（描述本来就随 tools 一起给模型）。
//
// ── Key 来源 ─────────────────────────────────────────────────────────────
// 插件设置 apiKey 留空时，自动读核心 data/config.json 的 api.apiKey。
//
// ── 缓存 ─────────────────────────────────────────────────────────────────
// 余额 10 分钟缓存（refreshMs 可调）；用量每次现查（核心接口本身有按日快照）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBalanceClient } from './balance-api.js';

const TOOL_MAIN = 'deepseek_balance_query';

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// 数据根探测：0.4 的装在 <根>\resources\app\skills\<名>（向上 4 级才到安装根，数据在 <根>\data）；
// 0.5 挪到 <根>\extensions\skills\<名>（只 3 级，硬写 4 级会落到上一层的 E:\DevTools），数据也改名 data-v05。
// 所以别数层数，直接从插件目录往上找带 data\config.json 或 data-v05\config.json 的那一级。
const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

function locateDataDir(startDir) {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    for (const name of ['data', 'data-v05']) {
      const probe = path.join(dir, name, 'config.json');
      try {
        if (fs.existsSync(probe)) return { appRoot: dir, dataDir: path.join(dir, name) };
      } catch { /* 探测失败就继续往上找 */ }
    }
  }
  return null;
}

const LOCATED = locateDataDir(PLUGIN_DIR);
const APP_ROOT = LOCATED ? LOCATED.appRoot : path.resolve(PLUGIN_DIR, '..', '..', '..', '..');
const DATA_DIR = LOCATED ? LOCATED.dataDir : path.join(APP_ROOT, 'data');
const CORE_CONFIG_PATH = path.join(DATA_DIR, 'config.json');

// 判意图：命中用量词就报用量，否则报余额。
// 「话费」「余额」「还剩多少钱」不含"花费/费用"，不会被误判。
const USAGE_INTENT = /(用量|花了多少|花了多少钱|花费|费用|消耗|token|调用次数|调用量|缓存命中|用量统计)/i;

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = api?.log || log;
  warn = api?.warn || warn;

  api.registerTool({
    id: TOOL_MAIN,
    name: 'DeepSeek余额/用量',
    description: '查 DeepSeek 余额（人民币，充值+赠送）或当日用量（花费、token、次数、缓存命中）。'
      + '只要有人问「余额 / 话费 / 余额 / 还剩多少钱 / 用量 / 今天花了多少 / 用了多少 token」，就直接调用本工具。'
      + '**不要自己判断对方是不是主人**——你只看到群名片，看不到 QQ 号，判不了；工具内部会按 QQ 号判定并直接把结果发到当前会话。'
      + '调用后：成功就已经发出去了，你只需一句话带过，别重发、别改数字；若被拒，按工具返回的原话回，别自己另编理由。',
    category: 'utility',
    icon: '💰',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      if (!(await isOwnerCtxLive(ctx))) {
        return { content: '余额和用量是主人的私人数据，不能公开。请说明：只有主人 QQ 1000000000 本人能查，当前没能把你的发言号对上主人。被问到时照这句话讲，不要编造数字。' };
      }
      const wantsUsage = USAGE_INTENT.test(await triggerTextLive(ctx));
      try {
        let text;
        let lowHit = null;
        if (wantsUsage) {
          text = fmtUsage(await getTodayUsage());
        } else {
          const client = clientOf();
          const info = await client.getBalance(false);
          text = client.format(info);
          lowHit = lowBalanceHit(info);
          if (lowHit) text += `\n${lowHit.line}`;
        }
        await say(ctx, text);
        // 乞讨只在"有人主动查余额"这一刻判定一次，不设巡查、不跑钩子。
        if (lowHit && beggarAllowed()) {
          markBeggarAt();
          return {
            content: `${text}\n（余额已直接发出。低于设定线，用你的人设卖惨讨一句：${beggarTone()}。`
              + `一句话、二十字内，别报数字、别重复上面那条，换个说法，说完结束。）`,
            _cardSent: true
          };
        }
        return { content: `${text}\n（工具已把结果直接发到当前会话。你这一轮不要再调用 send_message，直接结束回合，避免重复刷屏。）`, _cardSent: true };
      } catch (error) {
        const msg = `${wantsUsage ? '用量' : '余额'}查询失败：${error?.message ?? error}`;
        warn(msg);
        const text = wantsUsage ? await fallbackUsageText(error) : msg;
        try { await say(ctx, text); } catch { /* 发送失败也要把内容还给模型 */ }
        return { content: text, _cardSent: true };
      }
    }
  });

  log(`已加载：单工具 ${TOOL_MAIN}（余额 / 当日用量按触发文本自动分流，查完直接发送）`);
}

// ── 主人判定 ─────────────────────────────────────────────────────────────
// 本机这版核心既没有 commandRoute，也没有 owner-identity 能力，只能按 QQ 号硬判：
//   私聊 → chatKey 形如 private:<QQ>，直接比 QQ；
//   群聊 → 看本次触发消息里**最后一条**的 senderId（连发合并时最后一条就是发问者）。
// 拿不到发送者时一律按"非主人"，宁可拒也不误报。

function ownerQQ() {
  const settings = cfg() || {};
  const raw = String(settings.ownerQQ || '').trim();
  return raw || '1000000000';
}

/**
 * 群里"谁在叫机器人"：优先取**最后一条 atMe 的发言者**，其次才退回最后一条有 senderId 的。
 * 不能只取最后一条：连发聚合窗口里，主人问完话后同批还会混进别人的消息
 * （2026-11-12 现场：主人 @ 完「今日用量」，隔壁机器人紧接着发了张图，
 *   最后一条的发送者是旁人，主人反被判成非主人）。
 */
function triggerSenderId(ctx) {
  // 0.5 的工具上下文可能把触发消息挂在 ctx.trigger 上，没有就退回 ctx.session.trigger
  const trig = ctx?.session?.trigger ?? ctx?.trigger;
  if (!Array.isArray(trig) || !trig.length) return '';
  for (let i = trig.length - 1; i >= 0; i--) {
    const e = trig[i];
    if (e?.self) continue;
    if (e?.atMe === true) {
      const id = String(e?.senderId ?? e?.userId ?? '').trim();
      if (id) return id;
    }
  }
  for (let i = trig.length - 1; i >= 0; i--) {
    const e = trig[i];
    if (e?.self) continue;
    const id = String(e?.senderId ?? e?.userId ?? '').trim();
    if (id) return id;
  }
  return '';
}

/** 本次触发的全部消息原文，用于判断"问余额"还是"问用量"。 */
function triggerText(ctx) {
  const trig = ctx?.session?.trigger ?? ctx?.trigger;
  if (typeof trig === 'string') return trig.trim().slice(0, 400);
  if (!Array.isArray(trig) || !trig.length) return '';
  return trig.map((e) => String(e?.text ?? '')).join(' ').slice(0, 400);
}

/**
 * 工具执行期拿「本次问的是哪句话」。
 * 0.5 的 session.trigger 是摘要字符串（"某某：@机器人 今日用量"），里面有原文可直接用；
 * 万一连摘要都没有，就退回最近一条非自己消息的原文。
 */
async function triggerTextLive(ctx) {
  const direct = triggerText(ctx);
  if (direct) return direct;
  try {
    const raw = ctx?.store?.recent?.(ctx?.chatKey, 6);
    const list = raw && typeof raw.then === 'function' ? await raw : raw;
    if (!Array.isArray(list)) return '';
    const mine = list.filter((e) => e?.self !== true && String(e?.senderId ?? '') !== 'self');
    return mine.length ? String(mine[mine.length - 1]?.text ?? '').slice(0, 400) : '';
  } catch {
    return '';
  }
}

export function isOwnerCtx(ctx) {
  const owner = ownerQQ();
  if (!owner) return false;
  const chatKey = String(ctx?.chatKey || '').trim();
  // 0.5 有些适配路径会把私聊写成 friend:<QQ>
  if (/^(private|friend)[:_]/.test(chatKey)) {
    return chatKey.split(/[:_]/).pop().trim() === owner;
  }
  return triggerSenderId(ctx) === owner;
}

/**
 * 工具执行期的判定（异步）。
 * 0.5 的 ctx.session.trigger 已经退化成一句字符串摘要（"某某：@机器人 …"），
 * 里面没有 senderId/atMe —— 上面那套按 trigger 数组判主的逻辑在新版一定返回 false，
 * 主人问余额会被当成群友直接拒掉。所以拿不到 trigger 数组时，改从最近消息里认人：
 * 优先「最近一条 atMe 且非自己」的发送者，没有再退回最近一条非自己消息。
 * 需要 data.sessions.read 权限（data.messages.recent 走的就是这个 scope）。
 */
async function isOwnerCtxLive(ctx) {
  const owner = ownerQQ();
  if (!owner) return false;
  if (isOwnerCtx(ctx)) return true;
  const chatKey = String(ctx?.chatKey || '').trim();
  if (!/^group[:]/.test(chatKey)) return false;
  try {
    const raw = ctx?.store?.recent?.(chatKey, 20);
    const list = raw && typeof raw.then === 'function' ? await raw : raw;
    if (!Array.isArray(list)) return false;
    // ① 最准：0.5 会话带 triggerEntryIds = 本轮触发消息的存档 id，直接定位发言者
    const idsRaw = ctx?.session?.triggerEntryIds;
    const ids = Array.isArray(idsRaw) ? idsRaw : idsRaw == null ? [] : [idsRaw];
    const idSet = new Set(ids.map((v) => String(v)));
    if (idSet.size) {
      let hit = '';
      for (const e of list) {
        if (!idSet.has(String(e?.id))) continue;
        const sid = String(e?.senderId ?? '').trim();
        if (sid && sid !== 'self' && e?.self !== true) hit = sid;
      }
      if (hit) return hit === owner;
    }
    // ② 退回：最近一条 atMe 且非自己，再退最近一条非自己
    let lastAtMe = '';
    let lastOther = '';
    for (const e of list) {
      const sid = String(e?.senderId ?? '').trim();
      if (!sid || sid === 'self' || e?.self === true) continue;
      lastOther = sid;
      if (e?.atMe === true) lastAtMe = sid;
    }
    return (lastAtMe || lastOther) === owner;
  } catch {
    return false;
  }
}

// ── 核心配置读取 ─────────────────────────────────────────────────────────

function readCoreConfig() {
  try {
    return JSON.parse(fs.readFileSync(CORE_CONFIG_PATH, 'utf8'));
  } catch (error) {
    warn(`读取核心配置失败：${error?.message ?? error}`);
    return {};
  }
}

// ── 客户端构建：Key 优先取插件设置，空则读核心 config.json ────────────────

function clientOf() {
  const settings = cfg() || {};
  let key = String(settings.apiKey || '').trim();
  if (!key) {
    const core = readCoreConfig();
    key = String(core?.api?.apiKey || '').trim();
  }
  return createBalanceClient({
    apiKey: key,
    baseUrl: String(settings.baseUrl || ''),
    ttlMs: Number(settings.refreshMs) || undefined,
  });
}

// ── 当日用量：核心本机统计接口（与控制台面板同源） ─────────────────────────

export async function getTodayUsage() {
  const core = readCoreConfig();
  const port = Number(core?.server?.port) || 3210;
  const token = String(core?.server?.token || '').trim();
  const query = token ? `?range=today&token=${encodeURIComponent(token)}` : '?range=today';
  const url = `http://127.0.0.1:${port}/api/usage/stats${query}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok) throw new Error(String(data?.error || '接口返回异常'));
  return data;
}

function fmtWan(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(Math.round(v));
}

function chatLabel(key) {
  const s = String(key || '');
  if (s.startsWith('group:')) return `群 ${s.slice(6)}`;
  if (s.startsWith('private:') || s.startsWith('friend:')) return `私聊 ${s.split(/[:_]/).pop()}`;
  return s || '未知会话';
}

/** 0.5 的用量接口给的是 chatKey + chatName，0.4 只有 key，两个都认。 */
function chatLabelOf(c) {
  const name = String(c?.chatName || c?.name || '').trim();
  if (name) return name;
  return chatLabel(c?.key || c?.chatKey);
}

function pad2(n) { return String(n).padStart(2, '0'); }

function todayKeyOf(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtUsage(data) {
  const t = data?.totals || {};
  const day = String(data?.days?.[0]?.day || todayKeyOf());
  const lines = [`今日用量（${day}）：`];

  const cost = Number(t.cost) || 0;
  const peak = Number(t.peakCost) || 0;
  const off = Number(t.offPeakCost) || 0;
  let money = `花费 ¥${cost.toFixed(2)}`;
  if (t.hasPeakModel && peak > 0) money += `（高峰 ¥${peak.toFixed(2)} / 闲时 ¥${off.toFixed(2)}）`;
  lines.push(money);

  const hit = Number(t.cacheHitRate) || 0;
  lines.push(`Token 输入 ${fmtWan(t.promptTokens)} / 输出 ${fmtWan(t.completionTokens)} · 缓存命中 ${(hit * 100).toFixed(0)}%`);
  lines.push(`调用 ${Math.round(Number(t.runs) || 0)} 次 · 联网搜索 ${Math.round(Number(data.searchCount) || 0)} 次`);

  const chats = (Array.isArray(data.chats) ? data.chats : [])
    .filter((c) => (Number(c?.cost) || 0) > 0)
    .slice(0, 3);
  if (chats.length) {
    lines.push('花费分布：' + chats.map((c) => `${chatLabelOf(c)} ¥${(Number(c.cost) || 0).toFixed(2)}`).join(' · '));
  }
  return lines.join('\n');
}

/** 接口不可达时的兜底：读核心实时用量文件（只有 token 数，没有费用）。 */
async function fallbackUsageText(error) {
  const head = `用量接口不可达（${error?.message ?? error}），改用本地用量文件，费用暂不可用。`;
  try {
    const raw = fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8');
    const d = JSON.parse(raw);
    const hit = d.promptTokens ? (Number(d.cachedTokens) || 0) / Number(d.promptTokens) : 0;
    return `${head}\n今日（${d.dayKey}）Token 输入 ${fmtWan(d.promptTokens)} / 输出 ${fmtWan(d.completionTokens)}`
      + ` · 缓存命中 ${(hit * 100).toFixed(0)}% · 调用 ${Math.round(Number(d.runs) || 0)} 次`
      + ` · 联网搜索 ${Math.round(Number(d.webSearchCount) || 0)} 次`;
  } catch (e2) {
    return `${head}\n本地用量文件也读不到：${e2?.message || e2}`;
  }
}

/**
 * 低余额判定（从 api-beggar 并过来的那部分）。
 * settings.lowThreshold <= 0 时完全不提醒，行为与合并前一致；
 * 数字读不到就静默，不猜。
 */
function lowBalanceHit(info) {
  const thr = Number((cfg() || {}).lowThreshold);
  if (!(thr > 0)) return null;
  const infos = Array.isArray(info?.balance_infos) ? info.balance_infos : [];
  const hit = infos.filter((b) => {
    const v = Number(b?.total_balance);
    return Number.isFinite(v) && v <= thr;
  });
  if (!hit.length) return null;
  const who = hit.map((b) => `${String(b?.currency ?? 'CNY')} ${b.total_balance}`).join('、');
  return { who, thr, line: `余额只剩 ${who}，低于设定线 ${thr}，该充点了。` };
}

// ── 乞讨冷却 ───────────────────────────────────────────────────────────────
// 只防「主人连问三次余额 → 乞讨三次」，不改变判定逻辑，也没有任何巡查。
// 状态落盘在 DATA_DIR（skills/ 之外）：写技能目录会触发 fs.watch 自激重载。
const DEFAULT_BEGGAR_TONE = '低声下气卖惨，委屈发软，别硬气别说教';

/** 乞讨语气：settings.beggarTone 优先，空则用默认的可怜调子。 */
function beggarTone() {
  const raw = String((cfg() || {}).beggarTone || '').trim();
  return raw || DEFAULT_BEGGAR_TONE;
}

function beggarStatePath() { return path.join(DATA_DIR, 'deepseek-balance-beggar.json'); }
function readBeggarAt() {
  try { return Number(JSON.parse(fs.readFileSync(beggarStatePath(), 'utf8'))?.at) || 0; } catch { return 0; }
}
function markBeggarAt() {
  try { fs.writeFileSync(beggarStatePath(), JSON.stringify({ at: Date.now() }), 'utf8'); } catch { /* 写不了就退化成不冷却 */ }
}
function beggarCoolMs() {
  const min = Number((cfg() || {}).beggarCooldownMin);
  return (Number.isFinite(min) && min > 0 ? min : 120) * 60000;
}
/** 距上次乞讨是否已过冷却；从没乞讨过就是允许。 */
function beggarAllowed() {
  return Date.now() - readBeggarAt() >= beggarCoolMs();
}

async function say(ctx, text) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  const chatKey = ctx?.chatKey;
  let result = null;
  if (typeof ctx?.send?.sendTextBatch === 'function') {
    // 0.5：ctx.send 是 core.send 能力对象 { sendTextBatch(chatKey, texts, opts) }
    result = await ctx.send.sendTextBatch(chatKey, [body], {});
  } else if (typeof ctx?.sender?.sendTextBatch === 'function') {
    // 0.4：sender 单例
    result = await ctx.sender.sendTextBatch(chatKey, [body], {});
  } else if (typeof ctx?.send === 'function') {
    // 兜底：某些核心把 ctx.send 直接做成发送函数
    result = await ctx.send(chatKey, [{ type: 'text', text: body }], {});
  } else {
    throw new Error('当前核心没有可用的发送接口（没有 ctx.send.sendTextBatch / ctx.sender.sendTextBatch）');
  }
  if (result && Array.isArray(result.failed) && result.failed.length) {
    throw new Error(`消息发送失败：${result.failed[0]?.error || result.failed[0]?.message || '未知原因'}`);
  }
  try {
    ctx.session?.sent?.push({
      type: 'text',
      text: body,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
    ctx.emit?.('session-update', ctx.session?.id);
  } catch { /* 上报失败不影响已发出的消息 */ }
  return true;
}
