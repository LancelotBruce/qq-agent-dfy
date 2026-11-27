/**
 * 群聊动态节奏（group-pacing）—— QQ Agent 插件
 *
 * 只负责“这一批等多久收口”，不负责“这一轮该不该开口”。
 * 统计最近 N 秒有多少个不同真人发言、发了多少条：
 *   3 人 / 6 条 → 12 秒
 *   4 人 / 8 条 → 8 秒
 *   5 人 / 8 条 → 5 秒
 * 其余保持内核原来的 25 秒。
 *
 * 内核通过 `wake.delay` 扩展点询问本群期望等待时长；
 * 已排好的等待只允许被提前，不允许被延长或重置。
 */

const LOG_TAG = '群聊节奏';
const BUILD_TAG = 'v1.0.2';

const DEFAULTS = {
  enabled: true,
  onlyGroups: true,
  windowSeconds: 60,
  holdSeconds: 120,
  stepDownSeconds: 30,
  mildPeople: 3,
  mildMessages: 6,
  mildDelayMs: 12000,
  busyPeople: 4,
  busyMessages: 8,
  busyDelayMs: 8000,
  burstPeople: 5,
  burstMessages: 8,
  burstDelayMs: 5000
};

let api = null;
const log = (...args) => { try { api?.log?.(...args); } catch { /* ignore */ } };

const num = (v, d, min = 0, max = 100000) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
};

function settings() {
  let raw = {};
  try { raw = (typeof api?.config === 'function' ? api.config() : null) || {}; } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,
    onlyGroups: raw.onlyGroups !== false,
    windowSeconds: num(raw.windowSeconds, DEFAULTS.windowSeconds, 10, 300),
    holdSeconds: num(raw.holdSeconds, DEFAULTS.holdSeconds, 10, 600),
    stepDownSeconds: num(raw.stepDownSeconds, DEFAULTS.stepDownSeconds, 5, 300),
    mildPeople: num(raw.mildPeople, DEFAULTS.mildPeople, 2, 20),
    mildMessages: num(raw.mildMessages, DEFAULTS.mildMessages, 1, 100),
    mildDelayMs: num(raw.mildDelayMs, DEFAULTS.mildDelayMs, 1000, 120000),
    busyPeople: num(raw.busyPeople, DEFAULTS.busyPeople, 2, 20),
    busyMessages: num(raw.busyMessages, DEFAULTS.busyMessages, 1, 100),
    busyDelayMs: num(raw.busyDelayMs, DEFAULTS.busyDelayMs, 1000, 120000),
    burstPeople: num(raw.burstPeople, DEFAULTS.burstPeople, 2, 20),
    burstMessages: num(raw.burstMessages, DEFAULTS.burstMessages, 1, 100),
    burstDelayMs: num(raw.burstDelayMs, DEFAULTS.burstDelayMs, 1000, 120000)
  };
}

/** chatKey -> { events:[{ts,senderId}], level, busyUntil, lastAt, lastLevelAt } */
const chats = new Map();
const MAX_EVENTS = 3000;

function stateFor(chatKey) {
  let state = chats.get(chatKey);
  if (!state) {
    state = { events: [], level: 0, busyUntil: 0, lastAt: 0, lastLevelAt: 0, lastAskLevel: 0 };
    chats.set(chatKey, state);
  }
  return state;
}

function prune(state, now, s) {
  const cutoff = now - s.windowSeconds * 1000;
  let drop = 0;
  while (drop < state.events.length && state.events[drop].ts < cutoff) drop += 1;
  if (drop) state.events.splice(0, drop);
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
}

function snapshot(state) {
  const senders = new Set();
  for (const item of state.events) senders.add(item.senderId);
  return { people: senders.size, messages: state.events.length };
}

function rawLevel(s, people, messages) {
  if (people >= s.burstPeople && messages >= s.burstMessages) return 3;
  if (people >= s.busyPeople && messages >= s.busyMessages) return 2;
  if (people >= s.mildPeople && messages >= s.mildMessages) return 1;
  return 0;
}

function delayForLevel(level, s) {
  if (level >= 3) return s.burstDelayMs;
  if (level === 2) return s.busyDelayMs;
  if (level === 1) return s.mildDelayMs;
  return null;
}

/** 长时间没有新消息时，按 30 秒一档向下回落，直到闲时。 */
function decay(state, now, s) {
  while (state.level > 0 && now > state.busyUntil) {
    state.level -= 1;
    state.busyUntil = now + s.stepDownSeconds * 1000;
    state.lastLevelAt = now;
  }
}

function observe(chatKey, entry, s, now = Date.now()) {
  if (!s.enabled) return;
  if (s.onlyGroups && !String(chatKey).startsWith('group:')) return;
  if (!entry || entry.self || entry.recalled) return;
  const senderId = String(entry.senderId ?? '').replace(/[^0-9]/g, '');
  if (!senderId) return;
  const ts = Number(entry.ts);
  const state = stateFor(chatKey);
  state.lastAt = now;
  state.events.push({ ts: Number.isFinite(ts) ? ts : now, senderId });
  prune(state, now, s);
  decay(state, now, s);
  const { people, messages } = snapshot(state);
  const level = rawLevel(s, people, messages);
  if (level > state.level) {
    state.level = level;
    state.busyUntil = now + s.holdSeconds * 1000;
    state.lastLevelAt = now;
    if (level > 0) log(`[${chatKey}] 进入 ${levelLabel(level)} 档：${people}人/${messages}条，等待 ${Math.round(delayForLevel(level, s) / 1000)} 秒`);
  } else if (level > 0 && level >= state.level && now <= state.busyUntil) {
    // 仍在忙时，只延长保持时间；不因单条闲聊把已经降下来的档位重新抬高。
    state.busyUntil = now + s.holdSeconds * 1000;
  }
}

function delayForChat(chatKey, isPrivate, s, now = Date.now()) {
  if (!s.enabled) return null;
  if (isPrivate && s.onlyGroups) return null;
  if (s.onlyGroups && !String(chatKey).startsWith('group:')) return null;
  const state = chats.get(chatKey);
  if (!state) return null;
  prune(state, now, s);
  decay(state, now, s);
  if (state.level <= 0) return null;
  const { people, messages } = snapshot(state);
  const delayMs = delayForLevel(state.level, s);
  if (!delayMs) return null;
  if (state.lastAskLevel !== state.level) {
    state.lastAskLevel = state.level;
    log(`[${chatKey}] 内核取等待：${levelLabel(state.level)} ${Math.round(delayMs / 1000)} 秒（窗口 ${people}人/${messages}条）`);
  }
  return { delayMs, level: state.level, people, messages, busyUntil: state.busyUntil };
}

function levelLabel(level) {
  return level >= 3 ? '爆发' : level === 2 ? '忙' : level === 1 ? '轻度忙' : '闲时';
}

export const hooks = {
  'before-incoming'({ chatKey, entry, isPrivate } = {}) {
    try {
      const s = settings();
      if (isPrivate && s.onlyGroups) return;
      observe(String(chatKey ?? ''), entry, s, Date.now());
    } catch (error) {
      log(`观察失败（不影响本轮）：${error?.message ?? error}`);
    }
  }
};

export const providers = {
  'wake.delay': ({ chatKey, isPrivate } = {}) => {
    try {
      return delayForChat(String(chatKey ?? ''), isPrivate === true, settings(), Date.now());
    } catch (error) {
      log(`取等待失败（回落内核固定值）：${error?.message ?? error}`);
      return null;
    }
  },

  'status.group-pacing': () => {
    const s = settings();
    const now = Date.now();
    let state = null;
    let key = '';
    for (const [k, value] of chats) {
      if (!state || value.lastAt > state.lastAt) { state = value; key = k; }
    }
    if (!state) {
      return { icon: '⏱️', title: '群聊节奏', priority: 56, lines: [['状态', s.enabled ? '运行中' : '已关闭'], ['最近', '还没有群消息']] };
    }
    prune(state, now, s);
    decay(state, now, s);
    const { people, messages } = snapshot(state);
    const delay = delayForLevel(state.level, s);
    return {
      icon: '⏱️',
      title: '群聊节奏',
      priority: 56,
      lines: [
        ['状态', s.enabled ? '运行中' : '已关闭'],
        ['最近群', `${key}｜${levelLabel(state.level)}`],
        ['窗口', `${s.windowSeconds} 秒内 ${people} 人 / ${messages} 条`],
        ['当前等待', delay ? `${Math.round(delay / 1000)} 秒` : '闲时（内核原值）'],
        ['保持到', state.level > 0 && state.busyUntil > now ? `${Math.round((state.busyUntil - now) / 1000)} 秒后` : '（无）']
      ]
    };
  }
};

export function setup(a) {
  api = a;
  const s = settings();
  log(`已加载（${BUILD_TAG}）：${s.onlyGroups ? '只管群聊' : '所有会话'}`
    + `｜${s.mildPeople}人/${s.mildMessages}条→${Math.round(s.mildDelayMs / 1000)}秒`
    + `｜${s.busyPeople}人/${s.busyMessages}条→${Math.round(s.busyDelayMs / 1000)}秒`
    + `｜${s.burstPeople}人/${s.burstMessages}条→${Math.round(s.burstDelayMs / 1000)}秒`
    + `｜保持 ${s.holdSeconds} 秒，回落每档 ${s.stepDownSeconds} 秒`);
}

export function available() {
  return settings().enabled !== false;
}

export function deactivate() {
  chats.clear();
}

export function dispose() {
  chats.clear();
}

export const internals = {
  BUILD_TAG,
  settings,
  observe,
  delayForChat,
  delayForLevel,
  rawLevel,
  decay,
  snapshot,
  chats
};
