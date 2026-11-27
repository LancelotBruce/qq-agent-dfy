// memory-recall — 把很久以前聊过的事翻出来。
//
// 数据源：<app>/data/memory-v2/chunks/hour_*.json
//   conversation-memory 插件每 10 分钟巩固一次，产出「每小时一个块」：
//   { id, kind:'hour', chatKey:'group:2000000003', dayKey:'2026-10-17', hourKey:'16',
//     title, summary, keywords:[...], snippets:[{when,ts,who,text}], msgCount }
//
// 平常不读盘、不进提示词；只有模型调用 memory_recall 时才扫一遍（几十块 ≈ 1.8 MB，几毫秒）。
//
// 为什么自己读块文件、而不是走能力接口：
//   conversation-memory 的 plugin.json 声明了 memory.search / memory.archive 能力，
//   但 index.js 没有导出 providers，api.capability('memory.search') 拿不到实现；
//   若在 manifest 里写 requires:["memory.search"]，本技能会永远显示「依赖未就绪」。
//   所以这里做软降级：有能力就先问能力接口，拿不到就直接读块文件（本技能自足）。
//
// v1.1.2 检索质量三改（v1.1.1 实测暴露的问题）：
//   1. 日期/时段识别：把「10月15日下午」「前天」「10-15」「3天前」解析成 dayKey + 时段过滤，
//      而不是当成关键词去搜（旧版「10月15日下午」命中全部 65 块，等于没检索）。
//   2. 停用词 + 纯数字过滤：聊天/下午/什么/记得 这类泛词不进检索。
//   3. IDF 加权：在某段时间的块里出现超过 60% 的词视为泛词、直接忽略；
//      其余词按 1+ln((N+1)/(df+1)) 加权，稀有词（人名、梗）权重自然高于常见词。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, '..', '..');

const DEFAULTS = {
  defaultDays: 30,
  defaultLimit: 5,
  showSnippets: 3,
  maxChunkFiles: 4000,
  maxFileKb: 512
};

// 泛词/时间词/疑问词：这些不该参与检索（由日期解析或纯粹是口水话）。
const STOP = new Set([
  '聊天', '聊聊', '聊了', '聊过', '说说', '说过', '说了', '说的', '提到', '提过',
  '什么', '怎么', '为什么', '怎么样', '怎样', '哪里', '哪个', '哪些', '多少', '几个',
  '我们', '你们', '他们', '她们', '大家', '自己', '别人',
  '这个', '那个', '这些', '那些', '这样', '那样', '这种', '那种',
  '一下', '一个', '一些', '一点', '有点', '还是', '就是', '可能', '应该', '大概',
  '记得', '还记', '想起来', '想起', '忘了', '忘记',
  '时候', '时间', '事情', '东西', '事儿', '那天', '当天', '当时',
  '上午', '下午', '中午', '晚上', '早上', '早晨', '凌晨', '半夜', '傍晚', '夜里'
]);

const PERIODS = [
  { re: /凌晨/, name: '凌晨', h: [0, 5] },
  { re: /早上|早晨|清晨|上午/, name: '上午', h: [6, 11] },
  { re: /中午|正午/, name: '中午', h: [11, 13] },
  { re: /下午|午后/, name: '下午', h: [13, 17] },
  { re: /晚上|傍晚|夜里|夜间/, name: '晚上', h: [18, 23] }
];

let api = null;

function settings() {
  let raw = {};
  try {
    raw = (typeof api?.config === 'function' ? api.config() : null) || {};
  } catch { raw = {}; }
  const n = (v, d, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  return {
    defaultDays: n(raw.defaultDays, DEFAULTS.defaultDays, 0, 3650),
    defaultLimit: n(raw.defaultLimit, DEFAULTS.defaultLimit, 1, 20),
    showSnippets: n(raw.showSnippets, DEFAULTS.showSnippets, 0, 10),
    maxChunkFiles: n(raw.maxChunkFiles, DEFAULTS.maxChunkFiles, 50, 20000),
    maxFileKb: n(raw.maxFileKb, DEFAULTS.maxFileKb, 64, 4096)
  };
}

/** 候选数据目录：env 覆盖优先，其次 <app>/data、<app>/data-xxx（profile 后缀）。 */
function dataDirs() {
  const out = [];
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (env) out.push(env);
  try {
    for (const name of fs.readdirSync(APP_ROOT)) {
      if (name === 'data' || /^data[-_].+/.test(name)) out.push(path.join(APP_ROOT, name));
    }
  } catch { /* 拿不到 app 根目录时只剩 env 一条路 */ }
  // 扁平/便携布局兜底：技能在 <根>\resources\app\skills\...，而运行时数据在 <根>\data
  // （如 <安装目录>\data）。此时 APP_ROOT 推不到数据目录，向上逐级找 <dir>/data。
  let base = APP_ROOT;
  for (let i = 0; i < 3; i += 1) {
    base = path.resolve(base, '..');
    const p = path.join(base, 'data');
    try { if (fs.statSync(p).isDirectory()) out.push(p); } catch { /* 继续向上 */ }
  }
  return [...new Set(out)];
}

function chunksDir() {
  for (const d of dataDirs()) {
    const p = path.join(d, 'memory-v2', 'chunks');
    try {
      if (fs.statSync(p).isDirectory()) return p;
    } catch { /* 下一个 */ }
  }
  return null;
}

const pad2 = (x) => String(x).padStart(2, '0');
const ymdOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/**
 * 从查询里解析日期/时段，返回 { dayKey, hourRange, cleaned }。
 * cleaned 已去掉日期与时段词（剩下的是可检索的关键词）。
 */
function parseWhen(text, now = new Date()) {
  let s = String(text || '');
  let dayKey = null;
  let hourRange = null;
  let label = '';

  const strip = (re) => { const m = re.exec(s); if (m) s = s.replace(re, ' '); return m; };

  const ymd = strip(/(\d{4})\s*[年\/-]\s*(\d{1,2})\s*[月\/-]\s*(\d{1,2})\s*[日号]?/);
  const md = ymd ? null : strip(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/);
  const nd = ymd || md ? null : strip(/(\d{1,2})\s*天前/);

  if (ymd) {
    dayKey = `${ymd[1]}-${pad2(ymd[2])}-${pad2(ymd[3])}`;
  } else if (md) {
    const y = now.getFullYear();
    let cand = new Date(y, Number(md[1]) - 1, Number(md[2]));
    if (cand.getTime() > now.getTime()) cand = new Date(y - 1, Number(md[1]) - 1, Number(md[2]));
    dayKey = ymdOf(cand);
  } else if (nd) {
    dayKey = ymdOf(new Date(now.getTime() - Number(nd[1]) * 86400000));
  } else if (/前天/.test(s)) {
    dayKey = ymdOf(new Date(now.getTime() - 2 * 86400000));
    s = s.replace(/前天/g, ' ');
  } else if (/昨天|昨日/.test(s)) {
    dayKey = ymdOf(new Date(now.getTime() - 1 * 86400000));
    s = s.replace(/昨天|昨日/g, ' ');
  } else if (/今天|今日|当天/.test(s)) {
    dayKey = ymdOf(now);
    s = s.replace(/今天|今日|当天/g, ' ');
  }

  // 具体点数：「下午3点」「15点」
  const hm = /(上午|下午|晚上|中午|凌晨|早上|早晨)?\s*(\d{1,2})\s*(?:点|时)(?:半|钟)?/.exec(s);
  if (hm) {
    let h = Number(hm[2]);
    const per = hm[1] || '';
    if (h > 23) h = 23;
    if (/凌晨|早上|早晨|上午/.test(per) && h === 12) h = 0;
    if (/下午|晚上|傍晚|夜里/.test(per) && h < 12) h += 12;
    hourRange = [h, h];
    s = s.replace(hm[0], ' ');
  } else {
    for (const p of PERIODS) {
      if (p.re.test(s)) {
        hourRange = p.h;
        label = p.name;
        s = s.replace(p.re, ' ');
        break;
      }
    }
  }

  const hourLabel = hourRange ? (hourRange[0] === hourRange[1] ? `${hourRange[0]} 点` : `${hourRange[0]}-${hourRange[1]} 点`) : '';
  if (dayKey && hourRange) label = `${dayKey} ${label || hourLabel}`;
  else if (dayKey) label = dayKey;
  else if (hourRange) label = label || hourLabel;

  return { dayKey, hourRange, cleaned: s.replace(/\s+/g, ' ').trim(), label };
}

/** 拆词：英文/数字按词，中文按「整词 + 相邻二字」，跟块里的 keywords 口径接近。 */
function tokens(text) {
  const out = new Set();
  const s = String(text || '').toLowerCase();
  for (const w of s.split(/[^a-z0-9\u4e00-\u9fff]+/)) {
    if (!w) continue;
    if (/^[a-z0-9]+$/.test(w)) {
      if (w.length >= 2 && !/^\d+$/.test(w)) out.add(w);
      continue;
    }
    if (w.length >= 2) {
      out.add(w);
      for (let i = 0; i + 1 < w.length; i++) out.add(w.slice(i, i + 2));
    }
  }
  return [...out]
    .filter((t) => t.length >= 2 && !/^\d+$/.test(t) && !STOP.has(t))
    .slice(0, 24);
}

function dayAgo(days) {
  return ymdOf(new Date(Date.now() - days * 86400000));
}

function chatLabel(key) {
  const k = String(key || '');
  const g = /^group:(.+)$/.exec(k);
  if (g) return `群 ${g[1]}`;
  const p = /^private:(.+)$/.exec(k);
  if (p) return `与 ${p[1]} 的私聊`;
  return k || '未知会话';
}

/** 块的可检索文本（keywords/title/summary/snippets 分开，用于分档计分）。 */
function fieldsOf(ch) {
  const lower = (s) => String(s ?? '').toLowerCase();
  return {
    kw: new Set((Array.isArray(ch.keywords) ? ch.keywords : []).map(lower)),
    title: lower(ch.title),
    summary: lower(ch.summary),
    snips: (Array.isArray(ch.snippets) ? ch.snippets : []).map((s) => lower(s?.text)),
    whos: (Array.isArray(ch.snippets) ? ch.snippets : []).map((s) => lower(s?.who))
  };
}

/** 说话人命中（问「谁说的」时有用）：只加分，不参与 df —— 否则「白饭」这种名字会被当成泛词丢掉。 */
function whoScore(f, t) {
  let n = 0;
  for (const w of f.whos || []) if (w && w.includes(t)) n++;
  return n ? 2 + Math.min(1, n - 1) : 0;
}

/** 某个词在本块里的命中情况（分档：keywords 3 / title 2 / summary 1 / snippets 2+bonus）。 */
function fieldScore(f, t) {
  let s = 0;
  if (f.kw.has(t)) s += 3;
  if (f.title.includes(t)) s += 2;
  if (f.summary.includes(t)) s += 1;
  const n = f.snips.filter((x) => x.includes(t)).length;
  if (n) s += 2 + Math.min(2, n - 1);
  return s;
}

function scoreChunk(f, toks, weights, phrase, phraseField) {
  let total = 0;
  const hits = [];
  for (const t of toks) {
    const fs = fieldScore(f, t) + whoScore(f, t);
    if (fs > 0) {
      total += fs * weights[t];
      hits.push(t);
    }
  }
  if (phrase && phrase.length >= 2 && phraseField(f, phrase)) total += 4;
  return { score: total, hits };
}

/** 块的钟点：hourKey 形如 '2026-10-15 13'，取末尾数字。 */
function hourOf(ch) {
  const m = /(\d{1,2})\s*$/.exec(String(ch?.hourKey ?? ''));
  const h = m ? Number(m[1]) : NaN;
  return Number.isFinite(h) ? h : null;
}

function render(ch, hits, showSnippets) {
  const h = hourOf(ch);
  const when = ch.dayKey ? `${ch.dayKey}${h !== null ? ` ${h} 点` : ''}` : '';
  const lines = [`【${when || '时间不明'} · ${chatLabel(ch.chatKey)}${ch.msgCount ? ` · ${ch.msgCount} 条` : ''}】`];
  if (ch.title) lines.push(`话题：${ch.title}`);
  if (Array.isArray(ch.keywords) && ch.keywords.length) lines.push(`关键词：${ch.keywords.slice(0, 10).join('、')}`);
  const snips = Array.isArray(ch.snippets) ? ch.snippets.filter((s) => s && s.text) : [];
  const want = Math.max(0, showSnippets);
  const picked = [];
  for (const s of snips) {
    if (picked.length >= want) break;
    const t = String(s.text).toLowerCase();
    if (!hits.length || hits.some((h) => t.includes(h))) picked.push(s);
  }
  for (const s of snips) {
    if (picked.length >= want) break;
    if (!picked.includes(s)) picked.push(s);
  }
  for (const s of picked) {
    const t = String(s.text).replace(/\s+/g, ' ').slice(0, 140);
    lines.push(`· ${s.who ? `${s.who}: ` : ''}${t}`);
  }
  if (!picked.length && ch.summary) lines.push(String(ch.summary).replace(/\s+/g, ' ').slice(0, 300));
  return lines.join('\n');
}

/* ── 外号展开：读 member-aliases 插件维护的 data/member-aliases.json ─────────
   文件形如 {"version":1,"aliases":{"<uid>":["外号1","外号2"]}}。
   没有这个文件、或者文件坏了，都静默跳过（检索照旧）。 */

let aliasCache = { file: '', mtimeMs: 0, map: new Map() };

function loadAliases(dataDir) {
  const file = path.join(dataDir, 'member-aliases.json');
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return new Map();
  }
  if (aliasCache.file === file && aliasCache.mtimeMs === mtimeMs) return aliasCache.map;
  const map = new Map();
  try {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    const raw = data && typeof data === 'object' ? (data.aliases || data) : {};
    for (const [uid, list] of Object.entries(raw)) {
      if (!/^\d{3,}$/.test(String(uid))) continue;
      const arr = (Array.isArray(list) ? list : [list])
        .map((x) => String(x ?? '').trim())
        .filter((x) => x.length >= 2);
      const names = [...new Set(arr)];
      for (const a of names) {
        const key = a.toLowerCase();
        if (!map.has(key)) map.set(key, { uid: String(uid), names });
      }
    }
  } catch { /* 表坏了就当没有 */ }
  aliasCache = { file, mtimeMs, map };
  return map;
}

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 在 query 里找外号 → 展开成同组其他叫法 + uid（长的先匹配，含字母数字的要边界）。 */
function expandAliases(cleaned, aliasMap) {
  const extra = [];
  const notes = [];
  if (!aliasMap.size) return { extra, notes };
  const s = String(cleaned || '').toLowerCase();
  if (!s) return { extra, notes };
  const keys = [...aliasMap.keys()].sort((a, b) => b.length - a.length);
  for (const k of keys) {
    const hit = /[0-9a-z]/.test(k)
      ? new RegExp(`(?<![0-9a-z])${escapeRe(k)}(?![0-9a-z])`).test(s)
      : s.includes(k);
    if (!hit) continue;
    const { uid, names } = aliasMap.get(k);
    for (const n of names) if (!extra.includes(n)) extra.push(n);
    if (!extra.includes(uid)) extra.push(uid);
    notes.push(names.length > 1 ? `${k}→${names[0]}等${names.length}个叫法` : `${k}→${names[0]}`);
  }
  return { extra, notes };
}

const TOOL = {
  id: 'memory_recall',
  name: '回忆往事',
  category: 'memory',
  icon: '🧠',
  description: '检索她的「长时记忆」：很久以前在群里/私聊里聊过的事（每小时一块的摘要，不是逐条原文）。当有人问「你还记得…」「前几天/上次/以前说过…」「那天那个…」，或者需要很久以前的上下文（人名、梗、约定、喜好），先调这个再回答，比凭印象编靠谱。query 可以用具体名词（人名、梗、地名、事件），也可以直接写日期/时段（「10月15日下午」「前天」「昨天」「3天前」），日期会按天过滤而不是当关键词搜；别用「聊天」「下午」「什么」这类泛词。返回命中的记忆块：时间、会话、关键词、几条原文片段。查人时写群里平时的叫法（外号）也行，会按外号表自动展开成真名一起搜。没命中就如实说想不起来，不要编。',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: '要回忆的关键词/人名/话题/短句，也可以带日期（如「10月15日下午 韩国银行」「前天 撕咬的大狗」「上次说的显卡」）。越具体越准。'
      },
      days: {
        type: 'integer',
        description: '往回看多少天，默认 30；0 = 不限（全量扫）。query 里写了日期时以日期为准。'
      },
      limit: {
        type: 'integer',
        description: '最多返回几个记忆块，默认 5，最大 20。'
      }
    },
    required: ['query']
  },
  async execute(ctx, args) {
    const q = String(args?.query ?? '').trim();
    if (!q) return { content: '错误：query 不能为空', isError: true };

    const st = settings();
    const dir = chunksDir();
    if (!dir) {
      return {
        content: '这台机器上没有找到长时记忆（data/memory-v2/chunks 不存在）。可能是 conversation-memory 插件没在跑，或者还没攒够一个小时的记忆块。',
        isError: false
      };
    }

    const daysArg = args?.days;
    const days = daysArg === undefined || daysArg === null || daysArg === ''
      ? st.defaultDays
      : Math.max(0, Math.min(3650, Number(daysArg) || 0));
    const limit = Math.max(1, Math.min(20, Number(args?.limit) || st.defaultLimit));

    const when = parseWhen(q);
    const aliasMap = loadAliases(path.resolve(dir, '..', '..'));
    const exp = expandAliases(when.cleaned, aliasMap);
    const toks = tokens(when.cleaned);
    const minDay = when.dayKey ? '' : (days > 0 ? dayAgo(days) : '');

    let names = [];
    try {
      names = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (e) {
      return { content: `读取记忆目录失败：${e?.message || e}`, isError: true };
    }

    const files = [];
    for (const f of names) {
      try {
        const s = fs.statSync(path.join(dir, f));
        files.push({ f, m: s.mtimeMs, size: s.size });
      } catch { /* 跳过读不到的文件 */ }
    }
    files.sort((a, b) => b.m - a.m);
    const maxBytes = st.maxFileKb * 1024;

    const load = (pred) => {
      const out = [];
      for (const it of files.slice(0, st.maxChunkFiles)) {
        if (it.size > maxBytes) continue;
        let ch;
        try {
          ch = JSON.parse(fs.readFileSync(path.join(dir, it.f), 'utf8'));
        } catch { continue; }
        if (!ch || typeof ch !== 'object' || !ch.dayKey) continue;
        if (!pred(ch)) continue;
        out.push({ ch, f: fieldsOf(ch) });
      }
      return out;
    };

    // 1) 按日期/时段收窄；日期收了但一条都没有时，退回按内容搜（并说明）。
    let pool = [];
    let dateNote = '';
    if (when.dayKey) {
      const inHour = (ch) => {
        if (!when.hourRange) return true;
        const h = hourOf(ch);
        return h !== null && h >= when.hourRange[0] && h <= when.hourRange[1];
      };
      pool = load((ch) => String(ch.dayKey) === when.dayKey && inHour(ch));
      if (!pool.length) {
        const loose = load((ch) => String(ch.dayKey) === when.dayKey);
        if (loose.length) { pool = loose; dateNote = '，放宽到整天（那个时段没有块）'; }
      }
      if (!pool.length) { pool = load(() => true); dateNote = '，那天没有记忆块，改成按内容搜'; }
    } else {
      pool = load((ch) => !minDay || String(ch.dayKey) >= minDay);
    }

    if (!pool.length) {
      return {
        content: `没翻到相关记忆（关键词：${q}${days ? `，回看 ${days} 天` : ''}）。可能是那段时间没有记忆块，或者换个说法/人名/更短的关键词再试。`,
        isError: false
      };
    }

    // 2) IDF + 打分。先只用原词；原词一块都没命中时，才动用外号展开（避免展开词把结果冲成一片）。
    const N = pool.length;
    const phrase = when.cleaned.toLowerCase();
    const phraseField = (f) => (phrase.length >= 2
      && (f.title.includes(phrase) || f.summary.includes(phrase) || f.snips.some((x) => x.includes(phrase))));

    const runSearch = (list, expandSet) => {
      const df = new Map();
      for (const t of list) {
        let n = 0;
        for (const it of pool) if (fieldScore(it.f, t) > 0) n++;
        df.set(t, n);
      }
      const weights = {};
      const dropped = [];
      for (const t of list) {
        const n = df.get(t) || 0;
        if (N >= 8 && n / N > 0.6) { dropped.push(t); continue; }
        let w = 1 + Math.log((N + 1) / (n + 1));
        if (expandSet?.has(t)) w = Math.min(w, 2.5);   // 展开词是猜的，别盖过原词
        weights[t] = w;
      }
      const usable = list.filter((t) => weights[t] !== undefined);
      const scored = [];
      for (const it of pool) {
        const r = scoreChunk(it.f, usable, weights, phrase, phraseField);
        if (r.score > 0) scored.push({ ch: it.ch, score: r.score, hits: r.hits });
      }
      scored.sort((a, b) => (b.score - a.score) || String(b.ch.dayKey || '').localeCompare(String(a.ch.dayKey || '')));
      return { scored, usable, dropped };
    };

    const base = runSearch(toks, null);
    let res = base;
    let triedExpansion = false;
    if (!base.scored.length && exp.extra.length) {
      triedExpansion = true;
      res = runSearch([...new Set([...toks, ...exp.extra])], new Set(exp.extra));
    }
    const { scored, usable, dropped } = res;

    // 3) 没有可用关键词但有日期时，按时间顺序列出那天（或那个时段）的块。
    const byTime = !usable.length;
    if (byTime) {
      if (!when.dayKey && !when.hourRange) {
        return {
          content: `没翻到相关记忆（关键词：${q}）。词都太泛了（${toks.slice(0, 6).join('、') || '无'}），换一个具体的人名、梗或事再试；也可以直接写日期，比如「10月15日下午」。`,
          isError: false
        };
      }
      for (const it of pool) scored.push({ ch: it.ch, score: 0, hits: [] });
      scored.sort((a, b) => ((hourOf(a.ch) ?? 0) - (hourOf(b.ch) ?? 0))
        || String(a.ch.dayKey || '').localeCompare(String(b.ch.dayKey || '')));
    } else if (!scored.length) {
      const hint = dropped.length ? `（其中 ${dropped.slice(0, 5).join('、')} 太常见，已忽略）` : '';
      return {
        content: `没翻到相关记忆（关键词：${usable.join(' ')}${hint}${when.dayKey ? `，日期 ${when.label}` : days ? `，回看 ${days} 天` : ''}）。换个具体的人名、梗或事件再试，或者直接写日期。`,
        isError: false
      };
    }

    const top = scored.slice(0, limit);
    const head = [
      `回忆检索（关键词：${usable.length ? usable.join(' ') : '（仅按时间）'}${dropped.length ? `；忽略泛词：${dropped.slice(0, 6).join('、')}` : ''}${triedExpansion && exp.notes.length ? `；外号展开（原词没命中才展开）：${exp.notes.slice(0, 4).join('、')}` : ''}`,
      `限定：${when.label || (days ? `最近 ${days} 天` : '全部')}；命中 ${scored.length} 块，显示前 ${top.length} 块${dateNote}）：`
    ].join('，');
    return {
      content: `${head}\n\n`
        + top.map((h) => render(h.ch, h.hits, st.showSnippets)).join('\n\n')
        + '\n\n（这些是每小时的摘要，不是完整聊天记录；要逐条原文可以用 get_recent_messages 之类的工具往前翻。）',
      isError: false
    };
  }
};

export function setup(skillApi) {
  api = skillApi;
  api.registerTool(TOOL);
}

export default { setup };
