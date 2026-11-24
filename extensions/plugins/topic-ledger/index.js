// 今日台账（确定性型 / plugins/）
//
// 上下文只有 40 条消息，聊过去就忘。这个插件把「当天的事」按事件链记成台账：
//   话题起头 → 15 分钟后出初稿 → 每 15 分钟补增量 → 10 分钟没人聊算收尾出终稿
//   → 到凌晨 2 点整本封版，挑信息量够的写进长期记忆，之后不再更新
//
// 全部零侵入：
//   直接读 data/messages 的原始存档（不依赖 hook 是否触发，机器人不回话也有记录）
//   写长期记忆只走核心 data.memory.append（不碰 memory-plus 的内部文件）
//   提示词只加一小段索引（可关），细节靠工具查

import fs from 'node:fs';
import path from 'node:path';
import { loadWhitelist, chatKeysOfWhitelist, loadMessages, fileStamp, messageFile, chatKindOf, chatIdOf } from './lib/archive.js';
import { MESSAGES_DIR, CONFIG_FILE, LEDGER_ROOT, STATE_FILE } from './lib/paths.js';
import * as S from './lib/state.js';
import { draftChain, patchChain, dbg } from './lib/model.js';
import { writeMemory } from './lib/memory.js';
import { runBackfill, backfillStatus } from './lib/backfill.js';

const DEFAULTS = {
  enabled: true,
  draftAfterMin: 15,
  updateEveryMin: 15,
  silenceMin: 8,
  dayCutoff: '02:00',
  dailyMemoryCap: 8,
  dailyCallBudget: 120,
  injectIndex: true,
  injectMaxChars: 300,
  minMessagesPerChain: 3,
  maxInputChars: 1600,
  scanIntervalSec: 60,
  mergeMaxMsgs: 8,
  mergeGapMin: 90,
  maxChainMessages: 60,
  maxChainMinutes: 45
};

let api = null;
let state = null;
let timer = null;
let bootTimer = null;
let running = false;
const stamps = new Map();

function log(...args) { try { api?.log?.(...args); } catch { /* ignore */ } }
function warn(...args) { try { api?.warn?.(...args); } catch { /* ignore */ } }

function settings() {
  const raw = (api && typeof api.config === 'function' ? api.config() : null) || {};
  const out = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw)) if (v !== undefined && v !== null) out[k] = v;
  return out;
}

function sInt(key, min, max) {
  const v = Number(settings()[key]);
  const n = Number.isFinite(v) ? v : DEFAULTS[key];
  return Math.min(max, Math.max(min, n));
}

function ensureState() {
  if (!state) {
    state = S.loadState(Date.now(), settings().dayCutoff);
    repairMidsOnce(state);
  }
  return state;
}

/** 老链里没有 mid 记录，加载时从消息存档按消息 id 补齐，让引用回复也能回绑到旧链。 */
let midsRepaired = false;
function repairMidsOnce(st) {
  if (midsRepaired) return;
  midsRepaired = true;
  const keys = [...new Set((st.chains || []).map((c) => c.chatKey))];
  for (const chatKey of keys) {
    let msgs = [];
    try { msgs = loadMessages(MESSAGES_DIR, chatKey); } catch { continue; }
    if (!msgs.length) continue;
    const idToMeta = new Map();
    for (const m of msgs) idToMeta.set(Number(m.id), m);
    const isPrivate = String(chatKey).startsWith('private:');
    for (const c of st.chains.filter((x) => x.chatKey === chatKey)) {
      const needMid = !(Array.isArray(c.mids) && c.mids.length);
      const mids = needMid ? [] : c.mids;
      for (const m of c.msgs || []) {
        const meta = idToMeta.get(Number(m.id));
        if (!meta) continue;
        if (m.mid == null || m.mid === '') m.mid = meta.mid != null ? String(meta.mid) : '';
        if (!Array.isArray(m.at) || !m.at.length) m.at = Array.isArray(meta.at) ? meta.at : [];
        if (!m.reply) m.reply = meta.reply || null;
        if (needMid && m.mid) mids.push(String(m.mid));
      }
      if (needMid) c.mids = mids.slice(-2000);
      if (!Array.isArray(c.counterparts) || !c.counterparts.length) {
        c.counterparts = S.pairSummary(c.msgs || [], { privateChat: isPrivate });
      }
    }
    dbg(`mids repaired ${chatKey}`);
  }
}

function persist() {
  try { S.saveState(state); } catch (error) { dbg('save state failed ' + (error?.message ?? error)); }
}

// ── 采集：白名单会话的新消息并进事件链 ──────────────────────────────
function ingestOnce() {
  const st = ensureState();
  const s = settings();
  const allow = loadWhitelist(CONFIG_FILE);
  let keys = chatKeysOfWhitelist(allow);
  if (!keys.length && allow.allowAll) {
    keys = [];
    warn('白名单为空（allowAllWhenEmpty），台账暂不记录任何会话');
  }
  let added = 0;
  for (const chatKey of keys) {
    const file = messageFile(MESSAGES_DIR, chatKey);
    const stamp = fileStamp(file);
    if (!stamp) continue;
    if (stamps.get(chatKey) === stamp) continue;
    stamps.set(chatKey, stamp);
    const msgs = loadMessages(MESSAGES_DIR, chatKey);
    if (!msgs.length) continue;
    const cursor = Number(st.cursors[chatKey]) || 0;
    let fresh;
    if (!cursor) {
      // 首次见到这个会话：只回补本账期内（cutoff 之后）的消息，别把几个月历史全灌进来
      fresh = msgs.filter((m) => m.ts >= st.windowStart);
      st.cursors[chatKey] = msgs[msgs.length - 1].id;
    } else {
      fresh = msgs.filter((m) => m.id > cursor);
      if (fresh.length) st.cursors[chatKey] = fresh[fresh.length - 1].id;
    }
    if (!fresh.length) continue;
    const r = S.ingestMessages(st, chatKey, fresh, {
      silenceMin: s.silenceMin,
      maxMessages: sInt('maxChainMessages', 20, 300),
      maxSpanMin: sInt('maxChainMinutes', 20, 360)
    });
    added += r.added;
  }
  return added;
}

// ── 整理：初稿 / 增量 / 终稿 ────────────────────────────────────────
function shortTitle(chain) {
  const first = (chain.msgs || []).find((m) => !m.self) || chain.msgs?.[0];
  return String(first?.text || '').replace(/^\W+/, '').slice(0, 14);
}

/** 消息太少、不够调模型的链：直接用原话压一条，不花钱。 */
function localEntry(chain) {
  const texts = (chain.msgs || []).filter((m) => !m.self).map((m) => m.text).slice(0, 3);
  return {
    title: shortTitle(chain) || chain.id,
    facts: texts.map((t) => t.slice(0, 80)),
    decided: [],
    pending: [],
    promises: [],
    quotes: texts.length ? [{ who: chain.starter?.name || '?', ts: chain.startTs, text: texts[0].slice(0, 80) }] : [],
    mood: ''
  };
}

function finalizeLocal(chain, now) {
  S.applyEntry(chain, localEntry(chain), now);
  chain.finalizedAt = now;
  chain.status = 'closed';
  S.writeChatMarkdown(state, chain.chatKey);
}

async function runJobs() {
  const st = ensureState();
  const s = settings();
  const now = Date.now();
  let changed = false;
  const closed = S.closeIdleChains(st, { silenceMin: s.silenceMin, now });
  if (closed) { dbg(`idle-closed ${closed}`); changed = true; }

  // 碎片归并：小话题别各自成链，能并进前一条就并（详见 lib/state.js mergeFragments）
  const merged = S.mergeFragments(st, {
    maxMsgs: sInt('mergeMaxMsgs', 2, 20),
    gapMin: sInt('mergeGapMin', 10, 300)
  });
  if (merged) {
    dbg(`merged-fragments ${merged}`);
    changed = true;
    for (const key of [...new Set(st.chains.map((c) => c.chatKey))]) S.writeChatMarkdown(st, key);
  }

  const budgetMax = sInt('dailyCallBudget', 0, 500);
  const minMsgs = sInt('minMessagesPerChain', 2, 12);
  const draftAfter = sInt('draftAfterMin', 3, 180) * 60000;
  const everyMin = sInt('updateEveryMin', 3, 180) * 60000;
  const maxChars = sInt('maxInputChars', 400, 3000);

  let calls = 0;

  for (const chain of st.chains) {
    const overBudget = budgetMax > 0 && st.budget.calls >= budgetMax;
    const canModel = !overBudget && chain.count >= minMsgs;

    // 收尾：出终稿（没初稿的先补一次）
    if (chain.status === 'closed' && !chain.finalizedAt) {
      if (!chain.draftedAt) {
        if (!canModel || (Number(chain.draftAttempts) || 0) >= 3) { finalizeLocal(chain, now); changed = true; continue; }
        const r = await draftChain(chain, { maxInputChars: maxChars });
        calls += 1;
        if (r.ok) {
          st.budget.calls += 1;
          st.budget.promptTokens += r.usage?.promptTokens || 0;
          st.budget.completionTokens += r.usage?.completionTokens || 0;
          S.applyEntry(chain, r.entry, Date.now());
        } else {
          chain.lastError = r.error || '';
          if (r.usage) {
            st.budget.calls += 1;
            st.budget.promptTokens += r.usage.promptTokens || 0;
            st.budget.completionTokens += r.usage.completionTokens || 0;
          }
          chain.draftAttempts = (Number(chain.draftAttempts) || 0) + 1;
          if (chain.draftAttempts < 2) { persist(); continue; } // 下一轮再试一次，别一次解析失败就把原话当地址
          finalizeLocal(chain, now);
          changed = true;
          continue;
        }
      } else if (chain.count > chain.draftedCount && canModel && now - chain.updatedAt >= 60000) {
        const r = await patchChain(chain, { maxInputChars: maxChars, sinceCount: chain.draftedCount });
        calls += 1;
        st.budget.calls += 1;
        if (r.usage) {
          st.budget.promptTokens += r.usage.promptTokens || 0;
          st.budget.completionTokens += r.usage.completionTokens || 0;
        }
        if (r.ok) S.applyPatch(chain, r.patch, Date.now());
        else chain.lastError = r.error || '';
      }
      chain.finalizedAt = Date.now();
      chain.status = 'closed';
      S.writeChatMarkdown(st, chain.chatKey);
      changed = true;
      continue;
    }

    // 进行中：到点出初稿（解析连续失败 3 次就不再烧钱，等收尾时用原话压一条）
    if (chain.status === 'open' && !chain.draftedAt && now - chain.startTs >= draftAfter) {
      if (!canModel) continue;
      if ((Number(chain.draftAttempts) || 0) >= 3) continue;
      const r = await draftChain(chain, { maxInputChars: maxChars });
      calls += 1;
      st.budget.calls += 1;
      if (r.usage) {
        st.budget.promptTokens += r.usage.promptTokens || 0;
        st.budget.completionTokens += r.usage.completionTokens || 0;
      }
      if (r.ok) {
        S.applyEntry(chain, r.entry, Date.now());
        S.writeChatMarkdown(st, chain.chatKey);
        changed = true;
      } else {
        chain.lastError = r.error || '';
        chain.draftAttempts = (Number(chain.draftAttempts) || 0) + 1;
      }
      continue;
    }

    // 进行中：每 N 分钟补一次增量
    if (chain.status === 'open' && chain.draftedAt && chain.count > chain.draftedCount && now - chain.updatedAt >= everyMin) {
      if (!canModel) continue;
      const r = await patchChain(chain, { maxInputChars: maxChars, sinceCount: chain.draftedCount });
      calls += 1;
      st.budget.calls += 1;
      if (r.usage) {
        st.budget.promptTokens += r.usage.promptTokens || 0;
        st.budget.completionTokens += r.usage.completionTokens || 0;
      }
      if (r.ok) {
        S.applyPatch(chain, r.patch, Date.now());
        S.writeChatMarkdown(st, chain.chatKey);
        changed = true;
      } else {
        chain.lastError = r.error || '';
      }
    }
    if (calls >= 6) break;
  }

  if (changed || closed) persist();
  return { calls, closed };
}

// ── 封版：02:00 收账，写长期记忆，开新账期 ──────────────────────────
async function finalizeAll(now) {
  const st = ensureState();
  for (const chain of st.chains) {
    if (chain.finalizedAt) continue;
    if (!chain.draftedAt && chain.count >= 3) {
      try {
        const r = await draftChain(chain, { maxInputChars: sInt('maxInputChars', 400, 3000) });
        if (r.ok) S.applyEntry(chain, r.entry, Date.now());
        else finalizeLocal(chain, now);
      } catch { finalizeLocal(chain, now); }
    } else if (!chain.draftedAt) {
      finalizeLocal(chain, now);
    }
    chain.finalizedAt = Date.now();
    chain.status = 'closed';
  }
}

async function freezeWindow(reason = 'cutoff') {
  const st = ensureState();
  const s = settings();
  const now = Date.now();
  if (!st.chains.length) {
    // 空账期也照样翻页，避免第二天把昨天的消息重复灌进来
    const next = S.emptyState(now, s.dayCutoff);
    next.cursors = st.cursors;
    state = next;
    persist();
    return;
  }

  await finalizeAll(now);

  // 封版前再并一次：这一步决定哪几条会被写进长期记忆，碎片先合并才不会占名额
  const mergedAtFreeze = S.mergeFragments(st, {
    maxMsgs: sInt('mergeMaxMsgs', 2, 20),
    gapMin: sInt('mergeGapMin', 10, 300)
  });
  if (mergedAtFreeze) dbg(`merged-fragments ${mergedAtFreeze}`);

  const cap = sInt('dailyMemoryCap', 1, 30);
  const cands = st.chains
    .filter((c) => (c.facts.length || c.decided.length || c.pending.length || c.promises.length) && !c.memoryWritten)
    .sort((a, b) => S.infoScore(b) - S.infoScore(a))
    .slice(0, cap);

  let written = 0;
  for (const chain of cands) {
    const r = writeMemory(api, chain, st.windowLabel);
    if (r.ok) {
      chain.memoryWritten = true;
      written += 1;
    } else {
      chain.lastError = r.error || '';
      warn(`写长期记忆失败（${chain.id} → ${r.target}）：${r.error}`);
    }
  }

  S.writeAllMarkdown(st);
  let archiveFile = '';
  try { archiveFile = S.archiveWindow(st); } catch (error) { warn('封版存档失败：', error?.message ?? error); }

  const next = S.emptyState(now, s.dayCutoff);
  next.cursors = st.cursors;
  state = next;
  persist();
  log(`台账封版（${reason}）：${st.windowLabel}，${st.chains.length} 条事件链，${written} 条写进长期记忆${archiveFile ? '，存档 ' + archiveFile : ''}`);
}

function maybeFreeze() {
  const st = ensureState();
  const s = settings();
  const now = Date.now();
  const expected = S.windowStartOf(now, s.dayCutoff);
  if (expected > Number(st.windowStart) + 1000) return freezeWindow('cutoff');
  if (s.dayCutoff && Number(st.windowStart) + 24 * 3600000 <= now) return freezeWindow('late');
  return Promise.resolve();
}

// ── 主循环 ──────────────────────────────────────────────────────────
async function tick(why = 'timer') {
  if (running) return;
  running = true;
  try {
    if (settings().enabled === false) return;
    const added = ingestOnce();
    if (added) dbg(`ingest ${added} @${why}`);
    await maybeFreeze();
    await runJobs();
  } catch (error) {
    dbg(`tick thrown ${why} ${error?.stack || error?.message || error}`);
  } finally {
    running = false;
  }
}

// ── 视图 ────────────────────────────────────────────────────────────
const STATUS_CN = { open: '进行中', closed: '已收尾', frozen: '已封版' };

function chatLabel(chatKey) {
  const kind = chatKindOf(chatKey);
  return kind === 'private' ? `私聊 ${chatIdOf(chatKey)}` : `群 ${chatIdOf(chatKey)}`;
}

function listLine(c) {
  const bits = [];
  if (c.facts.length) bits.push(c.facts[0]);
  if (c.decided.length) bits.push(`已定：${c.decided[0]}`);
  if (c.pending.length) bits.push(`未决：${c.pending[0]}`);
  if (c.promises.length) bits.push(`约定：${c.promises[0]}`);
  const head = `${c.seq ? 'T' + c.seq : c.id} ${S.chainTitle(c)}｜${STATUS_CN[c.status] || c.status}｜${S.clockOf(c.startTs)}–${S.clockOf(c.lastTs)}`;
  return head + (bits.length ? `\n   ${bits.join('；').slice(0, 90)}` : '');
}

function todayText(chatKey, limit = 12) {
  const st = ensureState();
  const chains = st.chains
    .filter((c) => (!chatKey || c.chatKey === chatKey) && (c.title || c.facts.length || c.decided.length || c.pending.length || c.promises.length))
    .sort((a, b) => a.startTs - b.startTs);
  const head = `账期 ${st.windowLabel}（${S.clockOf(st.windowStart)} 起）｜事件链 ${chains.length} 条`;
  if (!chains.length) return `${head}\n还没有记下任何事。`;
  const groups = [...new Set(chains.map((c) => c.chatKey))];
  const body = groups.map((k) => {
    const rows = chains.filter((c) => c.chatKey === k).slice(-limit);
    return `【${chatLabel(k)}】\n${rows.map(listLine).join('\n')}`;
  }).join('\n\n');
  return `${head}\n${body}`.slice(0, 2000);
}

function findChain(idOrTitle) {
  const st = ensureState();
  const key = String(idOrTitle || '').trim();
  if (!key) return null;
  const exact = st.chains.find((c) => c.id === key);
  if (exact) return exact;
  const seq = /^(?:T|#)?(\d+)$/i.exec(key);
  if (seq) {
    const bySeq = st.chains.filter((c) => String(c.seq) === seq[1]);
    if (bySeq.length === 1) return bySeq[0];
    if (bySeq.length > 1) return bySeq[bySeq.length - 1];
  }
  return st.chains.find((c) => S.chainTitle(c).includes(key)) || null;
}

function searchChains(query, days = 7) {
  const st = ensureState();
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const hits = [];
  const match = (c) => {
    const blob = [c.title, ...c.facts, ...c.decided, ...c.pending, ...c.promises, ...c.quotes.map((x) => `${x.who} ${x.text}`), c.mood, ...(c.msgs || []).map((m) => m.text)]
      .join(' ').toLowerCase();
    return blob.includes(q);
  };
  for (const c of st.chains) if (match(c)) hits.push({ ...c, _label: st.windowLabel });
  for (const label of S.listArchiveLabels(days)) {
    for (const c of S.readArchive(label)) if (match(c)) hits.push({ ...c, _label: label });
  }
  return hits.sort((a, b) => b.startTs - a.startTs).slice(0, 8);
}

function detailText(chain, label) {
  if (!chain) return '没有这条台账。';
  const st = ensureState();
  const head = label ? `账期 ${label}` : `账期 ${st.windowLabel}`;
  return `${head}｜${chatLabel(chain.chatKey)}\n${S.chainDetail(chain)}`;
}

function panelPayload() {
  const st = ensureState();
  return {
    label: st.windowLabel,
    windowStart: st.windowStart,
    budget: st.budget,
    chains: st.chains
      .slice()
      .sort((a, b) => b.startTs - a.startTs)
      .slice(0, 200)
      .map((c) => ({
        id: c.id,
        seq: c.seq,
        title: S.chainTitle(c),
        status: c.status,
        statusText: STATUS_CN[c.status] || c.status,
        chatKey: c.chatKey,
        chatLabel: chatLabel(c.chatKey),
        start: S.clockOf(c.startTs),
        end: S.clockOf(c.lastTs),
        startTs: c.startTs,
        count: c.count,
        starter: c.starter?.name || '',
        cast: [...new Set((c.msgs || []).filter((m) => m.uid && !m.self).map((m) => `${m.who}(${m.uid})`))].join('、'),
        facts: c.facts,
        decided: c.decided,
        pending: c.pending,
        promises: c.promises,
        quotes: c.quotes.map((q) => ({ who: q.who, at: S.clockOf(q.ts), text: q.text })),
        mood: c.mood,
        changes: S.realChanges(c).map((x) => ({ at: S.clockOf(x.at), note: x.note })),
        pairs: Array.isArray(c.counterparts) ? c.counterparts : [],
        pairText: S.pairLineRaw(c),
        memoryWritten: c.memoryWritten,
        midsCount: Array.isArray(c.mids) ? c.mids.length : 0,
        drafted: Boolean(c.draftedAt),
        error: c.lastError || ''
      }))
  };
}

function appendToSystem(messages, text) {
  if (!Array.isArray(messages) || !text) return;
  const sys = messages.find((m) => m && m.role === 'system');
  if (sys && typeof sys.content === 'string') { sys.content += text; return; }
  if (sys && Array.isArray(sys.content)) { sys.content.push({ type: 'text', text }); return; }
  messages.unshift({ role: 'system', content: String(text).trim() });
}

const INJECT_STATUS = { open: '进行中', closed: '已收尾', frozen: '已封版' };

/** 一条链压成两行：标题行（状态/时间）+ 结论行（已定/未决/约定）。名单不再重复塞进注入，需要时用工具查。 */
function chainBlock(c, tag, { dropDecided = false, headOnly = false } = {}) {
  const head = `${tag}${S.chainTitle(c)}｜${INJECT_STATUS[c.status] || c.status}｜`
    + `${S.clockOf(c.startTs)}–${S.clockOf(c.lastTs)}`;
  if (headOnly) return head;
  const bits = [];
  if (!dropDecided && c.decided?.length) bits.push('已定：' + c.decided.slice(0, 2).join('；'));
  if (c.pending?.length) bits.push('还没结果：' + c.pending.slice(0, 2).join('；'));
  if (c.promises?.length) bits.push('答应过还没办：' + c.promises.slice(0, 1).join('；'));
  return bits.length ? `${head}\n${bits.join('｜')}` : head;
}

function buildIndex(chatKey) {
  const s = settings();
  if (s.injectIndex === false || !state) return '';
  const usable = state.chains.filter((c) => c.chatKey === chatKey
    && (c.title || c.facts.length || c.decided.length || c.promises.length));
  if (!usable.length) return '';

  // 只放两条完整事件：现在进行中的一条 + 上一条已收尾/已封版的一条。
  const live = usable.filter((c) => c.status === 'open').sort((a, b) => b.lastTs - a.lastTs)[0];
  const prev = usable.filter((c) => c.status !== 'open').sort((a, b) => b.lastTs - a.lastTs)[0];
  const picked = [];
  if (live) picked.push({ c: live, tag: '进行中 ' });
  if (prev) picked.push({ c: prev, tag: '上一条 ' });

  const cap = Math.max(120, Number(s.injectMaxChars) || 300);
  const render = (makeOpt) => picked
    .map((p, i) => chainBlock(p.c, p.tag, typeof makeOpt === 'function' ? makeOpt(p, i) : makeOpt))
    .join('\n');
  // 超长时按「先丢价值最低的」顺序降级，别把未决/约定切掉：
  // 完整 → 去掉已定（过去式）→ 上一条只留标题 → 实在还超才硬截
  let body = render({});
  if (body.length > cap) body = render({ dropDecided: true });
  if (body.length > cap) body = render((p, i) => ({ dropDecided: true, headOnly: i === 1 }));
  if (body.length > cap) body = body.slice(0, cap - 1) + '…';
  return `\n\n【今日台账】\n${body}\n（已定＝聊出结论的；还没结果＝仍悬着；答应过还没办＝我欠着的事。凡是「还没结果」「答应过还没办」，一律不许说成已经办了、已经问过了。）`;
}

// ── 工具 / 指令 / 面板 ───────────────────────────────────────────────
function registerTools(a) {
  a.registerTool({
    id: 'ledger_today',
    name: '今日台账',
    description: '看今天这本台账（当前账期 02:00 → 次日 02:00）记下了哪些事件链：标题、状态、时间、参与人、已定事项、未决问题、约定。'
      + '上下文里只有最近几十条消息，聊到早一点的事时用它确认「今天到底聊定了什么」，别当没发生过。',
    category: 'memory',
    icon: '📒',
    parameters: {
      type: 'object',
      properties: {
        chatKey: { type: 'string', description: '只看某个会话（group:群号 / private:QQ号）；不填就是全部白名单会话' },
        limit: { type: 'number', description: '每个会话最多列几条，默认 12' }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        const chatKey = String(args?.chatKey || '').trim();
        return { content: todayText(chatKey, Math.min(30, Math.max(1, Number(args?.limit) || 12))) };
      } catch (error) {
        return { content: `读台账失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'ledger_get',
    name: '台账详情（按条取全文）',
    description: '按编号（T3 或 topic-ledger 内部 id）或标题关键词，取某一条事件链的完整台账：参与人、事实、已定、未决、约定、关键原话、情绪、变更痕迹。',
    category: 'memory',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '事件链编号（如 T3）或标题里的关键词' } },
      required: ['id']
    },
    async execute(ctx, args) {
      try {
        const chain = findChain(args?.id);
        return { content: detailText(chain, '') };
      } catch (error) {
        return { content: `查台账失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'ledger_search',
    name: '台账搜索（跨账期）',
    description: '在今天的台账和历史封版存档里按关键词搜（人名、物件、地点、金额、事情都行），返回命中的事件链摘要。问「上次说定的那个多少钱」这类问题时用。只管「事」：约定、未决问题、进展到哪一步。问某人性情偏好用 recall_impression；翻很久以前的对话原话用 memory_recall。',
    category: 'memory',
    icon: '🗂️',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词' },
        days: { type: 'number', description: '回看多少个封版存档，默认 7' }
      },
      required: ['query']
    },
    async execute(ctx, args) {
      try {
        const q = String(args?.query || '').trim();
        if (!q) return { content: '缺少 query：要搜什么？', isError: true };
        const hits = searchChains(q, Math.min(60, Math.max(1, Number(args?.days) || 7)));
        if (!hits.length) return { content: `没搜到「${q}」相关的台账。` };
        const text = hits.map((c) => `[${c._label}] ${listLine(c)}`).join('\n');
        return { content: text.slice(0, 1600) };
      } catch (error) {
        return { content: `搜台账失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'panel_data',
    name: '台账页数据',
    description: '控制台「台账」页取数用（只给面板调，模型不用）。',
    category: 'memory',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try { return { content: JSON.stringify(panelPayload()) }; } catch (error) {
        return { content: JSON.stringify({ error: String(error?.message ?? error) }), isError: true };
      }
    }
  });

  a.registerTool({
    id: 'ledger_backfill',
    name: '补录历史台账',
    description: '把今天之前某个日期区间（只白名单会话）按天补成台账：写 ledger/<日期> 的 markdown 和 archive 存档，并按每天最多 8 条写长期记忆。后台跑，用 ledger_backfill_status 看进度。只在明确要求补历史时用。',
    category: 'memory',
    icon: '🗃️',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: '起始日期 YYYY-MM-DD' },
        to: { type: 'string', description: '结束日期 YYYY-MM-DD' },
        maxCalls: { type: 'number', description: '模型调用上限，默认 180' },
        writeMem: { type: 'boolean', description: '是否顺带写长期记忆，默认 true；只重写台账时传 false' },
        only: { type: 'string', description: '只补某一个会话，格式 group:123 或 private:456，默认全部白名单' },
        memOnly: { type: 'boolean', description: '只补写长期记忆，不改写 markdown 和 archive，默认 false' }
      },
      required: ['from', 'to']
    },
    async execute(ctx, args) {
      try {
        const from = String(args?.from || '').trim();
        const to = String(args?.to || '').trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
          return { content: '日期格式要 YYYY-MM-DD', isError: true };
        }
        const st = backfillStatus();
        if (st.running) return { content: `已有补录在跑：${st.current}（${st.doneDays}/${st.days}）`, isError: true };
        runBackfill(api, {
          from,
          to,
          maxCalls: Math.min(500, Math.max(1, Number(args?.maxCalls) || 180)),
          writeMem: args?.writeMem !== false,
          only: String(args?.only || '').trim(),
          memOnly: args?.memOnly === true
        })
          .catch((error) => dbg('backfill error ' + (error?.message ?? error)));
        return { content: JSON.stringify({ started: true, from, to }) };
      } catch (error) {
        return { content: JSON.stringify({ error: String(error?.message ?? error) }), isError: true };
      }
    }
  });

  a.registerTool({
    id: 'ledger_backfill_status',
    name: '历史补录进度',
    description: '查历史补录跑到哪了：已完成天数、已生成条目、写进长期记忆条数、失败原因。',
    category: 'memory',
    icon: '📊',
    parameters: { type: 'object', properties: {}, required: [] },
    async execute() {
      try { return { content: JSON.stringify(backfillStatus()) }; } catch (error) {
        return { content: JSON.stringify({ error: String(error?.message ?? error) }), isError: true };
      }
    }
  });
}

function registerCommand(a) {
  try {
    a.registerCommand('/台账', async ({ args }) => {
      const q = String(args || '').trim();
      if (!q) return todayText('', 12);
      const hits = searchChains(q, 7);
      if (!hits.length) return `没搜到「${q}」相关的台账。`;
      return hits.slice(0, 5).map((c) => `[${c._label}] ${listLine(c)}`).join('\n').slice(0, 1200);
    });
  } catch (error) {
    warn('注册 /台账 指令失败：', error?.message ?? error);
  }
}

// ── 生命周期 ────────────────────────────────────────────────────────
export function setup(a) {
  api = a;
  try { fs.mkdirSync(LEDGER_ROOT, { recursive: true }); } catch { /* ignore */ }
  ensureState();
  try { registerTools(a); } catch (error) {
    warn('注册台账工具失败：', error?.message ?? error);
    throw error;
  }
  registerCommand(a);
  dbg(`setup window=${state.windowLabel} chains=${state.chains.length}`);
}

export function activate() {
  if (timer) return;
  const everyMs = Math.max(15, Number(settings().scanIntervalSec) || 60) * 1000;
  timer = setInterval(() => { tick('timer').catch((e) => dbg('tick error ' + (e?.message || e))); }, everyMs);
  timer.unref?.();
  bootTimer = setTimeout(() => { tick('boot').catch((e) => dbg('boot error ' + (e?.message || e))); }, 6000);
  bootTimer.unref?.();
  log(`今日台账已启用：账期 ${ensureState().windowLabel}，扫描间隔 ${Math.round(everyMs / 1000)} 秒，${ensureState().chains.length} 条事件链`);
}

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
  if (bootTimer) { clearTimeout(bootTimer); bootTimer = null; }
}

export const hooks = {
  /** 每轮往 system 里贴一小段台账索引，让它别忘了今天聊定的事。 */
  async 'before-llm-messages'(ctx = {}) {
    try {
      if (!state || settings().enabled === false) return;
      const key = String(ctx.chatKey || '');
      if (!key) return;
      const text = buildIndex(key);
      if (text) appendToSystem(ctx.messages, text);
    } catch (error) {
      dbg('inject failed ' + (error?.message ?? error));
    }
  }
};

export const providers = {
  'topic-ledger.status': () => {
    try {
      const st = ensureState();
      return { ok: true, label: st.windowLabel, chains: st.chains.length, budget: st.budget };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  }
};


