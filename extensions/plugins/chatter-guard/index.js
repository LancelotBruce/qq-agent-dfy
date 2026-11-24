// 水聊免回（chatter-guard）—— QQ Agent 0.5 原生版本
//
// 0.4 时代它包 `Orchestrator.prototype.onIncoming` 实现「入站即挡、0 token」。
// 0.5 没有这个类（core.orchestrator 是构造出来的方法对象，且经 guards.methods 包装，
// 没有可包的原型），所以改为宿主新增的 `before-incoming` 钩子：
//   kernel/orchestrator.js 的 onIncoming 里、判定/排唤醒之前调用；
//   返回 { skip: true } 即「不触发会话」——宿主负责标已读 + 通知界面，模型不会被叫醒。
//
// 判定规则与 0.4 完全一致：三类水（只有表情/图片、命中水词、同字重复或全标点）
// + 必须连着 N 条且在时间窗内 + 私聊主人一律放行 + @ 它时默认仍然回。

const PLUGIN_ID = 'chatter-guard';

/** 内置水词表（纯水、没有信息量的）。刻意**不含**「在吗」「谢谢」「好的」这类需要回应的。 */
const DEFAULT_FILLERS = [
  '哈哈', '哈哈哈', '哈哈哈哈', '嘿嘿', '嘻嘻', '呵呵', '噗', '草', '卧槽', '我草',
  '6', '666', '牛', '牛啊', '秀', '好活', '绝了', '笑死', '笑死我', '绷', '乐',
  'emmm', 'emm', '呃', '嗯', '啊这', '这', '?', '？', '。。。', '...', '……',
  '233', 'hhh', 'hhhh', 'xd', 'ojbk', '彳亍', '行吧', 'ok', 'OK',
];

let ctxRef = null;
const stats = { suppressed: 0, lastReason: '', lastAt: 0, lastChat: '' };
/** `${chatKey}|${senderId}` → { count, at } */
const streaks = new Map();
const MAX_STREAK_KEYS = 600;

/** 读本插件的设置（configSchema 里声明的键）。 */
function settings() {
  try { return (ctxRef?.config?.all?.() ?? {}) || {}; } catch { return {}; }
}

function splitWords(raw) {
  const out = [];
  for (const item of String(raw ?? '').split(/[,，、;；\s]+/)) {
    const w = item.trim();
    if (w && !out.includes(w)) out.push(w);
  }
  return out;
}

/** 只有表情/图片/卡片，没有一个字。 */
function isMediaOnly(text) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  // 存档里的渲染形式：[图片:xxx] [表情:xxx] [卡片：xxx] [视频:xxx] …
  const stripped = t.replace(/\[[^\]]{0,60}\]/g, '').replace(/[\s\p{P}\p{S}]/gu, '');
  return stripped.length === 0;
}

/** 纯水话：内置/自定义水词、同字重复、全标点。 */
function isFiller(text, cfg = {}) {
  const t = String(text ?? '').trim();
  if (!t) return true;
  const compacted = t.replace(/\s+/g, '');
  const words = [...DEFAULT_FILLERS, ...splitWords(cfg.fillerWords)];
  if (words.some((w) => compacted === w || (w.length >= 2 && compacted === w.repeat(2)))) return true;
  if (!/[\p{L}\p{N}]/u.test(compacted)) return true;          // 全是标点/符号
  if (compacted.length <= 12 && /^(.)\1{2,}$/u.test(compacted)) return true;   // 同一字重复 3 次以上
  return false;
}

/** 这条消息算不算「水」。返回原因字符串，正常消息返回 null。 */
function waterReason(entry, cfg = {}) {
  const text = String(entry?.text ?? '');
  if (cfg.skipMedia !== false && isMediaOnly(text)) return '只有表情/图片';
  if (cfg.skipFiller !== false && isFiller(text, cfg)) return '纯水话';
  return null;
}

/**
 * 连续计数。返回「连着第几条水」。
 * 超过时间窗、或者来了一句正常话 → 重新计数。
 */
function bumpStreak(chatKey, senderId, isWater, cfg = {}) {
  const key = `${chatKey}|${senderId}`;
  const windowMs = Math.max(10, Number(cfg.windowSec) || 180) * 1000;
  const now = Date.now();
  const rec = streaks.get(key);
  if (!isWater) { streaks.delete(key); return 0; }
  if (!rec || now - rec.at > windowMs) {
    streaks.set(key, { count: 1, at: now });
  } else {
    rec.count += 1; rec.at = now;
  }
  while (streaks.size > MAX_STREAK_KEYS) streaks.delete(streaks.keys().next().value);
  return streaks.get(key)?.count || 1;
}

/**
 * before-incoming 处理器。返回 { skip: true } = 免回；返回 undefined = 放行。
 * 任何异常都吞掉并放行 —— 过滤器坏掉不该让机器人整体不响应。
 *
 * 注册方式：0.5 没有 before-incoming 钩子（钩子只有 before-context /
 * before-llm-messages / before-tool / after-tool / after-response，全在
 * agent-runner 的 LLM 时序里，消息还没判定就轮不到它们）。所以这里走能力：
 * 向宿主注册 `incoming.filter`，由 kernel/orchestrator.js 的 onIncoming
 * 与补判定循环在 resolveWake 之前调用。
 *
 * payload: { chatKey, entry, isPrivate, ownerIds, cfg }
 * ownerIds 由宿主从 allow.private 透传（只给主人号，不给完整配置）。
 */
function decide(payload = {}) {
  try {
    const { chatKey, entry, isPrivate, ownerIds } = payload || {};
    const cfg = settings();
    if (cfg.enabled === false) return undefined;
    if (!chatKey || !entry) return undefined;                 // 没有具体条目不否决
    if (entry.self === true) return undefined;                // 机器人自己的消息
    const senderId = String(entry.senderId ?? '');
    if (!senderId || senderId === 'self') return undefined;
    const owners = Array.isArray(ownerIds) ? ownerIds.map(String) : [];

    // ★ 主人私聊是管理通道，一律放行
    const priv = isPrivate ?? String(chatKey).startsWith('private:');
    if (priv && owners.includes(senderId)) return undefined;

    // @ 它时是否仍然回（默认回）
    if (cfg.alwaysReplyWhenAtMe === true && (entry.atMe === true || entry.atAll === true)) {
      streaks.delete(`${chatKey}|${senderId}`);
      return undefined;
    }

    const reason = waterReason(entry, cfg);
    const count = bumpStreak(chatKey, senderId, Boolean(reason), cfg);
    if (!reason) return undefined;
    const threshold = Math.max(2, Number(cfg.threshold) || 3);
    if (count < threshold) return undefined;

    stats.suppressed++;
    stats.lastReason = `${reason}（连着第 ${count} 条）`;
    stats.lastChat = chatKey;
    stats.lastAt = Date.now();
    return { skip: true, reason: stats.lastReason };
  } catch (error) {
    ctxRef?.log?.warn?.(`[chatter-guard] 判定异常，本次放行：${error?.message ?? error}`);
    return undefined;
  }
}

/**
 * 同一条消息可能被两条路各问一次（宿主既调 before-incoming 钩子、又 claim incoming.filter），
 * 3 秒内对同一条目复用上次结论，避免「连续第 N 条」被算两遍。
 */
let dedupe = { key: '', at: 0, out: undefined };

function handle(payload = {}) {
  const key = `${payload?.chatKey ?? ''}#${payload?.entry?.id ?? ''}`;
  if (key === '#' || key.endsWith('#undefined')) return decide(payload);
  const now = Date.now();
  if (dedupe.key === key && now - dedupe.at < 3000) return dedupe.out;
  const out = decide(payload);
  dedupe = { key, at: now, out };
  return out;
}

export function setup(ctx) {
  ctxRef = ctx;
  // 路线 A：宿主若在 onIncoming 里调 before-incoming 钩子
  ctx?.hooks?.on?.('before-incoming', handle);
  // 路线 B：宿主若用能力协商 incoming.filter（认领后返回 {skip:true} 即当场标已读）
  try { ctx?.registerCapability?.('incoming.filter', handle); }
  catch (error) { ctx?.log?.warn?.(`[chatter-guard] 注册 incoming.filter 失败：${error?.message ?? error}`); }
  ctx?.log?.info?.('[chatter-guard] 已挂载入站否决（连续水聊即不触发会话，0 token）');
  ctx?.lifecycle?.onStop?.(() => { ctxRef = null; });
}

/** 自测用。 */
export const internals = { DEFAULT_FILLERS, isMediaOnly, isFiller, waterReason, bumpStreak, streaks, stats, handle };
