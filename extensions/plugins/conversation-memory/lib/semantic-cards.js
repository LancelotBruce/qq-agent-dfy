// 语义卡片 v2：从「正则命中就存」升级为「先判类型/重要性，再决定记不记」。
//
// 记忆分三层，这张卡是中间层：
//   长期画像（digest，每轮注入，硬预算）  ← 由卡片压出来
//   语义卡片（命中才注入，最多几条）        ← 本文件
//   小时块/原始记录（只有检索时才读）
//
// 本文件只做**本地**判断（不调模型）：类型 / 重要性 / 关键词 / 过期时间。
// 模型的细粒度分析在 analyzer.js（B 阶段），写回来的也是同一套卡片结构。
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 2;
const MAX_CARDS = 400;

const TTL_DAYS = { task: 7, plan: 14, fact: 60, conflict: 3, topic: 5 };
const TYPE_LABEL = { task: '待办', plan: '约定', fact: '设定', conflict: '冲突', topic: '话题' };

// ── 判定用的锚点 ──────────────────────────────────────────────────────────
const PLAN_RE = /(约好|说好|定了|定在|改到|要去|要来|集合|见面|聚餐|开黑|出发|截止|报名|考试|面试|生日|婚礼|上线)/;
const FACT_RE = /(我是|我在|我住|我养|我玩|我学|我专业|我工作|上班|上学|老家|生日是|不吃|忌口|过敏|雷点|本命|口头禅)/;
const TASK_RE = /(帮我|帮忙|记得|提醒|别忘|查一下|搜一下|发我|处理一下|安排一下|确认一下)/;
const CONFLICT_RE = /(吵起来|别骂|针对我|举报|挂人|拉黑|禁言)/;

// 纯情绪 / 语气 / 刷屏，不进卡片
const JUNK_RE = /^(哈+|草|乐|典|6+|嗯+|哦+|啊+|诶+|我去|牛|卧槽|笑死|确实|可以|好的?|行|对|是|？+|\?+)/;

function isQuestion(text) {
  const t = String(text || '').trim();
  if (/[?？]/.test(t)) return true;          // 任何问号都按"未确定"处理，不进记忆
  return /(吗|呢)[\s~～!！。.,，]*$/.test(t);
}

/** 关键词：日期/数字/英文/引号内容 + 计划事实锚点 + 少量中文二元组。 */
export function extractKeywords(text, { limit = 6, extra = [] } = {}) {
  const s = String(text || '');
  const out = [];
  const push = (w) => {
    const v = String(w || '').trim().replace(/[，。！？、：；""''（）()]/g, '');
    if (!v || v.length < 2 || v.length > 12) return;
    if (out.includes(v)) return;
    out.push(v);
  };
  for (const w of extra) push(w);
  // 只收「确定性强」的词：日期/时刻/英文/引号内容 + 计划事实锚点。
  // 不做中文二元组硬切 —— 没有分词器时切出来的多半是「好周」「理员」这种噪声，
  // 检索时标题本身已经参与匹配，不需要靠噪声关键词补。
  for (const m of s.matchAll(/\d{1,2}月\d{1,2}[日号]?|\d{1,2}[点:：]\d{0,2}|\d{4}-\d{1,2}-\d{1,2}|[a-z][a-z0-9_+-]{2,}/gi)) push(m[0]);
  for (const m of s.matchAll(/[「『"“]([^」』"”]{2,12})[」』"”]/g)) push(m[1]);
  for (const m of s.matchAll(/(约好|说好|定在|集合|聚餐|开黑|考试|面试|生日|截止|报名|体检|搬家|出差|上线)/g)) push(m[1]);
  return out.slice(0, limit);
}

function clampImp(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return 2;
  return Math.min(5, Math.max(1, Math.round(v)));
}

function ttlOf(type) {
  return TTL_DAYS[type] || 7;
}

function normalizeTitle(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function cardKey(type, chatKey, title) {
  return type + '|' + chatKey + '|' + normalizeTitle(title).toLowerCase().slice(0, 60);
}

/** 本地判定一条消息值不值得记；返回卡片字段或 null。 */
export function scoreSnippet(snippet) {
  const text = normalizeTitle(snippet?.text);
  if (text.length < 6 || text.length > 140) return null;
  if (/^\[(图片|表情|贴图|语音|视频|合并转发)/.test(text)) return null;
  if (JUNK_RE.test(text) && text.length < 14) return null;
  if ((text.match(/[?？]/g) || []).length >= 2) return null;
  if (isQuestion(text)) return null;          // 问句不是"已成立的事实/约定"

  const hasTask = TASK_RE.test(text);
  const hasPlan = PLAN_RE.test(text);
  const hasFact = FACT_RE.test(text);
  const hasConflict = CONFLICT_RE.test(text);
  if (!hasTask && !hasPlan && !hasFact && !hasConflict) return null;

  const type = hasTask ? 'task' : hasPlan ? 'plan' : hasFact ? 'fact' : 'conflict';
  let importance = 2;
  if (hasTask) importance += 1;
  if (hasPlan) importance += 1;
  if (hasFact) importance += 1;
  if (/\d{1,2}[点:：]|\d{1,2}月|\d{4}-\d{1,2}-\d{1,2}/.test(text)) importance += 1;
  if (text.length >= 30) importance += 1;
  if (hasConflict) importance -= 1;
  importance = clampImp(importance);

  const who = snippet?.self ? '我' : String(snippet?.who || '');
  const when = Number(snippet?.ts) || Date.now();
  return {
    type,
    title: text.slice(0, 60),
    detail: (who ? who + ': ' : '') + text.slice(0, 160),
    keywords: extractKeywords(text),
    people: who && who !== '?' ? [who] : [],
    importance,
    ts: when,
    expiresAt: when + ttlOf(type) * 86400000
  };
}

export class SemanticCardStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'cards.json');
    ensure(this.root);
    const raw = readJson(this.file, { version: VERSION, cards: [] });
    // v1 的卡片是旧两条正则堆出来的（实测 6 张里 6 张是问句误判），
    // 直接整批丢弃；新规则会从后续巩固里重新长出来，也会在 B 阶段由模型补。
    const legacy = Number(raw?.version) < VERSION;
    this.cards = legacy ? [] : (Array.isArray(raw.cards) ? raw.cards : []);
    this.#migrate();
    if (legacy) this.save();
  }

  /** v1 → v2 兼容 + 清掉历史误判（问句/太短/纯语气）。 */
  #migrate() {
    let changed = false;
    const out = [];
    for (const c of this.cards) {
      if (!c || typeof c !== 'object') { changed = true; continue; }
      const type = TYPE_LABEL[c.type] ? c.type : 'topic';
      const title = normalizeTitle(c.title);
      const detail = String(c.detail || '');
      const junk = !title
        || title.length < 8
        || /^\[(图片|表情)/.test(title)
        || JUNK_RE.test(title)
        || /[?？]/.test(title)           // 问句不是已成立的事实
        || isQuestion(title);            // ← 旧版把「…是你的生日吗？」记成计划，正是在这里清掉
      if (junk) { changed = true; continue; }
      const ts = Number(c.lastTs) || Number(c.firstTs) || Date.now();
      const next = {
        key: c.key || cardKey(type, c.chatKey, title),
        type,
        chatKey: String(c.chatKey || ''),
        title,
        detail,
        tags: Array.isArray(c.tags) ? c.tags.slice(0, 8) : [],
        keywords: Array.isArray(c.keywords) && c.keywords.length ? c.keywords.slice(0, 6) : extractKeywords(title),
        people: Array.isArray(c.people) ? c.people.slice(0, 5) : [],
        importance: clampImp(c.importance ?? 3),
        hits: Math.max(1, Number(c.hits) || 1),
        firstTs: Number(c.firstTs) || ts,
        lastTs: ts,
        expiresAt: Number(c.expiresAt) || ts + ttlOf(type) * 86400000,
        source: c.source === 'llm' ? 'llm' : 'local'
      };
      if (!c.key || c.importance === undefined) changed = true;
      out.push(next);
    }
    this.cards = out;
    if (changed) this.save();
  }

  save() {
    const now = Date.now();
    let cards = this.cards.filter((c) => !(c.expiresAt && c.expiresAt < now));
    cards.sort((a, b) => (b.importance || 2) - (a.importance || 2) || (b.lastTs || 0) - (a.lastTs || 0));
    if (cards.length > MAX_CARDS) cards = cards.slice(0, MAX_CARDS);
    this.cards = cards;
    atomicWrite(this.file, { version: VERSION, cards: this.cards, savedAt: now });
  }

  #find(key) {
    return this.cards.find((c) => c.key === key);
  }

  upsert({ type, chatKey, title, detail, tags = [], keywords = [], people = [], importance = 2, ttlDays = 0, source = 'local', ts = Date.now() } = {}) {
    const t = normalizeTitle(title).slice(0, 80);
    if (!t || !chatKey) return null;
    const ty = TYPE_LABEL[type] ? type : 'topic';
    const k = cardKey(ty, chatKey, t);
    const when = Number(ts) || Date.now();
    const existing = this.#find(k);
    if (existing) {
      // 同一小时块会被反复巩固：同一句话重复进卡不能反复加 hits，
      // 否则「刷屏过的内容」会被自己的重复计数推到画像最前面。
      if (when > (existing.lastTs || 0)) existing.hits = (existing.hits || 1) + 1;
      existing.lastTs = Math.max(existing.lastTs || 0, when);
      existing.importance = Math.max(existing.importance || 2, clampImp(importance));
      if (detail) existing.detail = String(detail).slice(0, 200);
      if (keywords?.length) existing.keywords = [...new Set([...(existing.keywords || []), ...keywords])].slice(0, 6);
      if (people?.length) existing.people = [...new Set([...(existing.people || []), ...people])].slice(0, 5);
      if (tags?.length) existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 8);
      if (source === 'llm') existing.source = 'llm';
      this.save();
      return existing;
    }
    const card = {
      key: k,
      type: ty,
      chatKey: String(chatKey),
      title: t,
      detail: String(detail || '').slice(0, 200),
      tags: (tags || []).map(String).slice(0, 8),
      keywords: [...new Set((keywords || []).map(String))].slice(0, 6),
      people: [...new Set((people || []).map(String))].slice(0, 5),
      importance: clampImp(importance),
      hits: 1,
      firstTs: when,
      lastTs: when,
      expiresAt: when + (Number(ttlDays) > 0 ? Number(ttlDays) : ttlOf(ty)) * 86400000,
      source: source === 'llm' ? 'llm' : 'local'
    };
    this.cards.push(card);
    this.save();
    return card;
  }

  /** 巩固小时块时调用：本地判定，只收「已成立」的约定/事实/待办。 */
  ingestChunk(chunk = {}) {
    const chatKey = String(chunk.chatKey || '');
    const snippets = Array.isArray(chunk.snippets) ? chunk.snippets : [];
    if (!chatKey || !snippets.length) return 0;
    let n = 0;
    for (const s of snippets) {
      if (s?.self) continue;   // 机器人自己的话是生成物，不是事实来源：把它的玩笑当记忆会污染画像
      let scored = null;
      try { scored = scoreSnippet(s); } catch { scored = null; }
      if (!scored) continue;
      this.upsert({ ...scored, chatKey, source: 'local' });
      n += 1;
    }
    return n;
  }

  /** 兼容旧调用（只有 chatKey + snippets，没有块信息）。 */
  ingestHour(chatKey, snippets = []) {
    return this.ingestChunk({ chatKey, snippets });
  }

  /** B 阶段：把模型分析结果写回卡片（点 + 可选话题）。 */
  ingestAnalysis(chunk = {}, result = {}) {
    const chatKey = String(chunk.chatKey || '');
    if (!chatKey) return 0;
    const baseTs = Number((chunk.snippets || []).slice(-1)[0]?.ts) || Date.now();
    let n = 0;
    for (const p of Array.isArray(result.points) ? result.points.slice(0, 3) : []) {
      const text = normalizeTitle(p?.text);
      if (!text || text.length < 4) continue;
      if (clampImp(p?.importance) < 2) continue;   // 模型自己都标成"玩笑/水聊"的，不记
      const type = TYPE_LABEL[p?.type] ? p.type : 'topic';
      const keywords = Array.isArray(p?.keywords) && p.keywords.length ? p.keywords.slice(0, 6) : extractKeywords(text);
      this.upsert({
        type,
        chatKey,
        title: text.slice(0, 80),
        detail: (chunk.hourKey ? '[' + chunk.hourKey + '] ' : '') + text,
        keywords,
        people: Array.isArray(result.people) ? result.people.slice(0, 5) : [],
        importance: clampImp(p?.importance ?? result.importance ?? 2),
        source: 'llm',
        ts: baseTs
      });
      n += 1;
    }
    // 整块只有话题价值时，留一张话题卡（可检索，不进画像）
    if (!n && Number(result.importance) >= 3 && normalizeTitle(result.summary).length >= 6) {
      this.upsert({
        type: 'topic',
        chatKey,
        title: normalizeTitle(result.summary).slice(0, 80),
        detail: (chunk.hourKey ? '[' + chunk.hourKey + '] ' : '') + normalizeTitle(result.summary),
        keywords: Array.isArray(result.keywords) ? result.keywords.slice(0, 6) : [],
        people: Array.isArray(result.people) ? result.people.slice(0, 5) : [],
        importance: clampImp(result.importance),
        source: 'llm',
        ts: baseTs
      });
      n += 1;
    }
    return n;
  }

  /** 按触发文本匹配（过期卡不参与）。 */
  match(query, { chatKey = null, limit = 4, now = Date.now(), minImportance = 2 } = {}) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const words = q.match(/[一-鿿]{2,}|[a-z0-9_]{3,}/g) || [];
    const scored = [];
    for (const c of this.cards) {
      if (c.expiresAt && c.expiresAt < now) continue;
      if ((c.importance || 2) < minImportance) continue;
      if (chatKey && c.chatKey !== chatKey) continue;
      const hay = (c.title + ' ' + (c.detail || '') + ' ' + (c.keywords || []).join(' ') + ' ' + (c.tags || []).join(' ')).toLowerCase();
      let score = 0;
      for (const w of words) if (hay.includes(w)) score += 3;
      if (hay.includes(q.slice(0, 12))) score += 4;
      const ageH = Math.max(1, (now - (c.lastTs || 0)) / 3600000);
      score += ((c.importance || 2) - 1) * 1.5 + Math.min(3, (c.hits || 1) / 2) / Math.log2(ageH + 1);
      if (score > 2.5) scored.push({ score, card: c });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit)).map(({ card, score }) => ({
      type: card.type,
      title: card.title,
      detail: card.detail,
      keywords: card.keywords || [],
      importance: card.importance,
      when: new Date(card.lastTs || now).toISOString().slice(0, 16).replace('T', ' '),
      score: Math.round(score * 10) / 10,
      chatKey: card.chatKey
    }));
  }

  /**
   * 长期画像：把卡片压成固定预算的短文本（每轮注入用）。
   * 只保留未过期、importance>=2 的卡；按「重要度 → 新鲜度」排序，按类型分组。
   */
  buildDigest({ chatKey = null, maxChars = 400, now = Date.now() } = {}) {
    const cap = Math.max(120, Math.min(800, Number(maxChars) || 400));
    const pick = this.cards
      .filter((c) => (!chatKey || c.chatKey === chatKey))
      .filter((c) => !(c.expiresAt && c.expiresAt < now))
      .filter((c) => (c.importance || 2) >= 3)
      .sort((a, b) => (b.importance || 2) - (a.importance || 2) || (b.lastTs || 0) - (a.lastTs || 0));
    const groups = { task: [], plan: [], fact: [], topic: [] };
    const seen = new Set();
    for (const c of pick) {
      const key = normalizeTitle(c.title).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      (groups[c.type] || groups.topic).push(c);
    }
    const lines = [];
    let used = 0;
    for (const type of ['task', 'plan', 'fact', 'topic']) {
      const arr = groups[type] || [];
      if (!arr.length) continue;
      const head = '【' + TYPE_LABEL[type] + '】';
      for (const c of arr) {
        const d = new Date(c.lastTs || now);
        const md = String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
        const raw = c.title.replace(/\s+/g, ' ');
        // 原来硬切 42 字，长标题会被拦腰截断成「…@无鲸(QQ:31」这种半句，400 字预算里全是残句。
        // 改成 80 字并在截断处补省略号：宁可少放几条，也不要放读不懂的半句。
        const title = raw.length > 80 ? raw.slice(0, 79) + '…' : raw;
        const line = '- ' + md + ' ' + title;
        if (used + line.length + head.length + 2 > cap) return finish(lines, head, used, cap);
        if (!lines.length || lines[lines.length - 1].head !== head) lines.push({ head, items: [] });
        lines[lines.length - 1].items.push(line);
        used += line.length + 1;
      }
    }
    return render(lines, cap);
  }

  purgeJunk() {
    const before = this.cards.length;
    const now = Date.now();
    this.cards = this.cards.filter((c) => {
      if (c.expiresAt && c.expiresAt < now) return false;
      const t = String(c.title || '');
      if (t.length < 8) return false;
      if (/^\[(图片|表情)/.test(t)) return false;
      if (JUNK_RE.test(t)) return false;
      if (isQuestion(t)) return false;
      return true;
    });
    if (this.cards.length !== before) this.save();
    return before - this.cards.length;
  }

  stats() {
    const byType = {};
    const now = Date.now();
    let active = 0;
    for (const c of this.cards) {
      byType[c.type] = (byType[c.type] || 0) + 1;
      if (!(c.expiresAt && c.expiresAt < now)) active += 1;
    }
    return { cards: this.cards.length, active, byType };
  }
}

function render(lines, cap) {
  const parts = [];
  for (const g of lines) {
    if (!g.items.length) continue;
    parts.push(g.head + '\n' + g.items.join('\n'));
  }
  let text = parts.join('\n');
  if (text.length > cap) text = text.slice(0, cap - 1) + '…';
  return text;
}

function finish(lines, head, used, cap) {
  if (!lines.length) return '';
  return render(lines, cap);
}

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fb) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fb;
  }
}

function atomicWrite(file, data) {
  ensure(path.dirname(file));
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}
