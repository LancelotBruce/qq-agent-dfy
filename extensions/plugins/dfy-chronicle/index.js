// 大肥鱼调试编年史 · 让机器人查得到 2026-10-27 → 11-27 的调试过程
// 数据由《调试编年史.html》解析而来，纯本地只读，不联网、不写用户数据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const DATA_FILE = path.join(DIR, 'assets', 'chronicle.json');
const IMAGE_FILE = path.join(DIR, 'assets', 'chronicle.png');

let api = null;
let data = null;
let docs = [];

const DEFAULTS = {
  enabled: true,
  maxResults: 5
};

function warn(...args) { try { api?.warn?.(...args); } catch { /* ignore */ } }
function log(...args) { try { api?.log?.(...args); } catch { /* ignore */ } }

function settings() {
  try {
    const all = api?.config?.all?.() || {};
    return { ...DEFAULTS, ...all };
  } catch { return { ...DEFAULTS }; }
}

function clean(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function oneLine(s) {
  return String(s ?? '').replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  // 保留换行：总览/详情要按行读，不能压成一整段
  s = String(s ?? '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

function loadData() {
  const raw = fs.readFileSync(DATA_FILE, 'utf8');
  data = JSON.parse(raw);
  buildDocs();
  log(`调试编年史已加载：${data.phases.length} 段 / ${data.incidents.length} 起事故 / ${data.numbers.length} 组数字`);
}

function buildDocs() {
  docs = [];
  const add = (doc) => docs.push(doc);

  add({
    id: 'OVERVIEW', kind: '总览', title: '大肥鱼调试编年史总览',
    date: data.span, text: [
      `时间跨度 ${data.span}，连续 ${data.days} 天，${data.versions} 个版本号，${data.incidents.length} 起有档案的事故，${data.extensionCount} 个插件与技能。`,
      `主线：${data.phases.map((p) => `${p.date} ${p.title}`).join('；')}。`,
      `事故：${data.incidents.map((i) => `${i.time} ${i.name}`).join('；')}。`,
      `数字：${data.numbers.map((n) => `${n.metric} ${n.before} → ${n.after}`).join('；')}。`
    ].join('\n')
  });

  for (const p of data.phases) {
    add({
      id: p.id, kind: '主线', title: p.title, date: p.date, ver: p.ver, tag: p.tag,
      text: [
        p.date, p.ver, p.tag, p.title, p.lede,
        ...p.items.map((x) => `· ${x}`),
        p.metrics.length ? `指标：${p.metrics.join('；')}` : '',
        p.source ? `证据：${p.source}` : ''
      ].filter(Boolean).join('\n')
    });
  }

  for (const i of data.incidents) {
    add({
      id: i.id, kind: '事故', title: `${i.name}${i.flag ? `（${i.flag}）` : ''}`, date: i.time,
      text: `时间：${i.time}\n事故：${i.name}${i.flag ? `（${i.flag}）` : ''}\n根因：${i.cause}\n处置：${i.fix}`
    });
  }

  for (const n of data.numbers) {
    add({
      id: n.id, kind: '数字', title: n.metric, date: '',
      text: `${n.metric}：${n.before} → ${n.after}`
    });
  }

  for (const e of data.evidence) {
    add({
      id: e.id, kind: '证据', title: e.title, date: '',
      text: [
        `${e.title}（${e.kind}）`, e.hint,
        ...e.items.map((it) => `${it.size} ${it.file}｜${it.note}`)
      ].filter(Boolean).join('\n')
    });
  }

  for (const r of data.rules) {
    add({ id: r.id, kind: '口径', title: `定型口径 ${r.id}`, date: '', text: r.text });
  }

  for (const o of data.open) {
    add({
      id: o.id, kind: '未决', title: o.what, date: '',
      text: `${o.what}（${o.status}）\n${o.why}`
    });
  }
}

// ── 检索：中文按二元组切，英文/数字按词切，标题命中加权 ──────────────
function normalize(s) {
  return String(s ?? '').toLowerCase().replace(/[，。；：、！？（）()【】「」『』“”‘’《》·|｜]+/g, ' ');
}

function termsOf(query) {
  const q = normalize(query);
  const out = new Set();
  for (const w of q.match(/[a-z0-9][a-z0-9_.\-/\\]*/g) || []) if (w.length >= 2) out.add(w);
  for (const seg of q.match(/[\u4e00-\u9fff]+/g) || []) {
    if (seg.length <= 6) out.add(seg);
    for (let i = 0; i < seg.length - 1; i += 1) out.add(seg.slice(i, i + 2));
  }
  return [...out].filter((t) => t.length >= 2);
}

function countOf(hay, needle) {
  if (!needle) return 0;
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n += 1; i += needle.length; }
  return n;
}

function scoreDoc(doc, q, terms) {
  const title = normalize(doc.title);
  const meta = normalize(`${doc.date || ''} ${doc.ver || ''} ${doc.tag || ''} ${doc.kind || ''}`);
  const body = normalize(doc.text);
  let score = 0;
  const full = q.replace(/\s+/g, '');
  if (full && full.length >= 2) {
    if (title.replace(/\s+/g, '').includes(full)) score += 20;
    if (body.replace(/\s+/g, '').includes(full)) score += 10;
    if (meta.replace(/\s+/g, '').includes(full)) score += 6;
  }
  for (const t of terms) {
    const tc = countOf(title, t);
    const tc2 = countOf(meta, t);
    const bc = countOf(body, t);
    if (tc) score += 8 + Math.min(tc, 2) * 3;
    if (tc2) score += 3;
    if (bc) score += Math.min(bc, 3) * (t.length >= 3 ? 3 : 2);
  }
  return score;
}

function snippet(doc, terms, q) {
  const text = clean(doc.text);
  let pos = -1, len = 0;
  for (const t of [...terms, normalize(q).replace(/\s+/g, '')]) {
    const i = text.toLowerCase().indexOf(String(t).toLowerCase());
    if (i !== -1 && (pos === -1 || i < pos)) { pos = i; len = String(t).length; }
  }
  if (pos === -1) return clip(text, 150);
  const start = Math.max(0, pos - 55);
  const end = Math.min(text.length, pos + len + 95);
  return `${start ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`;
}

function search(query, limit) {
  const q = clean(query);
  if (!q) return [];
  const terms = termsOf(q);
  if (!terms.length && !q) return [];
  return docs
    .filter((doc) => doc.id !== 'OVERVIEW')
    .map((doc) => ({ doc, score: scoreDoc(doc, normalize(q), terms) }))
    .filter((x) => x.score >= 6)
    .sort((a, b) => b.score - a.score || a.doc.id.localeCompare(b.doc.id))
    .slice(0, Math.min(10, Math.max(1, limit || 5)))
    .map((x) => ({ ...x.doc, score: x.score, snippet: snippet(x.doc, terms, q) }));
}

function findDoc(id) {
  const key = clean(id).toUpperCase();
  if (!key) return null;
  return docs.find((d) => d.id === key) || docs.find((d) => d.id.includes(key));
}

function header() {
  return `大肥鱼调试编年史｜${data.span}｜${data.days} 天｜${data.phases.length} 段主线｜${data.incidents.length} 起事故`;
}

function overviewText() {
  const phases = data.phases.map((p) => `${p.id}｜${p.date}｜${clip(p.title, 26)}`).join('\n');
  const incs = data.incidents.map((i) => `${i.id} ${clip(i.name, 14)}${i.flag ? `（${i.flag}）` : ''}`).join('；');
  return [
    header(),
    `版本：0.4.0 → dfy.1~6 → 0.5.1；现役 memory-plus 2.12.0 / topic-ledger 1.2.9 / affinity 1.7.1。`,
    '',
    '主线十一句：',
    phases,
    '',
    `事故十起：${incs}`,
    '',
    '查细节：dfy-chronicle__chronicle_search(关键词) 或 dfy-chronicle__chronicle_get(P3/I7/N2)；要长图：dfy-chronicle__chronicle_send_image。'
  ].join('\n');
}

function detailText(doc) {
  if (!doc) return '没有这个编号。可用 P1~P13、I1~I10、N1~N8、R1~R7、E1~E3、O1~O6，或 OVERVIEW。';
  const head = `[${doc.id}｜${doc.kind}] ${doc.title}${doc.date ? `｜${doc.date}` : ''}`;
  return `${head}\n${clip(doc.text, 1400)}`;
}

function registerTools(a) {
  a.registerTool({
    id: 'chronicle_overview',
    name: '调试编年史总览',
    description: '本机大肥鱼 2026-10-27→11-27 的调试编年史总览：32 天、8 个版本号、13 段主线、10 起事故、32 条入档。'
      + '问「以前调试过什么」「总共出过哪些事故」「版本怎么演进」时先用它建立时间轴。',
    category: 'memory',
    icon: '📜',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try { return { content: clip(overviewText(), 1500) }; } catch (e) { return { content: `读编年史失败：${e?.message ?? e}`, isError: true }; }
    }
  });

  a.registerTool({
    id: 'chronicle_search',
    name: '调试编年史搜索',
    description: '在调试编年史里按关键词搜（日期、插件名、报错、现象、指标都行），返回命中的段落编号、标题、时间、摘要和证据。'
      + '问「上次 OneBot 掉线怎么修的」「缓存命中怎么从 48 到 75」「dfy.6 改了什么」这类历史问题时用；搜到编号再用 chronicle_get 取全文。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，如 OneBot、缓存、看图、dfy.6、11-08、resources\\app' },
        limit: { type: 'number', description: '返回几条，默认 5，最多 10' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const q = clean(args?.query);
        if (!q) return { content: '缺少 query：要搜什么？', isError: true };
        const hits = search(q, Number(args?.limit) || settings().maxResults);
        if (!hits.length) return { content: `编年史里没搜到「${q}」。换个更短的关键词，或先 chronicle_overview。` };
        const text = hits.map((h) => `[${h.id}｜${h.kind}${h.date ? `｜${h.date}` : ''}] ${h.title}\n${clip(h.snippet, 160)}`).join('\n\n');
        return { content: `${clip(text, 1600)}\n\n展开某条：dfy-chronicle__chronicle_get(编号)。` };
      } catch (e) { return { content: `搜编年史失败：${e?.message ?? e}`, isError: true }; }
    }
  });

  a.registerTool({
    id: 'chronicle_get',
    name: '调试编年史详情',
    description: '按编号取编年史全文：P1~P13 主线段落、I1~I10 事故、N1~N8 数字、R1~R7 定型口径、E1~E3 证据地图、O1~O6 未决项、OVERVIEW 总览。'
      + '先 chronicle_search 拿编号，再取全文；回答要带日期和证据出处。',
    category: 'memory',
    icon: '📖',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '编号，如 P3、I7、N2、R4、O1、OVERVIEW' } },
      required: ['id']
    },
    async execute(ctx, args) {
      try {
        const doc = findDoc(args?.id);
        return { content: detailText(doc) };
      } catch (e) { return { content: `取编年史失败：${e?.message ?? e}`, isError: true }; }
    }
  });

  a.registerTool({
    id: 'chronicle_send_image',
    name: '发调试编年史长图',
    description: '把《大肥鱼调试编年史》整页长图发到当前会话。用户说「发编年史长图」「看看这张图」「把编年史发我」时用。',
    category: 'media',
    icon: '🖼️',
    parameters: {
      type: 'object',
      properties: { chatKey: { type: 'string', description: '可选；不填就发当前会话' } },
      required: []
    },
    async execute(ctx, args) {
      try {
        const chatKey = clean(args?.chatKey || ctx?.chatKey);
        if (!chatKey) return { content: '不知道发哪个会话：当前上下文没有 chatKey。', isError: true };
        if (!fs.existsSync(IMAGE_FILE)) return { content: '编年史长图文件不在，先重新生成。', isError: true };
        if (!ctx?.sender?.sendImage) return { content: '当前上下文不能发图。', isError: true };
        await ctx.sender.sendImage(chatKey, { file: IMAGE_FILE }, { note: '大肥鱼调试编年史长图' });
        return { content: '编年史长图已发到当前会话。' };
      } catch (e) { return { content: `发长图失败：${e?.message ?? e}`, isError: true }; }
    }
  });
}

function registerCommand(a) {
  try {
    a.registerCommand('/编年史', async ({ args }) => {
      const q = clean(args);
      if (!q) return clip(overviewText(), 1200);
      const hits = search(q, 5);
      if (!hits.length) return `编年史里没搜到「${q}」。发「/编年史」看总览。`;
      return clip(hits.map((h) => `[${h.id}｜${h.date || h.kind}] ${h.title}\n${clip(h.snippet, 120)}`).join('\n\n'), 1200);
    });
  } catch (e) { warn('注册 /编年史 指令失败：', e?.message ?? e); }
}

export function setup(a) {
  api = a;
  loadData();
  try { registerTools(a); } catch (e) { warn('注册编年史工具失败：', e?.message ?? e); throw e; }
  registerCommand(a);
}

export function activate() { log('调试编年史已启用（只读检索，不注入提示词）'); }
export function deactivate() {}

export const providers = {
  'dfy-chronicle.status': () => {
    try {
      return { ok: true, phases: data?.phases.length || 0, incidents: data?.incidents.length || 0, docs: docs.length };
    } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  }
};
