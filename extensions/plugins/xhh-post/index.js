// 小黑盒帖子转发（plugins/xhh-post）
// ─────────────────────────────────────────────────────────────
// 群里有人贴小黑盒帖子链接 → 打开链接抓正文与评论 → 转发封面图
// → 生成内容总结（太长就压缩）→ 提炼评论区在聊什么 → 发回群。
//
// 数据来源（实测 2026-11-20，无需登录态）：
//   GET /bbs/app/link/tree/v2?link_id=<hash>   → result.link.body.text（block JSON 正文）
//   GET /bbs/app/link/tree?link_id=<hash>      → result.comments（评论树）
// 每个请求都要 hkey 签名（hkey + _time + nonce），算法移植自市场技能 xiaoheihe v1.1.0。
//
// 安全线：
//   · allowSenders 白名单，默认只认主人自己的 QQ 号
//   · 同一条链接 10 分钟内只转一次
//   · 抓取限速 1.5s/次，撞验证码冷却 3 分钟，失败只回一句带链接的提示，不刷屏
//   · 总结只发"归纳"，不假装看过视频画面

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, createHmac, randomBytes } from 'node:crypto';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));

// 真机上插件会被复制到 data*\extension-cache\<hash>\ 里运行，按固定层级推安装根会指到缓存目录，
// 所以向上逐层找：哪一层目录里能读到 data*/config.json（且含 api 段），那一层就是安装根
function detectInstallRoot(from) {
  let dir = path.resolve(from);
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (!parent || parent === dir) break;
    dir = parent;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!/^data/i.test(name)) continue;
      try {
        const raw = fs.readFileSync(path.join(dir, name, 'config.json'), 'utf8');
        if (raw.includes('"api"')) return dir;
      } catch { /* 这个 data 目录没有可读的 config，继续找 */ }
    }
  }
  return path.resolve(from);
}
const INSTALL_ROOT = detectInstallRoot(PLUGIN_DIR);

let apiRef = null;
let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ── 日志落盘（插件 api.log 不进主日志，必须自己写）──────────────────
function dataDir() {
  try {
    for (const name of fs.readdirSync(INSTALL_ROOT)) {
      if (!/^data/i.test(name)) continue;
      const d = path.join(INSTALL_ROOT, name);
      try {
        fs.readFileSync(path.join(d, 'config.json'), 'utf8');
        return d;
      } catch { /* 继续 */ }
    }
  } catch { /* ignore */ }
  return INSTALL_ROOT;
}
function logDir() {
  try {
    const names = fs.readdirSync(INSTALL_ROOT);
    for (const name of names) {
      if (!/^data/i.test(name)) continue;
      const probe = path.join(INSTALL_ROOT, name, 'config.json');
      try {
        fs.readFileSync(probe, 'utf8');
        return path.join(INSTALL_ROOT, name, 'logs');
      } catch { /* 继续 */ }
    }
  } catch { /* ignore */ }
  return path.join(INSTALL_ROOT, 'logs');
}
function writeFileLog(level, msg) {
  try {
    const d = logDir();
    fs.mkdirSync(d, { recursive: true });
    const now = new Date();
    const p = (n) => String(n).padStart(2, '0');
    const day = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
    const ts = `${day} ${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
    fs.appendFileSync(path.join(d, `xhh-post-${day}.log`), `[${ts}] [${level}] ${msg}\n`, 'utf8');
  } catch { /* ignore */ }
}

// ── 配置 ────────────────────────────────────────────────────────────────
function settings() {
  const c = cfg() || {};
  const num = (v, d, min, max) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) return d;
    return max && n > max ? max : n;
  };
  return {
    allowSenders: String(c.allowSenders ?? '').trim(),
    commentCount: num(c.commentCount, 8, 1, 20),
    summaryChars: num(c.summaryChars, 220, 60, 600),
    maxTextChars: num(c.maxTextChars, 800, 100, 3000),
    sendImages: c.sendImages === true,
    useModel: c.useModel !== false,
    cookie: String(c.cookie ?? '').trim(),
    timeoutMs: num(c.timeoutMs, 20000, 5000, 60000),
    modelMaxTokens: num(c.modelMaxTokens, 900, 200, 2000),
    maxImages: num(c.maxImages, 3, 1, 9),
    visionChars: num(c.visionChars, 220, 60, 500)
  };
}

// ── 签名（小黑盒要求的 hkey / _rnd）───────────────────────────────────
const ALPHABET = 'AB45STUVWZEFGJ6CH01D237IXYPQRKLMN89';
const SALT = 'Z7mFG4tQp9Ws2LxB8H';
const md5 = (s) => createHash('md5').update(s).digest('hex');
const _double = (v) => ((v << 1) ^ (v & 128 ? 27 : 0)) & 255;
const _three = (v) => _double(v) ^ v;
const _nine = (v) => _three(_double(v));
const _eleven = (v) => _nine(_three(_double(v)));
const _thirteen = (v) => _eleven(v) ^ _nine(v) ^ _three(v);
const mapChars = (value, alphabet) => [...String(value)].map((c) => alphabet[c.charCodeAt(0) % alphabet.length]).join('');

function sign(pathname, timestamp, nonce) {
  const norm = '/' + pathname.split('/').filter(Boolean).join('/') + '/';
  const parts = [
    mapChars(String(timestamp + 1), ALPHABET.slice(0, -2)),
    mapChars(norm, ALPHABET),
    mapChars(nonce, ALPHABET)
  ];
  const maxLen = Math.max(...parts.map((p) => p.length));
  let seed = '';
  for (let i = 0; i < maxLen; i++) seed += (parts[0][i] || '') + (parts[1][i] || '') + (parts[2][i] || '');
  seed = seed.slice(0, 20);
  const digest = md5(seed);
  const L = digest.length;
  const a = digest.charCodeAt(L - 6);
  const b = digest.charCodeAt(L - 5);
  const c = digest.charCodeAt(L - 4);
  const d = digest.charCodeAt(L - 3);
  const mixed = [
    _thirteen(a) ^ _eleven(b) ^ _nine(c) ^ _three(d),
    _three(a) ^ _thirteen(b) ^ _eleven(c) ^ _nine(d),
    _nine(a) ^ _three(b) ^ _thirteen(c) ^ _eleven(d),
    _eleven(a) ^ _nine(b) ^ _three(c) ^ _thirteen(d)
  ];
  const checksum = (mixed[0] + mixed[1] + mixed[2] + mixed[3] + digest.charCodeAt(L - 2) + digest.charCodeAt(L - 1)) % 100;
  return mapChars(digest.slice(0, 5), ALPHABET.slice(0, -4)) + String(checksum).padStart(2, '0');
}

function signedParams(pathname) {
  const _time = Math.floor(Date.now() / 1000);
  const nonce = md5(`${_time}${randomBytes(16).toString('hex')}`).toUpperCase();
  return { hkey: sign(pathname, _time, nonce), _time, nonce };
}

function workshopRnd(nonce, _time) {
  return '15:' + createHmac('sha256', SALT).update(`${SALT}${nonce}${_time}:${nonce}`).digest('hex');
}

// ── 限速 ────────────────────────────────────────────────────────────────
let lastCallAt = 0;
let coolUntil = 0;
const MIN_GAP_MS = 2500;
const CAPTCHA_COOL_MS = 30 * 60 * 1000;

// 风控冷却要跨进程生效：否则一重启(或每次离线测试)就从头撞墙
const STATE_FILE = path.join(dataDir(), 'xhh-post-state.json');
function loadCoolUntil() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    const t = Number(j?.captchaUntil) || 0;
    if (t > Date.now()) coolUntil = t;
    return t;
  } catch { return 0; }
}
function saveCoolUntil(t) {
  try { fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true }); fs.writeFileSync(STATE_FILE, JSON.stringify({ captchaUntil: t, at: new Date().toISOString() }, null, 2), 'utf8'); } catch { /* ignore */ }
}
loadCoolUntil();

async function throttle() {
  if (Date.now() < coolUntil) {
    const left = coolUntil - Date.now();
    // 冷却期不干等：短就等，长就直接跳过，别把消息拖死
    if (left > 15000) {
      const err = new Error(`小黑盒风控冷却中，还有 ${Math.round(left / 60000)} 分钟`);
      err.code = 'COOLDOWN';
      throw err;
    }
    warn(`小黑盒风控冷却中，等待 ${Math.round(left / 1000)}s`);
    await new Promise((r) => setTimeout(r, left + 500));
  }
  const gap = Date.now() - lastCallAt;
  if (gap < MIN_GAP_MS) await new Promise((r) => setTimeout(r, MIN_GAP_MS - gap));
  lastCallAt = Date.now();
}

function netFetch(url, init) {
  const f = apiRef?.http?.fetch;
  if (typeof f === 'function') return f(url, init);
  return fetch(url, init);
}

async function xhhGet(pathname, params = {}, { signal } = {}) {
  await throttle();
  const s = settings();
  const signed = signedParams(pathname);
  const query = {
    os_type: 'web', app: 'heybox', x_client_type: 'web', x_os_type: 'Mac',
    x_app: 'heybox', x_client_version: '999.999.999', version: '999.0.4',
    ...params, hkey: signed.hkey, _time: signed._time, nonce: signed.nonce
  };
  const url = `https://api.xiaoheihe.cn${pathname}?${new URLSearchParams(query).toString()}`;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
    Origin: 'https://www.xiaoheihe.cn',
    Referer: 'https://www.xiaoheihe.cn/',
    Accept: 'application/json'
  };
  if (s.cookie) headers.Cookie = s.cookie;

  const res = await netFetch(url, { headers, signal });
  const text = await res.text().catch(() => '');
  let json = null;
  try { json = JSON.parse(text); } catch { /* ignore */ }
  const status = json?.status ?? '';
  if (status === 'show_captcha') {
    coolUntil = Date.now() + CAPTCHA_COOL_MS;
    saveCoolUntil(coolUntil);
    const err = new Error('小黑盒要求验证码（请求太频繁）');
    err.code = 'CAPTCHA';
    throw err;
  }
  if (status === 'login') {
    const err = new Error('小黑盒要求登录态');
    err.code = 'LOGIN';
    throw err;
  }
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}`);
    err.code = 'HTTP';
    throw err;
  }
  return { json, status, text };
}

// ── 链接解析 ────────────────────────────────────────────────────────────
const XHH_URL_RE = /https?:\/\/(?:[\w-]+\.)*xiaoheihe\.cn\/[^\s"'<>]*/gi;

/** 小黑盒帖子 id 只有两种形态：hash（10~16 位 hex）和纯数字 linkid。 */
function isRealLinkId(id) {
  return /^[0-9a-f]{10,16}$/i.test(id) || /^\d{6,}$/.test(id);
}

function parseLinkId(raw) {
  const s = String(raw || '').trim();
  const m =
    s.match(/\/app\/bbs\/link\/([0-9a-z]+)/i) ||
    s.match(/[?&]link_id=([0-9a-z]+)/i) ||
    s.match(/\/link\/([0-9a-z]+)/i);
  if (!m) return '';
  return isRealLinkId(m[1]) ? m[1] : '';
}

/** 从一段消息里抽出所有小黑盒帖子链接（正确处理 QQ 卡片的 [] 包裹）。 */
function extractPosts(text) {
  const body = String(text || '');
  const out = [];
  for (const raw of body.match(XHH_URL_RE) || []) {
    const url = raw.replace(/[\]\[)(）】，。、！？]+$/g, '');
    const id = parseLinkId(url);
    if (!id) continue;
    const canon = `https://www.xiaoheihe.cn/app/bbs/link/${id}`;
    if (!out.some((x) => x.id === id)) out.push({ id, url: canon });
  }
  return out;
}

// ── 抓取 ────────────────────────────────────────────────────────────────
function stripHtml(html) {
  return String(html || '')
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\[cube_[^\]]+\]/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseBlocks(text) {
  if (!text) return [];
  try {
    const arr = JSON.parse(text);
    if (!Array.isArray(arr)) return [];
    return arr.map((b) => ({
      type: String(b.type || 'text'),
      text: String(b.text || ''),
      url: String(b.url || b.img?.url || b.image?.url || ''),
      live_url: String(b.live_url || b.video?.url || ''),
      width: b.width ? Number(b.width) : null,
      height: b.height ? Number(b.height) : null
    }));
  } catch {
    return [{ type: 'text', text: String(text), width: null, height: null }];
  }
}

async function fetchPost(id, { signal } = {}) {
  const r = await xhhGet('/bbs/app/link/tree/v2', {
    link_id: id, page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit: 3
  }, { signal });
  const link = r.json?.result?.link;
  if (!link) throw new Error('接口没返回帖子内容（可能已删除）');
  const body = link.body || {};
  const blocks = parseBlocks(body.text);
  const share = link.share_info || {};
  const sd = share.share_data || {};
  const textParts = blocks.filter((b) => b.type === 'text').map((b) => stripHtml(b.text)).filter(Boolean);
  const text = textParts.join('\n').trim();
  const imgs = blocks
    .filter((b) => b.type === 'img' && b.url)
    .map((b) => String(b.url).replace(/%3E$/i, '').trim())
    .filter(Boolean);
  return {
    id,
    numericId: String(body.link_id || ''),
    title: String(body.title || sd.share_title || '').trim(),
    author: (body.user || {}).username || (body.user || {}).nickname || '',
    linkStyle: body.link_style ?? null,
    text,
    textLen: text.length,
    blocks,
    images: imgs,
    imageCount: imgs.length,
    liveVideos: blocks.filter((b) => b.live_url).map((b) => String(b.live_url)).slice(0, 2),
    cover: String(sd.share_img || '').trim(),
    shareUrl: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
    commentNum: link.stats?.comment_num ?? 0,
    favourCount: link.stats?.favour_count ?? 0,
    topics: (body.bbs_topics || body.topics || []).map((t) => t.name || t.topic_name).filter(Boolean),
    desc: stripHtml(sd.share_desc || '')
  };
}

// 兜底：接口被风控时，从网页版的 meta 拿标题 / 摘要 / 封面（www 域名不吃接口那套风控）
function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
}

async function fetchPostHtml(id, { signal } = {}) {
  const url = `https://www.xiaoheihe.cn/app/bbs/link/${id}`;
  const res = await netFetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml'
    },
    signal
  });
  const html = await res.text().catch(() => '');
  const pick = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1]).trim() : '';
  };
  const title = pick(/<meta[property="og:title"]\s+content="([^"]*)"/i)
    || pick(/<title>([^<]*)<\/title>/i);
  const desc = pick(/<meta\s+name="description"\s+content="([^"]*)"/i)
    || pick(/<meta\s+content="([^"]*)"\s+name="description"/i);
  const cover = pick(/<meta[property="og:image"]\s+content="([^"]*)"/i)
    || (html.match(/https?:\/\/[^"'\s\\]*imgheybox[^"'\s\\]*/) || [''])[0].split('?')[0];
  if (!title && !desc) throw new Error('网页版也没取到内容');
  const text = desc.replace(/\s+/g, ' ').trim();
  return {
    id,
    numericId: '',
    title: title.replace(/\s*[-|]\s*小黑盒.*$/, '').trim(),
    author: '',
    linkStyle: null,
    text,
    textLen: text.length,
    blocks: [],
    cover,
    shareUrl: url,
    commentNum: 0,
    favourCount: 0,
    topics: [],
    desc: text,
    degraded: true
  };
}

async function fetchComments(id, { limit = 8, signal } = {}) {
  const r = await xhhGet('/bbs/app/link/tree', {
    link_id: id, page: 1, is_first: 1, index: 1, owner_only: 0, offset: 0, limit, sort_filter: 'oldest'
  }, { signal });
  const groups = r.json?.result?.comments || [];
  const out = [];
  for (const g of groups) {
    for (const c of g.comment || []) {
      const u = c.user || {};
      const text = stripHtml(c.text || '');
      if (!text) continue;
      out.push({
        user: u.username || u.nickname || `用户${c.userid}`,
        text,
        isOwner: Boolean(c.is_link_owner)
      });
      if (out.length >= limit) break;
    }
    if (out.length >= limit) break;
  }
  return out;
}

// ── 模型调用（读应用自身的 api 配置，避免依赖插件拿不到的 llm 能力）────
let apiCfgCache = null;
function readApiConfig() {
  if (apiCfgCache) return apiCfgCache;
  const scanned = [];
  try {
    for (const name of fs.readdirSync(INSTALL_ROOT)) {
      if (!/^data/i.test(name)) continue;
      const f = path.join(INSTALL_ROOT, name, 'config.json');
      let raw = '';
      try {
        raw = fs.readFileSync(f, 'utf8');
      } catch (e) {
        scanned.push(`${name}:读不到(${e?.code || e?.message})`);
        continue;
      }
      let cfgJson;
      try {
        cfgJson = JSON.parse(raw);
      } catch {
        scanned.push(`${name}:JSON坏`);
        continue;
      }
      const a = cfgJson?.api || {};
      if (a.baseUrl && a.apiKey) {
        apiCfgCache = {
          baseUrl: String(a.baseUrl).replace(/\/+$/, ''),
          apiKey: String(a.apiKey),
          model: String(a.model || ''),
          visionModel: String(a.visionModel || a.model || ''),
          visionEnabled: a.vision === true,
          temperature: Number(a.temperature) || 0.5,
          timeoutMs: Number(a.timeoutMs) || 120000
        };
        return apiCfgCache;
      }
      scanned.push(`${name}:没有 baseUrl/apiKey`);
    }
  } catch (e) {
    warn(`读模型配置失败：${e?.message ?? e}`);
  }
  warn(`[调试] 模型配置没找到，扫描结果：${scanned.join(' | ') || '(一个 data 目录都没看到)'}；INSTALL_ROOT=${INSTALL_ROOT}`);
  return null;
}

async function chatJson(messages, { maxTokens = 900, temperature = 0.5, signal, model, thinking } = {}) {
  const a = readApiConfig();
  if (!a) throw new Error('没找到模型配置');
  const res = await netFetch(`${a.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${a.apiKey}`
    },
    body: JSON.stringify({
      model: model || a.model,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: false,
      ...(thinking ? { thinking } : {})
    }),
    signal: signal ?? AbortSignal.timeout(Math.min(a.timeoutMs, 90000))
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`模型 HTTP ${res.status} ${t.slice(0, 120)}`);
  }
  const j = await res.json();
  const content = j?.choices?.[0]?.message?.content ?? '';
  return String(content);
}

function cleanJson(text) {
  const s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fence ? fence[1] : s;
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
}

/** 规则兜底：没有模型时也要给出能看的东西。 */
function ruleSummary(post, { maxChars }) {
  const src = post.text || post.desc || '';
  if (!src) return post.linkStyle === 101 ? '这条是短视频/动态帖，没有文字正文，看图就行。' : '';
  const clean = src.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxChars) return clean;
  // 按句子切，尽量取到 maxChars
  const parts = clean.split(/(?<=[。！？!?；;])\s*/);
  let out = '';
  for (const p of parts) {
    if ((out + p).length > maxChars) break;
    out += p;
  }
  return (out || clean.slice(0, maxChars)).trim() + '…';
}

// 帖子"实际可读的内容"：正文优先；没有正文时 desc 只有不是推广语才算数
const AD_DESC_RE = /^(?:下载小黑盒|打开小黑盒|立即下载|安装小黑盒|小黑盒[^。]{0,8}(?:查看|了解)更多)/;
function bodyOf(post) {
  const text = String(post.text || '').trim();
  if (text) return text;
  const desc = String(post.desc || '').trim();
  if (desc && !AD_DESC_RE.test(desc) && desc.length >= 12) return desc;
  return '';
}

// 硬截断：优先在句号处收尾，别把一句话切一半
function clampText(text, limit) {
  const t = String(text || '').trim();
  if (!t || t.length <= limit) return t;
  const parts = t.split(/(?<=[。！？!?；;])\s*/);
  let out = '';
  for (const p of parts) {
    if ((out + p).length > limit) break;
    out += p;
  }
  if (!out) return t.slice(0, limit - 1) + '…';
  return out.trim() + (out.length < t.length ? '…' : '');
}

// 没有模型时的"话题"：直接挑几条评论原句
function commentTopics(comments, n = 2) {
  return (comments || [])
    .map((c) => String((c && c.text) || '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length >= 6)
    .slice(0, n)
    .map((t) => t.slice(0, 30));
}

async function buildSummary(post, comments, { signal } = {}) {
  const s = settings();
  const limit = s.summaryChars;
  const bodyLen = bodyOf(post).length;
  const tooLong = bodyLen > limit;

  if (!s.useModel) {
    return {
      mode: 'summary',
      summary: ruleSummary(post, { maxChars: limit }),
      topics: commentTopics(comments, 2),
      byModel: false,
      compressed: tooLong
    };
  }

  const cmtText = comments.slice(0, s.commentCount).map((c, i) => `${i + 1}. ${c.user}：${c.text}`).join('\n');
  const bodyText = bodyOf(post) || '（这条没有文字正文，是视频/动态帖）';

  const system = '你在帮群友读一条小黑盒帖子，只做归纳，不发表立场，不编造。'
    + '输出严格 JSON：{"summary":"...","topics":["...","..."]}'
    + `\nsummary 要求：不超过 ${limit} 字，必须压缩${tooLong ? '，不要保留原文的分点结构' : ''}，`
    + '但要保留原文里的关键信息（数字、做法、结论、装备/价格等），不要把内容抽象成一句口水话；'
    + '说清这条帖子讲了什么、结论或观点是什么；不要以"这篇帖子""作者表示"开头；不要复述标题；不要加 emoji。'
    + '\ntopics 要求：把评论按"实际在聊什么"归类，不要一条评论凑一条话题。'
    + '每条格式固定为「标签 · 内容」，标签从争议 / 质疑 / 玩梗 / 经验 / 提问 / 对比 / 吐槽 里挑最贴切的两个字，'
    + '内容不超过 16 字，要能看出声量（多数 / 不少人 / 少数 在聊什么）。'
    + '评论集中在一个方向就只给 1 条；方向多再给 2~4 条，最多 4 条；没有评论就给空数组；不要编造评论里没有的方向。';

  const user = `标题：${post.title}\n\n正文：\n${bodyText.slice(0, 4000)}`
    + (cmtText ? `\n\n评论区（共 ${post.commentNum} 条，这是前几条）：\n${cmtText}` : '\n\n评论区：暂无评论');

  const ask = (extra = '') => chatJson(
    [{ role: 'system', content: system + extra }, { role: 'user', content: user }],
    {
      maxTokens: Math.max(s.modelMaxTokens, 1200),
      temperature: extra ? 0.2 : 0.4,
      thinking: { type: 'disabled' },
      signal
    }
  );

  // 模型不一定听话给 JSON：先按 JSON 取，取不到就从纯文本里捞，别把好总结浪费掉
  const takeFrom = (out) => {
    const parsed = cleanJson(out);
    if (parsed && typeof parsed.summary === 'string' && parsed.summary.trim()) {
      return {
        summary: parsed.summary.trim(),
        topics: Array.isArray(parsed.topics)
          ? parsed.topics.map((t) => String(t).trim().slice(0, 20)).filter(Boolean).slice(0, 4)
          : []
      };
    }
    const plain = String(out || '').replace(/```(?:json)?/gi, '').trim();
    const m = plain.match(/"summary"\s*:\s*"([\s\S]*?)"\s*(?:,\s*"topics"|\})/);
    if (m) return { summary: m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').trim(), topics: [] };
    if (!plain.includes('"summary"') && plain.length >= 20) return { summary: plain, topics: [] };
    return null;
  };

  try {
    let got = takeFrom(await ask());
    if (!got) {
      warn('模型没按 JSON 返回，重试一次');
      got = takeFrom(await ask('\n注意：上一次输出格式不合要求。这次只输出 JSON 对象本身，不要解释、不要代码块。'));
    }
    if (!got || !got.summary) throw new Error('模型两次都没给出可用总结');
    let summary = got.summary.replace(/^["“]|["”]$/g, '');
    summary = clampText(summary, limit);
    return { mode: 'summary', summary, topics: got.topics, byModel: true, compressed: tooLong };
  } catch (e) {
    warn(`总结失败，改用规则摘要：${e?.message ?? e}`);
    return { mode: 'summary', summary: ruleSummary(post, { maxChars: limit }), topics: commentTopics(comments, 2), byModel: false, compressed: tooLong };
  }
}

// ── 图/视频帖：让视觉模型看画面 + 读评论，合成一段话 ────────────────────
async function buildVisionSummary(post, comments, { signal } = {}) {
  const s = settings();
  const imgs = (post.images || []).slice(0, 4);
  const limit = s.visionChars || 220;
  const cmt = (comments || [])
    .slice(0, 8)
    .map((c) => String((c && c.text) || '').replace(/\s+/g, ' ').trim().slice(0, 60))
    .filter(Boolean)
    .map((t) => `- ${t}`);

  const ask = (extra = '') => chatJson([{
    role: 'user',
    content: [
      {
        type: 'text',
        text: [
          `这是小黑盒帖子《${post.title || ''}》的图片，共 ${post.imageCount || imgs.length} 张，下面是其中 ${imgs.length} 张（按帖子顺序）。`,
          (post.liveVideos || []).length ? '其中几张是实况照片/短视频，给的是封面帧。' : '',
          '只依据看到的画面说话：场景、人物在做什么、能看清的屏幕/文字/物件。看不清或没把握就写"看不太清"，不要编造。',
          `输出严格 JSON：{"summary":"...","topics":["..."]}。summary 不超过 ${limit} 字，像转述给群友听那样讲清这几张图在说啥；`,
          'topics 把评论按实际在聊什么归类：每条「标签 · 内容」，标签从 争议 / 质疑 / 玩梗 / 经验 / 提问 / 对比 / 吐槽 里挑，',
          '内容 16 字内并带声量（多数 / 不少人 / 少数）；方向集中就给 1 条，方向多给 2~4 条，最多 4 条；只从下面的评论里提炼。',
          cmt.length ? `\n评论节选（共 ${post.commentNum || comments.length} 条）：\n${cmt.join('\n')}` : '\n没有可用评论，topics 给空数组。',
          extra
        ].filter(Boolean).join('\n')
      },
      ...imgs.map((u) => ({ type: 'image_url', image_url: { url: jpgUrl(u) } }))
    ]
  }], { model: (readApiConfig() || {}).visionModel, maxTokens: 1000, temperature: 0.2, thinking: { type: 'disabled' }, signal });

  const parse = (out) => {
    const raw = String(out || '').replace(/```(?:json)?/gi, '').trim();
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      const j = JSON.parse(m[0]);
      const summary = String(j.summary || '').trim();
      if (!summary) return null;
      const topics = Array.isArray(j.topics)
        ? j.topics.map((t) => String(t).replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 4)
        : [];
      return { summary, topics };
    } catch { return null; }
  };

  try {
    const a = readApiConfig();
    if (!a) throw new Error('没找到模型配置');
    if (!a.visionEnabled) throw new Error('视觉模型没开启（config.api.vision=false）');
    let got = parse(await ask());
    if (!got) {
      warn('图帖看图没按 JSON 返回，重试一次');
      got = parse(await ask('\n注意：上次输出不合格式。这次只输出 JSON 对象本身。'));
    }
    if (!got) throw new Error('视觉模型两次都没给出可用描述');
    let summary = got.summary.replace(/^["“]|["”]$/g, '');
    summary = clampText(summary, limit);
    return { mode: 'vision', summary, topics: got.topics, byModel: true, compressed: false };
  } catch (e) {
    warn(`图帖看图失败：${e?.message ?? e}`);
    const fallback = (comments || [])
      .map((c) => String((c && c.text) || '').replace(/\s+/g, ' ').trim())
      .filter((t) => t.length >= 8)
      .sort((x, y) => y.length - x.length)[0];
    return {
      mode: 'vision',
      summary: fallback ? `这条是图帖（${post.imageCount} 张图），画面没解析出来。评论里说得最具体的一条：${fallback.slice(0, 80)}` : '',
      topics: commentTopics(comments, 2),
      byModel: false,
      compressed: false
    };
  }
}

// 七牛的图默认给 webp，QQ 那边不吃，加 format/jpg 让服务端转码
function jpgUrl(url) {
  const u = String(url || '').replace(/%3E$/i, '');
  if (!u.includes('imageMogr2')) return u;
  if (/imageMogr2\/[^?]*format\/jpg/i.test(u)) return u;
  return u.replace('imageMogr2/', 'imageMogr2/format/jpg/');
}

// ── 封面下载 ────────────────────────────────────────────────────────────
function mediaDir() {
  const custom = String(cfg().mediaDir || '').trim();
  if (custom) return custom;
  return path.join(dataDir(), 'xhh-media');
}

function pruneOldFiles(dir, maxAgeMs = 2 * 60 * 60 * 1000) {
  try {
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      try {
        if (now - fs.statSync(p).mtimeMs > maxAgeMs) fs.unlinkSync(p);
      } catch { /* ignore */ }
    }
  } catch { /* ignore */ }
}

async function downloadCover(url, id, { signal, tag = '' } = {}) {
  if (!url) return null;
  const dir = mediaDir();
  fs.mkdirSync(dir, { recursive: true });
  pruneOldFiles(dir);
  const file = path.join(dir, `${id}${tag ? `-${tag}` : ''}-${Date.now()}.jpg`);
  const res = await netFetch(jpgUrl(url), { signal, headers: { Referer: 'https://www.xiaoheihe.cn/' } });
  if (!res.ok) throw new Error(`封面 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) throw new Error('封面内容异常（太小）');
  fs.writeFileSync(file, buf);
  return file;
}

// ── 文案 ────────────────────────────────────────────────────────────────
function buildCaption(post, sum, comments) {
  const lines = [];
  lines.push(`【小黑盒】${post.title || '(无标题)'}`);
  const meta = [];
  if (post.author) meta.push(post.author);
  if (post.commentNum) meta.push(`${post.commentNum} 条评论`);
  if (post.favourCount) meta.push(`${post.favourCount} 赞`);
  if (meta.length) lines.push(meta.join(' · '));

  if (sum.summary) {
    lines.push('');
    lines.push(sum.summary);
  }
  if (sum.mode === 'summary') {
    lines.push(`（原文 ${post.textLen} 字，已压缩）`);
  }
  if (sum.mode === 'vision') {
    lines.push(`（图帖 ${post.imageCount || 0} 张${sum.byModel ? '，按画面整理' : '，画面没解析出来'}）`);
  }
  if (post.degraded) lines.push('（接口在限流，这条只从网页拿了摘要，评论没取到）');

  if (sum.topics.length) {
    lines.push('');
    lines.push('评论区在聊：');
    for (const t of sum.topics) lines.push(`· ${t}`);
  } else if (sum.mode !== 'raw' && comments.length) {
    // 没有模型时，退化成直接贴两条高赞/早期评论
    lines.push('');
    lines.push('评论区在聊：');
    for (const c of comments.slice(0, 2)) lines.push(`· ${c.text.slice(0, 40)}`);
  }

  lines.push('');
  lines.push(post.shareUrl || `https://www.xiaoheihe.cn/app/bbs/link/${post.id}`);
  return lines.join('\n').slice(0, 2000);
}

// ── 主流程 ──────────────────────────────────────────────────────────────
function senderIdOf(payload = {}) {
  const e = payload?.entry || {};
  const s = payload?.sender || {};
  return String(e.senderId ?? e.sender?.id ?? e.sender?.userId
    ?? s.uin ?? s.id ?? s.userId ?? s.qq
    ?? payload?.senderId ?? payload?.userId ?? '').replace(/\D/g, '');
}

function allowedSenders() {
  const list = settings().allowSenders.split(/[,，\s]+/).map((x) => x.replace(/\D/g, '')).filter(Boolean);
  return list.length ? new Set(list) : null;
}

function senderAllowed(payload = {}, { strict = false } = {}) {
  const allow = allowedSenders();
  if (!allow) return true;
  const id = senderIdOf(payload);
  if (!id) return strict ? false : true;
  return allow.has(id);
}

// 同链接去重：10 分钟内同一 id 只转一次
const recent = new Map();
const DEDUP_MS = 10 * 60 * 1000;
function seenRecently(id) {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v > DEDUP_MS) recent.delete(k);
  if (recent.has(id)) return true;
  recent.set(id, now);
  return false;
}

// 串行闸门：多群同时贴链接时排队，避免把小黑盒风控撞穿
let chain = Promise.resolve();
function serialize(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function handlePost({ chatKey, id, url, signal }) {
  const s = settings();
  const send = typeof apiRef?.send === 'function' ? apiRef.send.bind(apiRef) : null;

  let post;
  let degraded = false;
  try {
    post = await fetchPost(id, { signal });
  } catch (e) {
    const code = e?.code;
    if (code === 'COOLDOWN' || code === 'CAPTCHA' || code === 'HTTP') {
      // 接口被限流时不吃瘪：退到网页版 meta 摘要，至少把标题和要点转出去
      try {
        post = await fetchPostHtml(id, { signal });
        degraded = true;
        warn(`接口限流，已降级用网页摘要（${post.textLen} 字）：${id}`);
      } catch (e2) {
        warn(`网页兜底也失败：${e2?.message ?? e2}`);
        throw Object.assign(new Error('小黑盒这会儿打不开（接口限流），过一会儿再贴'), { friendly: true });
      }
    } else {
      throw e;
    }
  }

  // 既没正文、也没拿到任何真实图片地址：这种帖子转发出去只剩标题，不转
  const body = bodyOf(post);
  const imgs = post.images || [];
  if (!body && !imgs.length) {
    log(`「${post.title}」没有正文也没有可取到的图片（视频/纯图帖），不转发`);
    return { skip: true, title: post.title };
  }

  let comments = [];
  if (!degraded) {
    try {
      comments = await fetchComments(id, { limit: s.commentCount, signal });
    } catch (e) {
      warn(`评论抓取失败（不影响正文转发）：${e?.message ?? e}`);
    }
  }

  // 有正文就总结正文；只有图/视频就看图说话
  const sum = body
    ? await buildSummary(post, comments, { signal })
    : await buildVisionSummary(post, comments, { signal });
  const caption = buildCaption(post, sum, comments);

  // 默认不发图：图片靠文字描述代替，群里只出一条文案
  if (s.sendImages && send) {
    if (!body && imgs.length) {
      for (let i = 0; i < Math.min(imgs.length, Math.max(1, s.maxImages || 3)); i++) {
        try {
          const file = await downloadCover(imgs[i], id, { signal, tag: `p${i + 1}` });
          await send(chatKey, [{ type: 'image', file: `file://${file.replace(/\\/g, '/')}` }], { signal });
          log(`图帖第 ${i + 1} 张已发送`);
        } catch (e) {
          warn(`图帖第 ${i + 1} 张没发出去：${e?.message ?? e}`);
        }
      }
    } else if (post.cover) {
      try {
        const file = await downloadCover(post.cover, id, { signal });
        await send(chatKey, [{ type: 'image', file: `file://${file.replace(/\\/g, '/')}` }], { signal });
        log(`封面已发送（${(fs.statSync(file).size / 1024).toFixed(0)}KB）`);
      } catch (e) {
        warn(`封面没发出去：${e?.message ?? e}`);
      }
    }
  } else if (post.cover || imgs.length) {
    log('按配置不转发图片（sendImages=false），只发文字');
  }

  log(`已转发「${post.title}」：正文 ${post.textLen} 字、图 ${post.imageCount || 0} 张、评论 ${comments.length} 条、`
    + `${sum.mode === 'vision' ? (sum.byModel ? '看图整理' : '看图失败兜底') : (sum.byModel ? '模型总结' : '规则摘要')}`
    + `${sum.compressed ? '（已压缩）' : ''}`);
  return { segments: [{ type: 'text', text: caption }] };
}

async function claimFor05({ chatKey, text, signal, entry } = {}) {
  if (!senderAllowed({ entry }, { strict: true })) {
    log(`链接来自白名单外的 ${senderIdOf({ entry }) || '未知发送者'}，跳过`);
    return { status: 'skip' };
  }
  const posts = extractPosts(text);
  if (!posts.length) return { status: 'skip' };
  const first = posts[0];
  if (seenRecently(first.id)) {
    log(`链接 ${first.id} 刚转过，跳过`);
    return { status: 'skip' };
  }

  return serialize(async () => {
    try {
      const r = await handlePost({ chatKey, id: first.id, url: first.url, signal });
      if (r?.skip) return { status: 'skip' };
      return r;
    } catch (e) {
      const msg = String(e?.message ?? e);
      warn(`转发失败：${msg}`);
      if (e?.friendly) {
        return { segments: [{ type: 'text', text: `${msg}，链接给你：${first.url}` }] };
      }
      return { segments: [{ type: 'text', text: `这条小黑盒帖子我没打开成功（${msg.slice(0, 60)}），链接：${first.url}` }] };
    }
  });
}

// ── 能力提供者 ──────────────────────────────────────────────────────────
export const providers = {
  'media.download': async (payload = {}) => {
    if (payload && payload.chatKey && !payload.url) return claimFor05(payload);
    // 0.4 形态：单条 url
    const { url, sender, kind, chatId, text } = payload;
    if (!url || !/xiaoheihe\.cn/i.test(String(url))) return { skip: true };
    const id = parseLinkId(url);
    if (!id) return { skip: true };
    if (!senderAllowed(payload)) {
      log(`链接来自白名单外的 ${senderIdOf(payload) || '未知发送者'}，跳过`);
      return { skip: true };
    }
    if (seenRecently(id)) return { skip: true };
    const chatKey = `${kind}:${chatId}`;
    return serialize(async () => {
      try {
        const r = await handlePost({ chatKey, id, url: `https://www.xiaoheihe.cn/app/bbs/link/${id}` });
        return { ok: true, segments: r.segments };
      } catch (e) {
        const msg = String(e?.message ?? e);
        return { ok: false, error: msg, friendly: '这条小黑盒帖子我没打开成功' };
      }
    });
  }
};

// ── 可用性与提示词 ──────────────────────────────────────────────────────
export function setup(api) {
  apiRef = api || null;
  cfg = api.config;
  log = (m) => { try { api.log(m); } catch { /* ignore */ } writeFileLog('INFO', m); };
  warn = (m) => { try { api.warn(m); } catch { /* ignore */ } writeFileLog('WARN', m); };

  // 手动工具：让模型也能"读一条小黑盒帖子"（只返回摘要，不发群）
  if (typeof api?.registerTool === 'function') {
    api.registerTool({
      id: 'xhh_post',
      name: '读小黑盒帖子',
      description: '打开一条小黑盒帖子，返回标题、作者、正文摘要和评论区话题。'
        + '有人贴小黑盒链接让你"看看讲了什么"时用；只读不发，不会往群里发消息。',
      category: 'media',
      icon: '📖',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '小黑盒帖子链接或 link_id' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        const id = parseLinkId(String(args?.url || ''));
        if (!id) return { content: '没认出小黑盒帖子 ID，请贴完整链接', isError: true };
        try {
          const post = await fetchPost(id);
          const comments = await fetchComments(id, { limit: 8 }).catch(() => []);
          const sum = await buildSummary(post, comments);
          return {
            content: `标题：${post.title}\n作者：${post.author}\n评论：${post.commentNum} · 赞：${post.favourCount}\n\n`
              + `总结：${sum.summary}\n`
              + (sum.topics.length ? `\n评论区话题：${sum.topics.join(' / ')}\n` : '')
              + `\n正文长度：${post.textLen} 字\n链接：${post.shareUrl}`
          };
        } catch (e) {
          return { content: `读取失败：${e?.message ?? e}`, isError: true };
        }
      }
    });
  }
  let ver = '?';
  try { ver = JSON.parse(fs.readFileSync(path.join(PLUGIN_DIR, 'plugin.json'), 'utf8')).version || '?'; } catch { /* ignore */ }
  log(`小黑盒帖子转发已加载（${ver}）`);
}

export function available() {
  const s = settings();
  if (s.summaryChars <= 0) return { ok: false, reason: '总结字数上限配置不合法' };
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

export const internals = {
  sign,
  signedParams,
  parseLinkId,
  extractPosts,
  fetchPost,
  fetchPostHtml,
  fetchComments,
  buildSummary,
  buildCaption,
  senderAllowed,
  senderIdOf,
  seenRecently
};
