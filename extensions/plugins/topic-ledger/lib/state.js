// 台账状态与落盘：一个账期 = 从 cutoff 到下一个 cutoff（默认 02:00 → 次日 02:00）。
// 事件链按「会话内时间连续」切分：同一会话里相邻两条消息间隔 ≤ silenceMin 就并进同一条链。
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_ROOT, STATE_FILE, ARCHIVE_DIR } from './paths.js';
import { readJson, writeJson, chatKindOf, chatIdOf } from './archive.js';

export function pad(n) { return String(n).padStart(2, '0'); }

export function localDayKey(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function clockOf(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 最近的 cutoff 时刻（<= now）。cutoff 形如 "02:00"。 */
export function windowStartOf(now = Date.now(), cutoff = '02:00') {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(cutoff || '02:00').trim());
  const hh = m ? Math.min(23, Math.max(0, Number(m[1]))) : 2;
  const mm = m ? Math.min(59, Math.max(0, Number(m[2]))) : 0;
  const d = new Date(Number(now) || Date.now());
  const at = (dayOffset) => {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + dayOffset, hh, mm, 0, 0);
    return x.getTime();
  };
  const today = at(0);
  return Number(now) >= today ? today : at(-1);
}

export function emptyState(now = Date.now(), cutoff = '02:00') {
  const start = windowStartOf(now, cutoff);
  return {
    version: 1,
    windowStart: start,
    windowLabel: localDayKey(start),
    cursors: {},
    chatSeq: {},
    chains: [],
    budget: { day: localDayKey(now), calls: 0, promptTokens: 0, completionTokens: 0 }
  };
}

export function loadState(now = Date.now(), cutoff = '02:00') {
  const raw = readJson(STATE_FILE, null);
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.chains)) return emptyState(now, cutoff);
  const st = { ...emptyState(now, cutoff), ...raw };
  st.cursors = st.cursors && typeof st.cursors === 'object' ? st.cursors : {};
  st.chatSeq = st.chatSeq && typeof st.chatSeq === 'object' ? st.chatSeq : {};
  st.budget = st.budget && typeof st.budget === 'object' ? st.budget : { day: localDayKey(now), calls: 0 };
  if (st.budget.day !== localDayKey(now)) st.budget = { day: localDayKey(now), calls: 0, promptTokens: 0, completionTokens: 0 };
  return st;
}

export function saveState(state) {
  return writeJson(STATE_FILE, state);
}

function chainKeyOf(chatKey, seq) {
  return `${chatKey}#${seq}`;
}

function newChain(state, chatKey, firstMsg, now) {
  const seq = (Number(state.chatSeq[chatKey]) || 0) + 1;
  state.chatSeq[chatKey] = seq;
  const chain = {
    id: chainKeyOf(chatKey, seq),
    seq,
    chatKey,
    kind: chatKindOf(chatKey),
    chatId: chatIdOf(chatKey),
    title: '',
    status: 'open',
    startTs: firstMsg.ts,
    lastTs: firstMsg.ts,
    starter: { uid: firstMsg.uid, name: firstMsg.who },
    count: 0,
    msgs: [],
    mids: [],
    facts: [],
    decided: [],
    pending: [],
    promises: [],
    quotes: [],
    mood: '',
    changes: [],
    counterparts: [],
    draftedAt: 0,
    updatedAt: 0,
    finalizedAt: 0,
    draftedCount: 0,
    memoryWritten: false,
    lastError: ''
  };
  state.chains.push(chain);
  return chain;
}

function pushMsg(chain, msg) {
  chain.count += 1;
  chain.lastTs = Math.max(chain.lastTs, msg.ts);
  chain.msgs.push({
    id: msg.id, ts: msg.ts, uid: msg.uid, who: msg.who, self: msg.self,
    text: msg.text.slice(0, 300), mid: msg.mid != null ? String(msg.mid) : '',
    at: Array.isArray(msg.at) ? msg.at : [], reply: msg.reply || null
  });
  if (chain.msgs.length > 120) chain.msgs = chain.msgs.slice(-100);
  if (!Array.isArray(chain.mids)) chain.mids = [];
  if (msg.mid != null && msg.mid !== '') chain.mids.push(String(msg.mid));
  if (chain.mids.length > 2000) chain.mids = chain.mids.slice(-1500);
  chain.counterparts = pairSummary(chain.msgs, { privateChat: chain.kind === 'private' });
}

/**
 * 这条链里谁在跟谁说：只认明确的 @ 和引用回复。
 * 私聊没有 @ 时按「回上一句」补一对，群聊不猜，免得把闲聊串成关系。
 */
export function pairSummary(msgs, { privateChat = false, limit = 3 } = {}) {
  const weight = { 引用: 2.2, '@': 2, 接话: 1 };
  const map = new Map();
  let prev = null;
  for (const m of Array.isArray(msgs) ? msgs : []) {
    if (!m || !m.who) continue;
    const targets = [];
    for (const n of Array.isArray(m.at) ? m.at : []) {
      if (n && n !== m.who) targets.push({ to: n, via: '@' });
    }
    const rs = m.reply?.sender;
    if (rs && rs !== m.who) targets.push({ to: rs, via: '引用' });
    if (!targets.length && privateChat && prev && prev.who !== m.who) targets.push({ to: prev.who, via: '接话' });
    for (const t of targets) {
      const key = `${m.who}→${t.to}`;
      const cur = map.get(key) || { from: m.who, to: t.to, via: t.via, count: 0 };
      cur.count += 1;
      if (t.via !== '接话') cur.via = t.via;
      map.set(key, cur);
    }
    prev = m;
  }
  return [...map.values()]
    .sort((a, b) => (weight[b.via] || 1) * b.count - (weight[a.via] || 1) * a.count || b.count - a.count)
    .slice(0, limit);
}

/** 中文双字片段，用来判断两段话是不是同一个话题。 */
function bigrams(text) {
  const s = String(text || '')
    .replace(/^\[引用[^\]]*\]\s*/, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9]/g, '');
  const set = new Set();
  for (let i = 0; i < s.length - 1; i += 1) set.add(s.slice(i, i + 2));
  return set;
}

function overlapCount(a, b) {
  let n = 0;
  for (const x of a) if (b.has(x)) n += 1;
  return n;
}

/** 连续三条跟前面二十条几乎不共用词、又没 @ 老熟人，就当换了话题。 */
function topicShift(chain, msg) {
  if (msg.self) return false;
  const text = String(msg.text || '');
  if (text.length < 10) return false;
  if (Array.isArray(msg.at) && msg.at.length) return false;
  const recent = (chain.msgs || []).filter((m) => !m.self).slice(-20);
  if (recent.length < 10) return false;
  const mine = bigrams(text);
  if (mine.size < 5) return false;
  const pooled = new Set();
  for (const m of recent) for (const x of bigrams(m.text)) pooled.add(x);
  const overlap = overlapCount(mine, pooled);
  // 重合率不到 20% 才算离题；同义改写、换个名词不会被误切。
  return overlap / mine.size < 0.2;
}

/** 活跃时长：只累计相邻消息间隔 ≤10 分钟的时段，中间长时间没人说话不算。 */
function activeSpanMs(chain) {
  const list = (chain?.msgs || []).filter((m) => Number.isFinite(Number(m?.ts))).slice().sort((a, b) => a.ts - b.ts);
  let sum = 0;
  for (let i = 1; i < list.length; i++) {
    const d = Number(list[i].ts) - Number(list[i - 1].ts);
    if (d > 0 && d <= 10 * 60000) sum += d;
  }
  return sum;
}

/**
 * 把新消息并进事件链。
 * @returns {{added:number, touched:string[]}}
 */
export function ingestMessages(state, chatKey, msgs, {
  silenceMin = 10, maxMessages = 80, maxSpanMin = 90, now = Date.now()
} = {}) {
  const gap = Math.max(3, Number(silenceMin) || 10) * 60000;
  const capMsgs = Math.max(20, Number(maxMessages) || 80);
  const capSpan = Math.max(20, Number(maxSpanMin) || 90) * 60000;
  // 软上限只做标记，不立即切；真到硬上限才兜底，避免话题聊到一半被刀切。
  const hardMsgs = Math.max(capMsgs + 20, capMsgs * 2);
  const hardSpan = Math.max(capSpan + 10 * 60000, capSpan * 2);
  // 链太长/跨太久，就强制分段，别把一晚上的事塞成一条
  const split = (chain, msg, reason) => {
    chain.status = 'closed';
    chain.closedAt = chain.lastTs;
    chain.splitReason = reason;
    const fresh = newChain(state, chatKey, msg, now);
    fresh.continuedFrom = chain.id;
    chain.continuedTo = fresh.id;
    return fresh;
  };
  let changed = 0;
  const touched = [];
  for (const msg of msgs) {
    if (msg.recalled === true) continue;
    // 引用回复：哪怕隔了一小时，只要引的是本账期某条链里的消息，就并回那条链继续聊。
    const replyMid = msg.reply && msg.reply.mid != null ? String(msg.reply.mid) : '';
    if (replyMid) {
      const target = state.chains.find((c) => c.chatKey === chatKey
        && Array.isArray(c.mids) && c.mids.includes(replyMid));
      // 引用只用来回绑「还没撑满的小链」；大链不再往里塞，否则通宵聊一夜会被引用串回同一条
      const canRebind = target
        && (Number(target.count) || 0) < capMsgs
        && activeSpanMs(target) < capSpan;
      if (target && canRebind) {
        if (target.status !== 'open') {
          target.status = 'open';
          target.closedAt = 0;
          target.finalizedAt = 0;
          target.lastError = '';
        }
        pushMsg(target, msg);
        changed += 1;
        touched.push(chatKey);
        continue;
      }
    }
    // 没有引用可回绑时，并进最近还在动的那个进行中链
    const open = state.chains
      .filter((c) => c.chatKey === chatKey && c.status === 'open')
      .sort((a, b) => b.lastTs - a.lastTs)[0];
    if (!open) {
      pushMsg(newChain(state, chatKey, msg, now), msg);
      changed += 1;
      touched.push(chatKey);
      continue;
    }
    if (msg.ts - open.lastTs > gap) {
      const fresh = split(open, msg, 'silence');
      pushMsg(fresh, msg);
      changed += 1;
      touched.push(chatKey);
      continue;
    }
    if (open.count >= hardMsgs || activeSpanMs(open) >= hardSpan) {
      const fresh = split(open, msg, 'cap');
      pushMsg(fresh, msg);
      changed += 1;
      touched.push(chatKey);
      continue;
    }
    if (topicShift(open, msg)) {
      open.noveltyRun = (Number(open.noveltyRun) || 0) + 1;
      // 连续三条都不搭界，才真的切；单条可能是插话，两条可能是换了个说法。
      if (open.noveltyRun >= 3) {
        const fresh = split(open, msg, 'topic');
        fresh.noveltyRun = 0;
        pushMsg(fresh, msg);
        changed += 1;
        touched.push(chatKey);
        continue;
      }
    } else {
      open.noveltyRun = 0;
    }
    pushMsg(open, msg);
    if (Number(open.count) >= capMsgs || activeSpanMs(open) >= capSpan) open.softFull = true;
    changed += 1;
  }
  // 同一会话只留一条进行中链：引用回绑或乱序写入偶尔会开两条，留着会互相截胡。
  const openByChat = new Map();
  for (const c of state.chains) {
    if (c.status !== 'open') continue;
    const cur = openByChat.get(c.chatKey);
    if (!cur || Number(c.lastTs) > Number(cur.lastTs)) openByChat.set(c.chatKey, c);
  }
  for (const c of state.chains) {
    if (c.status !== 'open' || openByChat.get(c.chatKey) === c) continue;
    c.status = 'closed';
    c.closedAt = c.lastTs;
    c.splitReason = c.splitReason || 'parallel';
  }
  return { added: changed, touched };
}

/** 静默到期：把没有新消息的进行中链标成已收尾。 */
export function closeIdleChains(state, { silenceMin = 10, now = Date.now() } = {}) {
  const gap = Math.max(3, Number(silenceMin) || 10) * 60000;
  let closed = 0;
  for (const c of state.chains) {
    if (c.status !== 'open') continue;
    if (Number(now) - Number(c.lastTs) >= gap) {
      c.status = 'closed';
      c.closedAt = c.lastTs;
      closed += 1;
    }
  }
  return closed;
}

export function infoScore(chain) {
  const len = (arr) => (Array.isArray(arr) ? arr.reduce((s, x) => s + String(x).length, 0) : 0);
  return len(chain.promises) * 3.2
    + len(chain.decided) * 2.0
    + len(chain.pending) * 1.6
    + len(chain.facts) * 1.3
    + (chain.mood ? 6 : 0)
    + Math.min(40, len(chain.quotes) * 0.6)
    + Math.min(30, chain.count);
}

/** 数组去重（保持顺序），超过 max 保留最后 max 条（新的优先）。 */
function unionList(base, add, max) {
  const out = Array.isArray(base) ? [...base] : [];
  for (const x of (Array.isArray(add) ? add : [])) {
    const s = String(x ?? '').trim();
    if (!s) continue;
    if (out.includes(s)) continue;
    out.push(s);
  }
  return out.length > max ? out.slice(out.length - max) : out;
}

function unionQuotes(base, add, max = 8) {
  const out = Array.isArray(base) ? [...base] : [];
  for (const q of (Array.isArray(add) ? add : [])) {
    if (!q || !q.text) continue;
    if (out.some((x) => x.text === q.text)) continue;
    out.push({ who: q.who || '?', ts: Number(q.ts) || 0, text: String(q.text).slice(0, 80) });
  }
  return out.length > max ? out.slice(out.length - max) : out;
}

/** 初稿落到链上。 */
/** 中文之间不该留空格（模型偶尔写「我 说…」），顺手抹掉。 */
export function tidyText(value) {
  return String(value ?? '').replace(/([\u4e00-\u9fa5])[ ]+([\u4e00-\u9fa5])/g, '$1$2');
}

export function applyEntry(chain, entry, now = Date.now()) {
  chain.title = tidyText(entry?.title || chain.title || '').slice(0, 16);
  chain.facts = unionList(chain.facts, entry?.facts, 8).map(tidyText);
  chain.decided = unionList(chain.decided, entry?.decided, 6).map(tidyText);
  chain.pending = unionList(chain.pending, entry?.pending, 6).map(tidyText);
  chain.promises = unionList(chain.promises, entry?.promises, 5).map(tidyText);
  chain.quotes = unionQuotes(chain.quotes, entry?.quotes);
  if (entry?.mood) chain.mood = tidyText(entry.mood).slice(0, 60);
  chain.lastError = '';
  chain.draftAttempts = 0;
  chain.draftedAt = now;
  chain.updatedAt = now;
  chain.draftedCount = chain.count;
  return chain;
}

/** 增量补丁落到链上。 */
export function applyPatch(chain, patch, now = Date.now()) {
  chain.lastError = '';
  chain.draftAttempts = 0;
  if (patch?.title) chain.title = tidyText(patch.title).slice(0, 16);
  chain.facts = unionList(chain.facts, patch?.factsAdd, 8).map(tidyText);
  chain.decided = unionList(chain.decided, patch?.decidedAdd, 6).map(tidyText);
  const close = Array.isArray(patch?.pendingClose) ? patch.pendingClose.map((x) => String(x ?? '').trim()) : [];
  chain.pending = unionList(chain.pending, patch?.pendingAdd, 6).map(tidyText).filter((x) => !close.some((c) => c && (x === c || x.includes(c) || c.includes(x))));
  chain.promises = unionList(chain.promises, patch?.promisesAdd, 5).map(tidyText);
  chain.quotes = unionQuotes(chain.quotes, patch?.quotesAdd);
  if (patch?.mood) chain.mood = tidyText(patch.mood).slice(0, 60);
  const notes = Array.isArray(patch?.changes) ? patch.changes.slice(0, 3) : [];
  for (const n of notes) chain.changes.push({ at: now, note: tidyText(n).slice(0, 100) });
  if (chain.changes.length > 12) chain.changes = chain.changes.slice(-10);
  chain.updatedAt = now;
  chain.draftedCount = chain.count;
  return chain;
}

const STATUS_TEXT = { open: '进行中', closed: '已收尾', frozen: '已封版' };

/** 变更里「初稿」这类时间戳噪音不算痕迹，别占字数。 */
export function realChanges(chain) {
  return (chain?.changes || []).filter((c) => String(c?.note || '').trim() && String(c.note).trim() !== '初稿');
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
/** 机器人自己的马甲：正文里一律说「我」，不占字母。 */
const SELF_NAMES = ['机器人', '某用户', '机器人', '小助手', '示例用户—扮演版', '小助手（未开智）', '？！哦鲸鲸！？'];

/** 人物别名：抬头列 A/B/C 是谁，正文只用字母。 */
export function nameAliases(chain) {
  const byName = new Map();
  const byUid = new Map();
  const roster = [];
  const add = (name, uid) => {
    const n = String(name || '').trim();
    if (!n || n === '我') return;
    const u = String(uid || '').replace(/\D/g, '');
    if (byName.has(n)) { if (u && !byUid.has(u)) byUid.set(u, byName.get(n)); return; }
    if (u && byUid.has(u)) { byName.set(n, byUid.get(u)); return; } // 同一个人换了马甲，还是同一个字母
    const alias = LETTERS[roster.length] || `X${roster.length + 1}`;
    byName.set(n, alias);
    if (u) byUid.set(u, alias);
    roster.push({ alias, name: n, uid: u });
  };
  const selfUid = (chain?.msgs || []).find((m) => m.self && m.uid)?.uid || '';
  if (selfUid) byUid.set(String(selfUid), '我');
  for (const m of chain?.msgs || []) if (!m.self) add(m.who, m.uid);
  if (chain?.starter && !chain.starter.self) add(chain.starter.name, chain.starter.uid);
  for (const q of chain?.quotes || []) add(q.who, '');
  // 机器人自己的马甲：只有在链里不是正经成员时才折成「我」
  for (const n of SELF_NAMES) if (!byName.has(n)) byName.set(n, '我');
  // 「示例用户—扮演版」这类带后缀的名字，允许用短名替换（短名不是别人的全名时才加）
  for (const r of roster.slice()) {
    const short = r.name.split(/[—\-·]/)[0].trim();
    if (short && short !== r.name && !byName.has(short)) byName.set(short, r.alias);
  }
  const names = [...byName.keys()].sort((a, b) => b.length - a.length);
  const text = (value) => {
    let s = String(value ?? '');
    // 名字后面常跟 (QQ:123) ，名字换成字母后这段号码也一起收掉
    s = s.replace(/[(（]QQ[:：]\s*\d+[)）]/gi, '');
    for (const n of names) {
      if (n === '我') continue;
      if (byName.get(n) === '我') continue; // 机器人自己的马甲不折成「我」，免得「我是机器人」变成「我是我」
      s = s.split(n).join(byName.get(n));
    }
    return s;
  };
  const who = (name, uid) => {
    const n = String(name || '').trim();
    if (n === '我') return '我';
    const u = String(uid || '').replace(/\D/g, '');
    return byName.get(n) || (u && byUid.get(u)) || n;
  };
  const rosterText = roster.map((r) => `${r.alias} ${r.name}${r.uid ? `(${r.uid})` : ''}`).join('、');
  return { byName, byUid, rosterText, text, who };
}

/** 把 @ 目标（可能是「某用户(QQ:1000000001)」）换成别名。 */
export function aliasTarget(target, aliases) {
  const raw = String(target || '').trim();
  const m = /(\d{5,})/.exec(raw);
  if (m && aliases.byUid.get(m[1])) return aliases.byUid.get(m[1]);
  const name = raw.replace(/\(QQ[:：].*?\)/i, '').trim();
  return aliases.who(name);
}

/** 「谁在跟谁说」的一行摘要：只写明确的 @ / 引用（私聊补「接话」）。 */
export function pairLine(chain) {
  const pairs = Array.isArray(chain?.counterparts) ? chain.counterparts : [];
  if (!pairs.length) return '';
  const al = nameAliases(chain);
  const merged = new Map();
  for (const p of pairs) {
    const tag = p.via === '@' ? '（@）' : p.via === '引用' ? '（引用）' : '';
    const key = `${al.who(p.from)}→${aliasTarget(p.to, al)}${tag}`;
    const row = merged.get(key) || { from: al.who(p.from), to: aliasTarget(p.to, al), tag, count: 0 };
    row.count += Number(p.count) || 1;
    merged.set(key, row);
  }
  return [...merged.values()].map((p) => `${p.from} → ${p.to}${p.tag}${p.count > 1 ? ` ${p.count} 次` : ''}`).join('、');
}

/** 同一份对话关系统计，但保留真名（给模型看的工具输出用）。 */
export function pairLineRaw(chain) {
  const pairs = Array.isArray(chain?.counterparts) ? chain.counterparts : [];
  if (!pairs.length) return '';
  const merged = new Map();
  for (const p of pairs) {
    const tag = p.via === '@' ? '（@）' : p.via === '引用' ? '（引用）' : '';
    const to = String(p.to || '').replace(/\(QQ[:：].*?\)/i, '').trim();
    const key = `${p.from}→${to}${tag}`;
    const row = merged.get(key) || { from: p.from, to, tag, count: 0 };
    row.count += Number(p.count) || 1;
    merged.set(key, row);
  }
  return [...merged.values()].map((p) => `${p.from} → ${p.to}${p.tag}${p.count > 1 ? ` ${p.count} 次` : ''}`).join('、');
}

export function chainTitle(chain) {
  return String(chain.title || '').trim() || `（未命名）${chain.msgs[0]?.text?.slice(0, 12) || ''}`;
}

/** 一条链的纯文本详情（给模型/工具用，保留真名——它要靠真名决定怎么称呼）。 */
export function chainDetail(chain) {
  const lines = [];
  lines.push(`【${chain.id}】${chainTitle(chain)}｜${STATUS_TEXT[chain.status] || chain.status}｜${clockOf(chain.startTs)}–${clockOf(chain.lastTs)}｜${chain.chatKey}`);
  const who = new Map();
  for (const m of chain.msgs || []) if (m.uid) who.set(m.uid, m.who);
  if (who.size) lines.push('参与：' + [...who.entries()].map(([uid, name]) => `${name}(${uid})`).join('、'));
  const pairs = pairLineRaw(chain);
  if (pairs) lines.push('对话：' + pairs);
  if (chain.facts.length) lines.push('事实：' + chain.facts.join('；'));
  if (chain.decided.length) lines.push('已定：' + chain.decided.join('；'));
  if (chain.pending.length) lines.push('未决：' + chain.pending.join('；'));
  if (chain.promises.length) lines.push('约定：' + chain.promises.join('；'));
  if (chain.quotes.length) lines.push('原话：' + chain.quotes.slice(-4).map((q) => `${q.who} ${clockOf(q.ts)}「${q.text}」`).join(' '));
  if (chain.mood) lines.push('情绪：' + chain.mood);
  if (realChanges(chain).length) lines.push('变更：' + realChanges(chain).slice(-3).map((c) => `${clockOf(c.at)} ${c.note}`).join('；'));
  lines.push(`消息 ${chain.count} 条${chain.memoryWritten ? '｜已写进长期记忆' : ''}`);
  return lines.join('\n');
}

/** 一行极短索引（注入提示词用）。 */
export function chainIndexLine(chain) {
  const bits = [];
  if (chain.facts.length) bits.push(chain.facts[0]);
  if (chain.decided.length) bits.push('已定' + chain.decided[0]);
  if (chain.pending.length) bits.push('未决' + chain.pending[0]);
  if (chain.promises.length) bits.push('约定' + chain.promises[0]);
  const tail = bits.join('/').slice(0, 70);
  return `${chain.title ? chainTitle(chain) : chain.id}${tail ? '：' + tail : ''}`;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

/**
 * 碎片归并：把「消息少、离上一条结束又近、还没留下未决/约定」的小链并进前一条。
 *
 * 为什么并：这类碎片单独占一次终稿、单独占封版写长期记忆的名额，还会被当成
 * 「上一条已收尾」注入提示词，让她把不相干的话题当上下文接着聊。
 * 并的时候在上一条正文里留一句「话题转到：xxx」，后面两段各说各的，分得清。
 *
 * 不并的四种情况：不是碎片（消息够多）、上一条也是碎片、隔着太久不是同一段闲聊、
 * 这条有未决或约定（并进去会张冠李戴）、已经写进长期记忆（改了会对不上）。
 */
export function mergeFragments(state, { maxMsgs = 8, gapMin = 90 } = {}) {
  const maxCount = Math.max(2, Number(maxMsgs) || 8);
  const gap = Math.max(10, Number(gapMin) || 90) * 60000;
  if (!Array.isArray(state.mergedChains)) state.mergedChains = [];
  let merged = 0;

  for (const chatKey of [...new Set(state.chains.map((c) => c.chatKey))]) {
    const list = state.chains
      .filter((c) => c.chatKey === chatKey)
      .sort((a, b) => Number(a.startTs) - Number(b.startTs));

    for (let i = 1; i < list.length; i += 1) {
      const prev = list[i - 1];
      const cur = list[i];
      if (!prev || !cur) continue;
      if (!cur.finalizedAt) continue;
      if (cur.status === 'open' || prev.status === 'open') continue;
      if (cur.status === 'frozen' || prev.status === 'frozen') continue;
      // 续接链：到上限被迫分出来的下一段，内容本来是一件事，间隔 10 分钟内直接并回去。
      const isCont = Boolean(cur.continuedFrom && String(cur.continuedFrom) === String(prev.id));
      if (isCont) {
        if (Number(cur.startTs) - Number(prev.lastTs) > 10 * 60000) continue;
      } else {
        if (Number(cur.count) >= maxCount) continue;
      }
      if (Number(prev.count) < 3) continue;
      if (cur.memoryWritten) continue;
      if (!isCont && (cur.pending?.length || 0) + (cur.promises?.length || 0) > 0) continue;
      if (!isCont && Number(cur.startTs) - Number(prev.lastTs) > gap) continue;

      const curTitle = chainTitle(cur);
      // 标记放中间会被 12 条上限裁掉，这里放宽到 16 条，保证「话题转到：X」留在正文里。
      prev.facts = unionList(prev.facts, [`话题转到：${curTitle}`, ...(cur.facts || [])], 16).map(tidyText);
      prev.decided = unionList(prev.decided, (cur.decided || []).map((x) => `[${curTitle}] ${x}`), 8).map(tidyText);
      prev.quotes = unionQuotes(prev.quotes, cur.quotes, 10);
      prev.changes = [...(prev.changes || []), ...(cur.changes || [])].slice(-12);
      prev.msgs = [...(prev.msgs || []), ...(cur.msgs || [])].slice(-200);
      prev.count = (Number(prev.count) || 0) + (Number(cur.count) || 0);
      // 消息 id 必须一起并，否则这段对话以后被引用回复时（ingestMessages 靠 mids 回绑），
      // 认不出它已属于这条链，会重新开一条，把刚并好的又拆开。
      prev.mids = [...(prev.mids || []), ...(cur.mids || [])].slice(-2000);
      prev.lastTs = Math.max(Number(prev.lastTs) || 0, Number(cur.lastTs) || 0);
      prev.updatedAt = Math.max(Number(prev.updatedAt) || 0, Number(cur.updatedAt) || 0);
      prev.mergedTitles = [...(prev.mergedTitles || []), curTitle];
      if (isCont) {
        prev.pending = unionList(prev.pending, cur.pending, 8).map(tidyText);
        prev.promises = unionList(prev.promises, cur.promises, 8).map(tidyText);
      }

      cur.mergedInto = prev.id;
      state.mergedChains.push(cur);
      const at = state.chains.indexOf(cur);
      if (at >= 0) state.chains.splice(at, 1);
      // 局部 list 也要同步移除，否则下一轮 i 回退后仍指向这条已并掉的链，会死循环。
      list.splice(i, 1);
      i -= 1;
      merged += 1;
    }
  }
  return merged;
}

export function chatMarkdown(state, chatKey) {
  const chains = state.chains.filter((c) => c.chatKey === chatKey);
  if (!chains.length) return '';
  const out = [`# ${state.windowLabel} ${chatKey} 台账`, ''];
  for (const c of chains) {
    const mergedNote = Array.isArray(c.mergedTitles) && c.mergedTitles.length ? `（含：${c.mergedTitles.join('、')}）` : '';
    out.push(`## ${c.id} · ${chainTitle(c)}${mergedNote}`);
    out.push(`- 状态：${STATUS_TEXT[c.status] || c.status}｜${clockOf(c.startTs)}–${clockOf(c.lastTs)}｜${c.count} 条消息`);
    const who = new Map();
    for (const m of c.msgs) if (m.uid) who.set(m.uid, m.who);
    if (who.size) out.push(`- 参与：${[...who.entries()].map(([uid, name]) => `${name}(${uid})`).join('、')}`);
    const pairs = pairLineRaw(c);
    if (pairs) out.push(`- 对话：${pairs}`);
    for (const [label, arr] of [['事实', c.facts], ['已定', c.decided], ['未决', c.pending], ['约定', c.promises]]) {
      if (arr.length) out.push(`- ${label}：${arr.map((x) => `\n  - ${x}`).join('')}`);
    }
    if (c.quotes.length) out.push(`- 原话：${c.quotes.slice(-5).map((q) => `\n  - ${q.who} ${clockOf(q.ts)}「${q.text}」`).join('')}`);
    if (c.mood) out.push(`- 情绪：${c.mood}`);
    if (realChanges(c).length) out.push(`- 变更痕迹：${realChanges(c).map((x) => `\n  - ${clockOf(x.at)} ${x.note}`).join('')}`);
    out.push('');
  }
  return out.join('\n');
}

export function writeChatMarkdown(state, chatKey) {
  const md = chatMarkdown(state, chatKey);
  if (!md) return false;
  const dir = path.join(LEDGER_ROOT, state.windowLabel);
  ensureDir(dir);
  try {
    fs.writeFileSync(path.join(dir, `${chatKey.replace(/[^a-z0-9_]/gi, '_')}.md`), md, 'utf8');
    return true;
  } catch { return false; }
}

export function writeAllMarkdown(state) {
  const keys = [...new Set(state.chains.map((c) => c.chatKey))];
  let n = 0;
  for (const k of keys) if (writeChatMarkdown(state, k)) n += 1;
  return n;
}

/** 封版：整本状态存进 archive，然后开新账期。 */
export function archiveWindow(state) {
  ensureDir(ARCHIVE_DIR);
  const file = path.join(ARCHIVE_DIR, `${state.windowLabel}.json`);
  writeJson(file, {
    label: state.windowLabel,
    windowStart: state.windowStart,
    frozenAt: Date.now(),
    chains: state.chains.map((c) => ({ ...c, status: 'frozen' }))
  });
  return file;
}

/** 跨账期搜索：读 archive + 当前内存。 */
export function readArchive(label) {
  const raw = readJson(path.join(ARCHIVE_DIR, `${label}.json`), null);
  return raw && Array.isArray(raw.chains) ? raw.chains : [];
}

export function listArchiveLabels(limit = 30) {
  try {
    return fs.readdirSync(ARCHIVE_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map((f) => f.replace(/\.json$/, ''))
      .sort()
      .reverse()
      .slice(0, limit);
  } catch { return []; }
}
