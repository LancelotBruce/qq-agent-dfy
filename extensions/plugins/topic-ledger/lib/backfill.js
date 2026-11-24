// 历史补录：把今天之前（白名单会话）的聊天按账期/按天整理成台账条目。
// 只写 ledger/<日期>/<会话>.md 和 ledger/archive/<日期>.json，再按每天 8 条上限写长期记忆；
// 不碰当前账期状态（state.json），所以正在记的今天不会被打断。
import fs from 'node:fs';
import path from 'node:path';
import { LEDGER_ROOT, ARCHIVE_DIR, MESSAGES_DIR, CONFIG_FILE } from './paths.js';
import { loadWhitelist, chatKeysOfWhitelist, loadMessages, writeJson } from './archive.js';
import { localDayKey, windowStartOf, infoScore, clockOf, pairSummary } from './state.js';
import { digestDay } from './model.js';
import { writeMemory } from './memory.js';

const STATUS_CN = { open: '进行中', closed: '已收尾', frozen: '已封版' };

const job = {
  running: false, from: '', to: '', cutoff: '02:00', calls: 0, maxCalls: 180,
  days: 0, doneDays: 0, chats: 0, entries: 0, memories: 0,
  startedAt: 0, finishedAt: 0, current: '', failed: [], log: []
};

function note(line) {
  job.log.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (job.log.length > 60) job.log = job.log.slice(-40);
}

export function backfillStatus() {
  return { ...job, log: job.log.slice(-10) };
}

function dayList(from, to) {
  const out = [];
  const start = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || start > end) return out;
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
  }
  return out;
}

function chatLabel(chatKey) {
  const [kind, id] = String(chatKey).split(':');
  return kind === 'private' ? `私聊 ${id}` : `群 ${id}`;
}

function ensureDir(dir) {
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ignore */ }
}

function mdOf(label, chatKey, chains) {
  const out = [`# ${label} ${chatLabel(chatKey)} 台账（补录）`, ''];
  for (const c of chains) {
    out.push(`## ${c.id} · ${c.title || '（未命名）'}`);
    out.push(`- 状态：已封版｜${clockOf(c.startTs)}–${clockOf(c.lastTs)}｜${c.count} 条消息`);
    const who = new Map();
    for (const m of c.msgs || []) if (m.uid && !m.self) who.set(m.uid, m.who);
    if (who.size) out.push(`- 参与：${[...who.entries()].map(([uid, name]) => `${name}(${uid})`).join('、')}`);
    const pairs = (Array.isArray(c.counterparts) && c.counterparts.length)
      ? c.counterparts
      : pairSummary(c.msgs || [], { privateChat: String(c.chatKey || '').startsWith('private:') });
    const pairText = (Array.isArray(pairs) ? pairs : []).map((p) => {
      const tag = p.via === '@' ? '（@）' : p.via === '引用' ? '（引用）' : '';
      const to = String(p.to || '').replace(/\(QQ[:：].*?\)/i, '').trim();
      return `${p.from} → ${to}${tag}${p.count > 1 ? ` ${p.count} 次` : ''}`;
    }).join('、');
    if (pairText) out.push(`- 对话：${pairText}`);
    for (const [k, arr] of [['事实', c.facts], ['已定', c.decided], ['未决', c.pending], ['约定', c.promises]]) {
      if (arr.length) out.push(`- ${k}：${arr.map((x) => `\n  - ${x}`).join('')}`);
    }
    const real = (c.changes || []).filter((x) => String(x?.note || '').trim() && String(x.note).trim() !== '初稿');
    if (real.length) out.push(`- 变更：${real.map((x) => `\n  - ${clockOf(x.at)} ${x.note}`).join('')}`);
    if (c.quotes.length) out.push(`- 原话：${c.quotes.slice(-5).map((q) => `\n  - ${q.who} ${clockOf(q.ts)}「${q.text}」`).join('')}`);
    if (c.mood) out.push(`- 情绪：${c.mood}`);
    out.push('');
  }
  return out.join('\n');
}

function pseudoChain(chatKey, label, entry, msgs, seq) {
  const first = msgs[0]?.ts || 0;
  const last = msgs[msgs.length - 1]?.ts || first;
  const starterMsg = msgs.find((m) => !m.self && m.uid) || null;
  return {
    id: `${chatKey}#补${seq}`,
    chatKey, seq,
    title: entry.title,
    status: 'frozen',
    startTs: first, lastTs: last,
    count: msgs.length,
    msgs: msgs.slice(-120),
    starter: starterMsg ? { uid: starterMsg.uid, name: starterMsg.who } : null,
    facts: entry.facts, decided: entry.decided, pending: entry.pending,
    promises: entry.promises, quotes: entry.quotes, mood: entry.mood,
    counterparts: pairSummary(msgs.slice(-120), { privateChat: String(chatKey).startsWith('private:') }),
    changes: entry.changes || [], memoryWritten: false
  };
}

export async function runBackfill(api, { from, to, maxCalls = 180, cutoff = '02:00', writeMem = true, only = '', memOnly = false } = {}) {
  if (job.running) return { ok: false, error: '已有补录任务在跑' };
  const days = dayList(from, to);
  if (!days.length) return { ok: false, error: '日期范围不合法' };

  const allow = loadWhitelist(CONFIG_FILE);
  let keys = chatKeysOfWhitelist(allow);
  if (only) keys = keys.filter((k) => k === only);
  if (!keys.length) return { ok: false, error: `白名单里没有会话 ${only}` };

  Object.assign(job, {
    running: true, from, to, cutoff, calls: 0, maxCalls: Number(maxCalls) || 180,
    days: days.length, doneDays: 0, chats: 0, entries: 0, memories: 0,
    startedAt: Date.now(), finishedAt: 0, current: '', failed: [], log: []
  });
  note(`开始补录 ${from} → ${to}，共 ${days.length} 天，调用上限 ${job.maxCalls}`);

  const files = new Map();
  for (const k of keys) { try { files.set(k, loadMessages(MESSAGES_DIR, k)); } catch { files.set(k, []); } }
  note(`白名单会话 ${keys.length} 个：${keys.join(', ')}`);

  try {
    for (const label of days) {
      job.current = label;
      const ws = windowStartOf(new Date(`${label}T12:00:00`).getTime(), cutoff);
      const byChat = new Map();
      for (const k of keys) {
        const msgs = (files.get(k) || []).filter((m) => localDayKey(windowStartOf(m.ts, cutoff)) === label);
        if (msgs.length) byChat.set(k, msgs);
      }
      if (!byChat.size) { job.doneDays += 1; continue; }

      const chainsByChat = new Map();
      for (const [chatKey, msgs] of byChat) {
        if (job.calls >= job.maxCalls) { job.failed.push(`${label} ${chatKey}: 超出调用上限`); continue; }
        if (msgs.length < 3) { note(`${label} ${chatKey} 只有 ${msgs.length} 条，跳过`); continue; }
        job.current = `${label} ${chatKey}`;
        job.calls += 1; job.chats += 1;
        const r = await digestDay({ chatKey, label, msgs }, { maxInputChars: 2200 });
        if (!r.ok) { job.failed.push(`${label} ${chatKey}: ${r.error}`); note(`失败 ${label} ${chatKey} ${r.error}`); continue; }
        const chains = r.entries.slice(0, 3).map((e, i) => pseudoChain(chatKey, label, e, msgs, i + 1));
        if (!chains.length) { note(`${label} ${chatKey} 模型没给出条目`); continue; }
        chainsByChat.set(chatKey, chains);
        job.entries += chains.length;
        note(`${label} ${chatKey} ${chains.length} 条`);
        if (job.calls % 10 === 0) await new Promise((res) => setTimeout(res, 300));
      }

      // 写当天 markdown
      if (!memOnly) for (const [chatKey, chains] of chainsByChat) {
        const dir = path.join(LEDGER_ROOT, label);
        ensureDir(dir);
        try { fs.writeFileSync(path.join(dir, `${chatKey.replace(/[^a-z0-9_]/gi, '_')}.md`), mdOf(label, chatKey, chains), 'utf8'); } catch { /* ignore */ }
      }

      // 当天所有链 → 存档 + 长期记忆（每天最多 8 条）
      const allChains = [...chainsByChat.values()].flat();
      if (allChains.length) {
        ensureDir(ARCHIVE_DIR);
        if (!memOnly) try {
          writeJson(path.join(ARCHIVE_DIR, `${label}.json`), {
            label, windowStart: ws, frozenAt: Date.now(), backfill: true, chains: allChains
          });
        } catch { /* ignore */ }

        if (writeMem) {
          const cap = 8;
          const cands = allChains
            .filter((c) => c.facts.length || c.decided.length || c.pending.length || c.promises.length)
            .sort((a, b) => infoScore(b) - infoScore(a))
            .slice(0, cap);
          for (const c of cands) {
            const r = writeMemory(api, c, label);
            if (r.ok) { c.memoryWritten = true; job.memories += 1; }
            else { job.failed.push(`${label} ${c.chatKey} 记忆写入失败: ${r.error}`); }
          }
        }
      }
      job.doneDays += 1;
    }
  } catch (error) {
    job.failed.push(`任务异常: ${error?.message ?? error}`);
    note(`异常 ${error?.message ?? error}`);
  } finally {
    job.running = false;
    job.finishedAt = Date.now();
    job.current = '';
    note(`结束：${job.doneDays}/${job.days} 天，${job.entries} 条条目，${job.memories} 条记忆，失败 ${job.failed.length}`);
  }
  return { ok: true, status: backfillStatus() };
}
