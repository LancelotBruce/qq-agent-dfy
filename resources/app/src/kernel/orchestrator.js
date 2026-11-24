// Orchestrator：唤醒调度 + 会话状态机（§6.4/§6.5/§6.8/§6.9/§6.11/§6.12/§6.13）。
// 关键不变量：
// - 逐条判定一次定生死；防抖不重置（窗口内新消息只入库）
// - 私聊运行期间新消息全部保留未读；群聊仅从首次 @我起保留，收尾后合并为下一批
// - 等待会话复用必须用 sessions.current() 活对象（get() 是克隆）
// - 机械批逐条补判定（不能用"有没有等待会话"区分——tier 0 垃圾会话事故）
// - 会话重试硬前提 sent.length===0（R-08：群里不会出现两遍同样的话）
// - 并发满 → 排队，名额释放立即调度；跟踪式 3s 检查兜底，stop 时全部回收
import { resolveContextTier, triggerLabels, isAtMe } from './wake.js';
import { buildSystemPrompt, buildUserPrompt, buildPastState, resolvePromptAnchor, resolveHistoryLimit, formatEntry, ownerIdsOf } from './prompt.js';
import { runAgent } from './agent-runner.js';
import { isRetryableError } from './llm.js';
import { mdToPlain, splitText, prepareTextBatch } from './send-text.js';
import { requestMemoryConsolidation } from '../console/memory-media-adapters.js';
import { personaForChat } from './persona.js';
import { effectiveGlobalBlocklist, resolveGlobalBlocklist } from './ingest.js';
import { isChatQuiet } from './command-mute-state.js';
import { readChatBanState, captureChatBanState } from './chat-ban-state.js';
import { createReplyErrorNotice } from './reply-error-notice.js';
import { allChatsAllowed, chatAllowed } from './chat-access.js';
import { proactivePolicy } from './proactive-policy.js';
import { proactiveActivity } from './proactive-context.js';
import { randomUUID } from 'node:crypto';
import { createPromptContextPrefix } from './prompt-context-prefix.js';

const BATCH_FLOOR_MS = 60_000;   // verified 批：waiting.startedAt - 60s 之后的进批
const DRAIN_MIN_MS = 200;        // drain 下限（§5.1）
const REQUEUE_MS = 3000;         // 并发满重排（§13 T-15）
const BAN_CACHE_MS = 60_000;     // 禁言缓存 60s（§13 T-16 非定时器周期行为）
const ACTIVE_TOPIC_MAX = 60;     // activeTopic ≤60 字（§6.8）
const DISCOVERY_SCAN_WINDOW = 2000; // 与记忆服务身份窗口一致；每位候选实际提炼仍只取最近40条。

function awaitDiscovery(operation, signal) {
  if (!signal) return Promise.resolve(operation);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (action, value) => {
      if (settled) return;
      settled = true; signal.removeEventListener('abort', cancel); action(value);
    };
    const cancel = () => finish(reject, signal.reason ?? new Error('记忆发现已取消'));
    if (signal.aborted) { cancel(); Promise.resolve(operation).catch(() => {}); return; }
    signal.addEventListener('abort', cancel, { once: true });
    Promise.resolve(operation).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

export function createOrchestrator({
  cfg, store, sessions, memory, send, registry, loader, capability = null, transport: transportArg, onebot: onebotArg, log = console, bus = null,
  isPaused = () => false, buildToolsFor = null, execContextFor = null,
  transcribe = null, now = () => Date.now(), llmInvoker = null, components = null, lifecycle = null,
  setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, random = Math.random,
  globalBlocklistOf = null, serviceLeaseOf = null,
} = {}) {
  const systemPromptFor = components?.['core.prompt.system'] ?? buildSystemPrompt;
  const userPromptFor = components?.['core.prompt.user'] ?? buildUserPrompt;
  const pastStateFor = components?.['core.prompt.pastState'] ?? buildPastState;
  const promptAnchorFor = components?.['core.prompt.anchor'] ?? resolvePromptAnchor;
  const agentRunner = components?.['core.agentRunner'] ?? runAgent;
  const resolveWake = components?.['core.wake.resolve'] ?? resolveContextTier;
  const consolidateMemory = components?.['core.memory.consolidate'] ?? requestMemoryConsolidation;
  const plainText = components?.['core.text.plain'] ?? mdToPlain;
  const splitForSend = components?.['core.text.split'] ?? splitText;
  const chatPersonaFor = components?.['core.prompt.persona'] ?? personaForChat;
  const retryableError = components?.['core.session.retryable'] ?? isRetryableError;
  // 模型失败时回一句人话（原始报错只进日志，同类限流）
  const notifyModelError = components?.['core.reply.errorNotice'] ?? createReplyErrorNotice({ send, log, now });
  const transport = transportArg ?? onebotArg ?? null; // 兼容键：存量调用方仍传 onebot
  const pendingWake = new Map();  // chatKey -> { timer, sessionId, proactive }
  const capacityWaiting = new Map(); // Ready batches, in arrival order; no repeated fake countdown.
  let capacityGeneration = 0, capacityDrainScheduled = false;
  const wakeTimers = new Set();   // 全部排程定时器（重排/等待，stop 时全清）
  const active = new Map();       // chatKey -> { topic, until }
  const activeTimers = new Map(); // chatKey -> expiry timer (one timer per topic)
  const banCache = new Map();     // chatKey -> { muted, checkedAt }
  const aborters = new Map();     // sessionId -> AbortController
  const mentionedDuringRun = new Set(); // sessionId：忙时已收到 @我，此后的消息留给下一批
  const wakeChecks = new Set();   // 正在等禁言查询的唤醒；此时尚未创建运行控制器
  const contextPrefixes = createPromptContextPrefix(); // Per-account, bounded, in-memory layout hints.
  let paused = false;
  let discoveryGeneration = 0;
  let discoveryController = new AbortController();
  const pendingDiscovery = new Map();
  function cancelDiscovery() {
    ++discoveryGeneration;
    pendingDiscovery.clear();
    if (!discoveryController.signal.aborted) discoveryController.abort(new Error('记忆发现已暂停或停止'));
  }
  function discoverAfterConversation(chatKey) {
    if (pendingDiscovery.has(chatKey)) return;
    const generation = discoveryGeneration, signal = discoveryController.signal;
    const pending = Promise.resolve().then(() => maybeConsolidate(chatKey, {
      signal, current: () => generation === discoveryGeneration && !isPausedNow(),
    })).catch(error => {
      if (!signal.aborted) log.warn?.(`[memory] 自动发现失败：${error?.message ?? error}`);
    }).finally(() => {
      if (pendingDiscovery.get(chatKey) === pending) pendingDiscovery.delete(chatKey);
    });
    pendingDiscovery.set(chatKey, pending);
  }
  let proactiveTimer = null;
  let proactiveRunning = false;
  const proactiveIdentity = randomUUID();
  let proactiveGeneration = 0, proactiveInterval = '', proactiveNextAt = null, proactiveRevision = 0;
  let proactiveCheck = 0, proactiveLastCheckAt = null, proactiveLastOutcome = null;
  const proactivePlans = new Map(); // Independent deadlines, sharing one timer.
  let reminderTimer = null;
  let reminderStore = null;
  let suspendedLoops = null;
  let reminderGeneration = 0;
  let reminderController = null;
  const reminderProgress = new Map(); // 部分发送成功后的剩余内容，避免下一 tick 重发已送达部分。
  const reminderFiring = new Set();

  const isPausedNow = () => paused || isPaused();
  function removeCapacityWait(chatKey, sessionId = null) {
    const item = capacityWaiting.get(chatKey);
    if (!item || sessionId && item.waitingSessionId !== sessionId) return null;
    clearTimeout(item.timer);wakeTimers.delete(item.timer);capacityWaiting.delete(chatKey);
    return item;
  }
  const capacityEntries = () => [...capacityWaiting.entries()].sort((a,b) => a[1].queuedAt - b[1].queuedAt);
  function refreshCapacityPositions() {
    let position = 0;
    for (const [,item] of capacityEntries()) {
      const session = sessions.peek(item.waitingSessionId);
      if (!session || session.status !== 'waiting') continue;
      position++;
      if (session.progress?.phase !== 'queued' || session.progress.position !== position)
        sessions.update(session, {progress:{phase:'queued',position,since:item.queuedAt,updatedAt:now()}});
    }
  }
  function drainCapacity() {
    if (capacityDrainScheduled || isPausedNow() || !capacityWaiting.size) return;
    capacityDrainScheduled = true;
    const generation = capacityGeneration;
    queueMicrotask(() => {
      capacityDrainScheduled = false;
      if (generation !== capacityGeneration || isPausedNow()) return;
      const free = Math.max(0, (Math.max(1, Number(cfg().maxConcurrentRuns) || 2)) - sessions.running().length);
      for (const [chatKey,item] of capacityEntries().slice(0,free)) {
        removeCapacityWait(chatKey);
        void wake(chatKey, {...item, capacityQueuedAt:item.queuedAt}).catch(error => log.warn?.(`[orch] 排队会话启动失败：${error?.message ?? error}`));
      }
      refreshCapacityPositions();
    });
  }
  const offCapacityEnd = bus?.on?.('session.end', drainCapacity, {internal:true});
  const unreadForWake = (chatKey) => store.unread(chatKey, { includePokes: true });
  let contextWatch = null;
  function watchContext() {
    if (contextWatch || !store.onContextInvalidated) return;
    contextWatch = store.onContextInvalidated(chatKey => {
      promptAnchors.delete(chatKey);
      promptAnchorLimits.delete(chatKey);
      contextPrefixes.delete(chatKey);
    });
  }
  const activeFor = (chatKey) => {
    const state = active.get(chatKey);
    if (state && (cfg().chatActive?.enabled !== true || state.until <= now() || isChatQuiet(cfg().commandMute,chatKey,now()))) {
      active.delete(chatKey);
      const timer = activeTimers.get(chatKey);
      if (timer) { clearTimeout(timer); wakeTimers.delete(timer); }
      activeTimers.delete(chatKey);
      return null;
    }
    return state;
  };

  function retryDelay(ms, signal) {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise((resolve) => {
      const finish = (ready) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(ready); };
      const abort = () => finish(false);
      const timer = setTimeout(() => finish(true), ms);
      signal.addEventListener('abort', abort, { once: true });
    });
  }

  // ---------- 会话级配置（档位/禁言/峰谷/分群四象限）----------
  function storeConfigForChat(chatKey, isPrivate) {
    const c = cfg();
    const s = c.store ?? {};
    const parts = String(chatKey).split(':');
    const gid = parts[parts.length - 1];
    let sliderPos = s.contextSliderPos;
    let tier = s.contextTier ?? 4;
    let randomPercent = s.randomPercent ?? 10;

    if (!isPrivate && s.unifiedTier === false && s.groupSliderPos?.[gid] !== undefined) {
      sliderPos = s.groupSliderPos[gid];
      const t = tierFromSlider(sliderPos);
      tier = t.tier; randomPercent = t.percent;
    }
    // 峰谷（跨零点支持）
    const ps = s.peakSchedule;
    const peakOn = ps?.enabled === true;
    const inPeak = peakOn && withinWindow(ps.peak?.start, ps.peak?.end, new Date(now()));
    if (peakOn) {
      const pos = inPeak ? (ps.peak?.sliderPos ?? 10) : (ps.valley?.sliderPos ?? 100);
      const t = tierFromSlider(pos);
      tier = t.tier; randomPercent = t.percent;
    }
    // 分群峰谷叠加（四象限：分群档位之上再取峰谷）
    if (!isPrivate && s.unifiedTier === false && peakOn && s.groupPeakPos?.[gid]) {
      const gp = s.groupPeakPos[gid];
      const pos = inPeak ? (gp.peak ?? pos0(ps, inPeak)) : (gp.valley ?? pos0(ps, inPeak));
      const t = tierFromSlider(pos);
      tier = t.tier; randomPercent = t.percent;
    }
    // 指令禁言强制 1 档
    const commandMuteTier = isChatQuiet(c.commandMute,chatKey,now()) ? 1 : null;
    // This context is also used by active-topic/retry paths which may not call
    // resolveWake again. Keep private effective tiers independent everywhere.
    if (isPrivate) { tier = 4; randomPercent = 100; }
    return {
      contextTier: tier, randomPercent, keywords: s.keywords ?? [], historyCount: s.historyCount ?? 80,
      unifiedTier: s.unifiedTier !== false,
      botName: c.persona?.botName, selfNickname: c.persona?.selfNickname, selfId: transport?.selfId,
      commandMuteTier,
    };
  }

  function pos0(ps, inPeak) { return inPeak ? (ps.peak?.sliderPos ?? 10) : (ps.valley?.sliderPos ?? 100); }

  function tierFromSlider(pos) {
    const p = Math.max(0, Math.min(100, Number(pos) ?? 100));
    if (p <= 10) return { tier: 1, percent: 10 };
    if (p <= 20) return { tier: 2, percent: 10 };
    if (p < 90) return { tier: 3, percent: Math.round(((p - 20) / 70) * 100) };
    return { tier: 4, percent: 100 };
  }

  function withinWindow(start, end, date) {
    const toMin = (value) => {
      const m = String(value ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const hour = Number(m[1]); const minute = Number(m[2]);
      return hour > 23 || minute > 59 ? null : hour * 60 + minute;
    };
    const s = toMin(start); const e = toMin(end);
    if (s === null || e === null || s === e) return false;
    const cur = date.getHours() * 60 + date.getMinutes();
    if (s < e) return cur >= s && cur < e;
    return cur >= s || cur < e; // 跨零点（22:00~06:00）
  }

  // ---------- 入站：逐条判定一次定生死（§6.4）----------
  /**
   * 入站前置否决（0.5 原生替代 0.4 的 Orchestrator.prototype.onIncoming 包裹）。
   * 插件以 `export const hooks = { 'before-incoming': fn }` 注册；任一处理器返回
   * { skip: true } 即视为「不触发会话」：标已读 + 通知界面 + 直接返回，模型不会被叫醒（0 token）。
   * 只透传主人号（allow.private），不把完整配置（含密钥）交给插件。
   */
  async function vetoIncoming(chatKey, entry, isPrivate) {
    const list = loader?.hooksOf?.('before-incoming') ?? [];
    if (!list.length) return false;
    const owners = ownerIdsOf(cfg()).map(String);
    for (const { fn, ownerId, recordError } of list) {
      try {
        const verdict = await fn({ chatKey, entry, isPrivate, ownerIds: owners });
        if (verdict?.skip === true) {
          log.info?.(`[orch] 入站否决（${ownerId}）：${verdict.reason ?? ''}`);
          return true;
        }
      } catch (error) {
        recordError?.(error);
        log.warn?.(`[orch] before-incoming（${ownerId}）：${error?.message ?? error}`);
      }
    }
    return false;
  }

  async function onIncoming(chatKey, entry) {
    watchContext();
    if (entry.recalled) return;
    if (isPausedNow()) return;
    const isPrivate = chatKey.startsWith('private:');
    if (await vetoIncoming(chatKey, entry, isPrivate)) {
      // 与核心「不触发」路径一致：消息照常入库，只是不叫醒模型。
      store.markEntryRead(chatKey, entry.id);
      bus?.emit('chat.update', chatKey);
      return;
    }
    if(isChatQuiet(cfg().commandMute,chatKey,now())){
      const c=cfg(),called=entry.atMe===true||(entry.atMe==null&&isAtMe(entry.text,{...c.persona,selfId:transport?.selfId}))||entry.isPoke&&/拍了拍\s*我/.test(String(entry.text??''));
      if(!called){
        // Quiet is checked before the private busy queue. Otherwise an early
        // resume could replay ordinary messages received while already quiet.
        store.markEntryRead(chatKey,entry.id);bus?.emit('chat.update',chatKey);return;
      }
    }
    const runningSession = (isPrivate ? (sessions.running?.() ?? []).find(s => s.chatKey === chatKey && aborters.has(s.id)) : null)
      ?? sessions.current(chatKey);
    if (runningSession?.status === 'running') {
      // Keep the current batch frozen. All later private messages belong to the
      // next batch, including ordinary follow-ups which contain no mention.
      if (isPrivate) return;
      // 本轮触发批已经固定；首次 @我（含别人拍机器人）及其后续消息，等本轮结束后统一处理。
      // 拍一拍准入已核实操作者与目标，机器人主动拍人和群友互拍不会走到这里。
      if (entry.atMe === true) mentionedDuringRun.add(runningSession.id);
      if (mentionedDuringRun.has(runningSession.id)) return;
      store.markEntryRead(chatKey, entry.id);
      bus?.emit('chat.update', chatKey);
      return;
    }
    if (!cfg().api?.model) return;         // 模型未设置：不判定（消息留未读，配好后自动补处理）
    if (pendingWake.has(chatKey) || capacityWaiting.has(chatKey)) return;  // 等待/排队中只入库，不重置或重复建批。
    if (activeFor(chatKey)) { // 活跃期必响应
      scheduleWake(chatKey, null, { verified: false, proactive: false });
      return;
    }
    const c = storeConfigForChat(chatKey, isPrivate);
    // 入站否决点（chatter-guard 等）：0.5 原本只有内建的 resolveWake，没有"插件先
    // 一票否决"的位置，0.4 的老插件只能去包 Orchestrator.prototype（0.5 已无此物）。
    // 提供者返回 {skip:true} 即当场标已读、不建会话、不叫模型（省 token 的关键）。
    const veto = capability?.claim?.('incoming.filter', {
      chatKey, entry, isPrivate, ownerIds: ownerIdsOf(c), cfg: c
    });
    if (veto?.result?.skip === true) {
      store.markEntryRead(chatKey, entry.id);
      bus?.emit('chat.update', chatKey);
      log.info?.(`[orch] ${chatKey} 入站否决（${veto.ownerId}）：${veto.result.reason ?? 'plugin'}`);
      return;
    }
    const verdict = resolveWake({ entry, cfg: c, isPrivate, roll: null });
    if (!verdict.shouldRespond) {
      // 不触发 → 当场标已读（未读一闪即已读）
      store.markEntryRead(chatKey, entry.id);
      bus?.emit('chat.update', chatKey);
      return;
    }
    entry._tier = verdict.tier;
    entry._reason = verdict.reason;
    // 硬口令快速唤醒（2026-11-21）：@ 我并且说的是余额/用量，不等 wakeDelayMs 攒消息，
    // 立刻开跑——避免"查余额还要等下一个人的话"。
    const fastAt = entry?.atMe === true || (entry?.atMe == null && isAtMe(String(entry?.text ?? ''), { ...c.persona, selfId: transport?.selfId }));
    const fastCmd = fastAt && /(查余额|余额|还剩多少钱|钱够不够|今日用量|当日用量|今天用量|用量|花费|花了多少)/.test(String(entry?.text ?? ''));
    scheduleWake(chatKey, fastCmd ? 600 : null, { verified: true });
  }

  // ---------- 等待倒计时（固定不重置）----------
  // 私聊/群聊分档等待（大胖鱼改）：0.4 的 wakeDelayMsPrivate 在 0.5 内核里没有消费者，
  // 这里按会话前缀分流补回来。群聊走 wakeDelayMs，私聊走 wakeDelayMsPrivate（<=0 时回落群聊值）。
  function wakeBaseDelay(chatKey) {
    const privateMs = Number(cfg().wakeDelayMsPrivate);
    if (String(chatKey ?? '').startsWith('private:') && privateMs > 0) return privateMs;
    return Number(cfg().wakeDelayMs) || 2000;
  }
  function scheduleWake(chatKey, delayOverride = null, { verified = false, proactive = false, proactiveGuard = null, sessionId = null, reuse = false } = {}) {
    if (pendingWake.has(chatKey)) return pendingWake.get(chatKey).sessionId;
    const delay = delayOverride ?? Math.max(200, wakeBaseDelay(chatKey));
    let sid = sessionId;
    if (!sid && !reuse) {
      const unread = unreadForWake(chatKey);
      const first = unread[0];
      const trigger = first ? `${first.senderName}：${String(first.text).slice(0, 40)}` : '（补充处理）';
      const s = sessions.create(chatKey, { trigger, waitUntil: now() + delay });
      sessions.update(s, { status: 'waiting', waitUntil: now() + delay, verified, proactive });
      sid = s.id;
    }
    const timer = setTimeout(() => {
      pendingWake.delete(chatKey);
      wakeTimers.delete(timer);
      wake(chatKey, { waitingSessionId: sid, verified, proactive, proactiveGuard }).catch((err) => {
        log.error?.(`[orch] wake(${chatKey}) 异常：${err?.stack || err}`);
      });
    }, delay);
    wakeTimers.add(timer);
    pendingWake.set(chatKey, { timer, sessionId: sid, proactive, proactiveGuard, verified });
    bus?.emit('session.update', sessions.peek(sid) ?? {});
    return sid;
  }

  // ---------- 自己被禁言查询（§6.5.3；判据必须"到期时刻在未来"）----------
  async function checkSelfMuted(chatKey, isCancelled = () => false, signal) {
    const gid = chatKey.split(':').pop();
    // Budget/extension decisions change between rounds and on disable/reload.
    // Never cache them as if QQ itself had muted the account.
    const policySnapshot = captureChatBanState(capability);
    const currentPolicy = result => policySnapshot.isCurrent() ? result : { muted: false, stale: true };
    const policy = await readChatBanState(capability, chatKey, { signal, log, snapshot: policySnapshot });
    if (isCancelled()) return { muted: false };
    if (policy.muted || policy.stale) return currentPolicy(policy);
    // 快路径：chat.ban-state 能力（有通知记录直接用）
    let muted = false;
    try {
      const p = banStateProvider?.();
      if (p?.check) muted = !!(await p.check(gid));
    } catch { /* 回落慢路径 */ }
    if (isCancelled()) return { muted: false };
    if (muted) return currentPolicy({ muted: true });
    const cached = banCache.get(chatKey);
    if (cached && now() - cached.checkedAt < BAN_CACHE_MS) return currentPolicy(cached);
    if (!muted) {
      // 慢路径走 transport 归一化动作（平台语义在 provider 内消化，transport.js:2 架构约束）。
      // SUSPECT 判据（"到期时刻在未来"）已随实现移入 OneBot provider 的 getSelfMemberInfo。
      try {
        const r = await transport?.actions?.getSelfMemberInfo?.(chatKey);
        if (r) muted = !!r.muted; // null = 平台无法判定，按未禁言处理
      } catch { muted = false; }
    }
    if (isCancelled()) return { muted: false };
    banCache.set(chatKey, { muted, checkedAt: now() });
    return currentPolicy({ muted });
  }
  let banStateProvider = null;

  // ---------- wake：取触发批与运行（§6.5 顺序闸）----------
  async function wake(chatKey, { waitingSessionId = null, verified = false, proactive = false, proactiveGuard = null, capacityQueuedAt = null } = {}) {
    const queued = capacityWaiting.get(chatKey);
    if (queued && waitingSessionId && queued.waitingSessionId !== waitingSessionId) {
      const duplicate = sessions.peek(waitingSessionId);
      if (duplicate?.status === 'waiting') sessions.discard(duplicate.id);
      return;
    }
    const previousCapacity = removeCapacityWait(chatKey, waitingSessionId);
    capacityQueuedAt ??= previousCapacity?.queuedAt;
    watchContext();
    activeFor(chatKey); // 事件循环拥塞或时钟跳变时也遵守绝对到期时刻。
    const c = cfg();
    const isPrivate = chatKey.startsWith('private:');
    let waiting = waitingSessionId ? sessions.peek(waitingSessionId) : sessions.current(chatKey);
    if (waitingSessionId && (!waiting || !['waiting', 'running'].includes(waiting.status))) return;
    const abortWaiting = (reason) => {
      if (waiting) sessions.finish(waiting.id, 'aborted', { error: reason });
    };
    const staleProactive = () => proactive && typeof proactiveGuard === 'function' && !proactiveGuard();
    const discardProactive = () => { if (waiting?.status === 'waiting') sessions.discard(waiting.id); return { skipped: 'changed' }; };
    if (staleProactive()) return discardProactive();
    // 闸 1
    if (isPausedNow()) return abortWaiting('全局暂停');
    {
      const running = sessions.running().find(s => s.chatKey === chatKey && aborters.has(s.id));
      if (running) {
        // Capacity requeues/manual wakes can leave redundant waiting records.
        // The running batch owns the next drain: remove stale wait timers and
        // records, never consume its unread follow-ups in a concurrent run.
        const queued = pendingWake.get(chatKey);
        if (queued) {
          clearTimeout(queued.timer); wakeTimers.delete(queued.timer); pendingWake.delete(chatKey);
          const duplicate = sessions.peek(queued.sessionId);
          if (duplicate && duplicate !== running && duplicate.status === 'waiting') sessions.discard(duplicate.id);
        }
        if (waiting && waiting !== running && waiting.status === 'waiting') sessions.discard(waiting.id);
        return;
      }
    }
    // 闸 2：模型未设置 → 消息保留未读（配好后自动补处理）
    if (!c.api?.model) { abortWaiting('模型未设置'); return { skipped: 'no-model' }; }
    if (proactive && isChatQuiet(c.commandMute,chatKey,now())) return { skipped: 'quiet' };
    // 闸 3：自己被禁言（群聊）
    if (!isPrivate) {
      const check = { waiting, cancelled: false, controller: new AbortController() };
      const waitingInvalid = () => waiting && (sessions.peek(waiting.id) !== waiting || !['waiting', 'running'].includes(waiting.status));
      wakeChecks.add(check);
      let muted;
      try {
        muted = await checkSelfMuted(chatKey, () => check.cancelled || isPausedNow() || waitingInvalid(), check.controller.signal);
      } finally {
        wakeChecks.delete(check);
      }
      // 查询期间 waiting 可以已被丢弃；暂停后立刻恢复也不能复活旧唤醒。
      // 必须在标读/重排/转 running 之前检查，禁言结果为 true 时也同样适用。
      if (check.cancelled || waitingInvalid()) return;
      if (isPausedNow()) return abortWaiting('全局暂停');
      if (staleProactive()) return discardProactive();
      if (muted.stale) {
        // Retry a live policy selection instead of consuming a result from a
        // disabled/replaced generation or starting a model with stale consent.
        scheduleWake(chatKey, REQUEUE_MS, { sessionId: waiting?.id, verified, proactive, proactiveGuard });
        return { skipped: 'changed' };
      }
      if (muted.muted) {
        store.markAllRead(chatKey); // 消息不丢，解除后可作历史
        bus?.emit('chat.update', chatKey);
        if (waiting) sessions.finish(waiting.id, 'aborted', { error: muted.reason || '机器人被禁言' });
        return { skipped: 'muted' };
      }
    }
    activeFor(chatKey); // 查询禁言期间也可能保存了关闭活跃期，取批前重新校正。
    // 闸 4：并发满 → 保留一条排队批；名额释放即时启动，3 秒检查仅作兜底。
    const maxConcurrent = Math.max(1, Number(c.maxConcurrentRuns) || 2);
    if (sessions.running().length >= maxConcurrent) {
      if (!waiting) waiting = sessions.create(chatKey, {trigger:'等待处理',waitUntil:now() + REQUEUE_MS});
      const item = {waitingSessionId:waiting?.id ?? null, verified, proactive, proactiveGuard, queuedAt:capacityQueuedAt ?? now(), timer:null};
      if (waiting) sessions.update(waiting, { waitUntil:null, status:'waiting', progress:{phase:'queued',position:capacityWaiting.size + 1,since:item.queuedAt,updatedAt:now()} });
      const t = setTimeout(() => {
        reminderTimersDelete(t);
        if (capacityWaiting.get(chatKey) !== item) return;
        capacityWaiting.delete(chatKey);
        wake(chatKey, { waitingSessionId:item.waitingSessionId, verified, proactive, proactiveGuard, capacityQueuedAt:item.queuedAt }).catch(() => {});
      }, REQUEUE_MS);
      item.timer = t;capacityWaiting.set(chatKey,item);refreshCapacityPositions();
      wakeTimers.add(t); // 必须入表——否则 stop() 后幽灵唤醒
      return;
    }

    // 闸 5：取触发批
    const quietNow = isChatQuiet(cfg().commandMute,chatKey,now());
    if (staleProactive()) return discardProactive();
    if (proactive && quietNow) return { skipped: 'quiet' };
    const unreadAll = unreadForWake(chatKey);
    if (unreadAll.length === 0 && !proactive) {
      if (waiting) sessions.discard(waiting.id);
      return;
    }
    let batch = [];
    if (proactive) {
      batch = [];
    } else if (waiting?.retryTriggerIds?.length && !quietNow) {
      const ids = new Set(waiting.retryTriggerIds);
      batch = unreadAll.filter((m) => ids.has(m.id));
    } else if (isPrivate && !quietNow) {
      // Every accepted private unread entry is eligible. Provider timestamps
      // can be delayed or out of order; neither the group freshness cutoff nor
      // a timestamp comparison may silently discard/split private follow-ups.
      batch = unreadAll;
    } else if (active.has(chatKey) && !quietNow) {
      batch = unreadAll; // 活跃期忽略档位，不重掷随机判定
    } else if (verified && waiting && !quietNow) {
      const floor = (waiting.startedAt ?? now()) - BATCH_FLOOR_MS;
      const fresh = unreadAll.filter((m) => m.ts >= floor);
      const stale = unreadAll.filter((m) => m.ts < floor);
      for (const m of stale) store.markEntryRead(chatKey, m.id); // 旧积压标已读沉历史
      batch = fresh;
    } else {
      // 机械批：逐条补判定（与 onIncoming 同口径）找最早触发消息
      const cfgChat = storeConfigForChat(chatKey, isPrivate);
      let firstTrigger = null;
      const rejectedIds = new Set();
      for (const m of unreadAll) {
        // 补判定也要走同一个入站否决点，否则被 chatter-guard 挡掉的连续水聊
        // 会在补判定里重新过一遍 resolveWake（3 档随机可能让它又触发）。
        const veto = capability?.claim?.('incoming.filter', {
          chatKey, entry: m, isPrivate, ownerIds: ownerIdsOf(cfgChat), cfg: cfgChat
        });
        if (veto?.result?.skip === true) {
          store.markEntryRead(chatKey, m.id);
          rejectedIds.add(m.id);
          continue;
        }
        const v = resolveWake({ entry: m, cfg: cfgChat, isPrivate, roll: null });
        // 3 档掷过骰了，结果随手带在 entry 上供第 6 步固定复用（同一条消息只骰一次）
        m._tier = v.tier;
        m._reason = v.reason;
        if (v.shouldRespond) { firstTrigger = m; break; }
        // 补判定同样一次定生死：前缀沉历史，不能留给下一轮 drain 重掷。
        store.markEntryRead(chatKey, m.id);
        rejectedIds.add(m.id);
      }
      if (rejectedIds.size) bus?.emit('chat.update', chatKey);
      if (!firstTrigger) {
        store.markAllRead(chatKey); // 全不触发 → 全部标已读
        if (waiting) sessions.discard(waiting.id); // 没有实际运行，不保留内部控制状态。
        return;
      }
      // “该条及之后”按存档到达顺序取批。协议消息通常只有秒级时间，
      // 拍一拍可能是毫秒级；比较时间戳会漏掉同一秒内后到的普通消息。
      batch = unreadAll.slice(unreadAll.indexOf(firstTrigger));
    }
    if (batch.length === 0 && !proactive) { if (waiting) sessions.discard(waiting.id); return; }
    // 触发批一旦被运行消费即标已读；失败时按本批 id 恢复。
    for (const entry of batch) store.markEntryRead(chatKey, entry.id);

    // 6. 档位固定（SPEC §6.5 第 6 点）
    // 用户钦定语义（2026-10-06）：单条消息的随机判定**全程只骰一次**。
    // 首次判定（onIncoming / 机械批补判定）已经把骰子结果写进 entry._reason，
    // 这里直接复用，不再调用 resolveContextTier —— 避免同一条消息被掷第二次。
    const cfgChat = storeConfigForChat(chatKey, isPrivate);
    const first = batch[0];
    const verdict = isPrivate && cfgChat.commandMuteTier !== 1
      ? { tier: 4, reason: '私聊' }
      : waiting?.retryTriggerIds?.length && typeof waiting.contextTier === 'number' && waiting.contextReason
      ? { tier: waiting.contextTier, reason: waiting.contextReason }
      : active.has(chatKey) && !proactive
      ? { tier: cfgChat.commandMuteTier ?? Math.min(4, Math.max(1, Number(cfgChat.contextTier) || 4)), reason: '活跃期' }
      : first
      ? (typeof first._tier === 'number' && first._reason
          ? { tier: first._tier, reason: first._reason }
          : resolveWake({ entry: first, cfg: cfgChat, isPrivate, roll: null }))
      : { tier: 0, reason: '主动' };

    // 7. 会话状态机：等待会话原地转 running
    // waiting 摘要仍是首条未读快照（§6.4）；运行时以实际消费批为准，
    // 旧积压被过滤后不能继续把它显示为本次触发消息。
    const trigger = batch[0] ? `${batch[0].senderName}：${String(batch[0].text).slice(0, 40)}` : '主动开话题';
    let session = waiting;
    if (!session || session.status === 'discarded') {
      session = sessions.create(chatKey, { trigger });
    }
    sessions.update(session, {
      status: 'running', trigger, verified, proactive, contextReason: verdict.reason, contextTier: verdict.tier,
      startedAt: now(), triggerEntryIds: batch.map((m) => m.id), retryTriggerIds: null,
      waitUntil:null, progress:{phase:'preparing',since:now(),updatedAt:now()},
    });

    // 同一个控制器覆盖所有尝试和退避；中止后不能为重试创建新信号。
    const controller = new AbortController();
    aborters.set(session.id, controller);
    const contextScope = store.watchContext?.(session.id, () => {
      if (session.status !== 'running' || controller.signal.aborted) return;
      const error = Object.assign(new Error('消息撤回或删除，当前上下文已失效'), { __aborted: true, __contextInvalidated: true });
      controller.abort(error);
      sessions.finish(session.id, 'aborted', { error: error.message });
    });
    contextScope?.capture(chatKey, batch);
    // 显式 0 关闭会话重试；缺省/非有限值才沿用默认 2 次。
    const retryBudget = Number(c.sessionRetryAttempts ?? 2);
    const maxAttempts = 1 + (Number.isFinite(retryBudget) ? Math.min(5, Math.max(0, Math.floor(retryBudget))) : 2);
    let attempt = 0;
    while (attempt < maxAttempts) {
      if (controller.signal.aborted || session.status === 'aborted' || isPausedNow()) {
        sessions.finish(session.id, 'aborted', { error: String(controller.signal.reason?.message ?? '已中止') });
        break;
      }
      attempt += 1;
      try {
        const result = await runOnce({ chatKey, session, batch, cfgChat, isPrivate, proactive, proactiveGuard, signal: controller.signal, contextScope });
        if (result.error) throw result.error;
        // 收尾：sent>0 → done；否则 noreply（正常选项不是错误）
        sessions.finish(session.id, result.sent.length > 0 ? 'done' : 'noreply', {
          sent: result.sent, usage: result.usage, rounds: result.rounds,
          finishReason: result.finishReason, promptChars: result.promptChars, model: result.model, vendor: result.vendor,
        });
        discoverAfterConversation(chatKey);
        break;
      } catch (err) {
        const sentEmpty = !(sessions.peek(session.id)?.sent?.length);
        const canRetry = attempt < maxAttempts && retryableError(err) && sentEmpty && !err?.__aborted && !controller.signal.aborted && session.status === 'running' && !isPausedNow();
        if (canRetry) {
          const backoff = 1000 * Math.pow(2, attempt - 1);
          log.warn?.(`[orch] ${chatKey} 第 ${attempt} 次失败，${backoff}ms 后原地重试：${err?.message}`);
          resetForRetry(session);
          if (!await retryDelay(backoff, controller.signal)) {
            sessions.finish(session.id, 'aborted', { error: String(controller.signal.reason?.message ?? '已中止') });
            break;
          }
          continue;
        }
        sessions.finish(session.id, err?.__aborted || controller.signal.aborted ? 'aborted' : 'error', { error: String(err?.message ?? err) });
        if (!err?.__aborted && !controller.signal.aborted && session.status !== 'aborted' && !proactive) {
          // 群里一句人话，而不是静默消失或把上游原始 JSON 贴出来；同类 5~10 分钟限流。
          Promise.resolve(notifyModelError(chatKey, err)).catch(() => {});
        }
        break;
      }
    }
    mentionedDuringRun.delete(session.id);
    aborters.delete(session.id);
    contextScope?.stop();
    drainCapacity();
    // 10. 私聊全部忙时未读、群聊忙时 @我及其后续消息，合并接续一轮。
    // 群聊其余忙时消息已标读，不能触发补跑。
    // 真正恢复的未消费积压也继续使用同一套机械判定。
    const rest = unreadForWake(chatKey);
    if (rest.length > 0 && !isPausedNow() && (!controller.signal.aborted || controller.signal.reason?.__contextInvalidated)) {
      scheduleWake(chatKey, Math.max(DRAIN_MIN_MS, Number(c.drainDelayMs) || 1200), { verified: false, reuse: false });
    }
    return { sessionId: session.id, status: session.status };
  }

  function resetForRetry(session) {
    sessions.update(session, { error: null, finishReason: null, activeTopic: null });
  }

  // ---------- 单轮运行（prompt 组装 → agent 循环 → 收尾）----------
  async function runOnce({ chatKey, session, batch, cfgChat, isPrivate, proactive, proactiveGuard, signal, contextScope }) {
    const c = cfg();
    session.sendImageState = { previewed: [], previews: 0, sent: 0 }; // 图片预览/发送额度属于一次运行，工具轮次内共享。
    // 组装前允许确定性插件加工上下文；之后的 before-llm-messages 仍只处理标准消息。
    const callbackContext = { session, chatKey, triggerEntries: batch, signal, botName: c.persona?.botName };
    for (const { fn, ownerId, recordError, managesTimeout } of loader?.hooksOf?.('before-context') ?? []) {
      let timer;
      try {
        const call = Promise.resolve().then(() => fn(callbackContext));
        await (managesTimeout ? call : Promise.race([
          call,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('before-context 超时')), 5000); }),
        ]));
      } catch (err) { if (!managesTimeout && /before-context 超时/.test(err?.message ?? '')) recordError?.(err); log.error?.(`[orch] before-context (${ownerId})：${err?.message ?? err}`); }
      finally { clearTimeout(timer); }
      if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    }
    const globalBlocklist = await resolveGlobalBlocklist(c, globalBlocklistOf, signal);
    const checkProactive = () => {
      if (proactive && (typeof proactiveGuard === 'function' && !proactiveGuard()
        || isPrivate && globalBlocklist.includes(chatKey.slice(8)))) {
        throw Object.assign(new Error('主动聊天条件已变化，本次已跳过'), { __aborted: true });
      }
    };
    checkProactive();
    const validEntries = store.recent(chatKey, Infinity, { forContext: true });
    const validIds = new Map(validEntries.map(entry => [entry.id, entry]));
    batch = batch.filter(entry => !entry.recalled && validIds.has(entry.id)).map(entry => ({ ...entry, reply: validIds.get(entry.id).reply }));
    const keywordHit = batch.length > 0;
    void keywordHit;
    // 历史与触发批
    // Reuse the valid projection already read after before-context. A fixed
    // archive slice loses configured history and spends its budget on triggers.
    const batchIds = new Set(batch.map(entry=>entry.id));
    // A busy-time mention and its following messages belong to the next batch.
    // Async before-context/blocklist work must not expose them as read history.
    const all = validEntries.filter(entry=>batchIds.has(entry.id)||entry.read!==false);
    const excludeIds = new Set(batch.map((m) => m.id));
    const pastLimit = resolveHistoryLimit(cfgChat.historyCount);
    const past = pastStateFor(all, {
      excludeIds, limit: pastLimit,
      globalBlocklist,
      blocklistForChat: c.blocklist?.[chatKey.split(':').pop()] ?? [],
      memberNotes: c.memberNotes ?? {},
      speakerFormat: speakerFormatFn,
    });
    // 锚点（前缀缓存）
    const anchorCfg = c.store?.promptAnchor ?? {};
    const cacheStableTranscript = userPromptFor === buildUserPrompt && pastStateFor === buildPastState && promptAnchorFor === resolvePromptAnchor;
    let anchorState = null; let pastForPrompt = past; let newReadForPrompt = null;
    if (anchorCfg.enabled === false || pastLimit === 0 || promptAnchorLimits.get(chatKey) !== pastLimit) {
      promptAnchors.delete(chatKey);
      promptAnchorLimits.delete(chatKey);
    }
    session.promptAnchorState = null;
    session.promptAnchorMode = null;
    if (anchorCfg.enabled !== false && pastLimit > 0) {
      const prevAnchor = promptAnchors.get(chatKey);
      const allRead = pastStateFor(all, {
        excludeIds, limit: Infinity, globalBlocklist,
        blocklistForChat: c.blocklist?.[chatKey.split(':').pop()] ?? [],
        memberNotes: c.memberNotes ?? {}, speakerFormat: speakerFormatFn,
      }).messages;
      const decision = promptAnchorFor({
        readMessages: past.messages,
        allReadMessages: allRead,
        prevAnchor,
        maxExtraRead: Number.isFinite(Number(anchorCfg.maxExtraRead)) && Number(anchorCfg.maxExtraRead)>=0 ? Number(anchorCfg.maxExtraRead) : 50,
        newUserIds: new Set(),
        triggerEntries: batch,
        preserveOnNewMembers: cacheStableTranscript,
      });
      promptAnchors.set(chatKey, decision.anchor);
      promptAnchorLimits.set(chatKey, pastLimit);
      anchorState = decision;
      session.promptAnchorState = decision.anchor;
      session.promptAnchorMode = decision.mode;
      // 锚定成立时已读 = 锚点 + 追加（可超 historyCount——2026-09-26 修的事故）
      if (decision.mode === 'anchor') {
        const extra = decision.extraMessages;
        const fullPast = pastStateFor(decision.anchorMessages, {
          excludeIds: new Set(), limit: Math.max(decision.anchorMessages.length, 1),
          globalBlocklist,
          blocklistForChat: c.blocklist?.[chatKey.split(':').pop()] ?? [],
          memberNotes: c.memberNotes ?? {},
          speakerFormat: speakerFormatFn,
        });
        pastForPrompt = fullPast;
        newReadForPrompt = extra;
      }
    }
    contextScope?.capture(chatKey, [...batch, ...pastForPrompt.messages, ...(newReadForPrompt ?? [])]);
    // 相关成员集（锚定模式 → 锚点成员集）
    const contextMessages = [...pastForPrompt.messages, ...(newReadForPrompt ?? []), ...batch];
    const memberIds = [...new Set(contextMessages.map(m=>m.self?'':String(m.senderId??'')).filter(id=>id&&id!=='self'))];
    const preferredUserIds = [...new Set(batch.map(m=>m.self?'':String(m.senderId??'')).filter(id=>id&&id!=='self'))];
    const memoryContext = memberIds.length ? (memory?.formatForPrompt?.(chatKey, { userIds: memberIds, preferredUserIds, stableOrder: true,
      ...(cacheStableTranscript && anchorCfg.enabled!==false ? {structured:true} : {}) }) ?? '') : '';
    const memText=typeof memoryContext?.text==='string'?memoryContext.text:memoryContext;
    const memoryRecords=Array.isArray(memoryContext?.records)?memoryContext.records:null;
    // The default layout already includes all current relevant memories;
    // repeating every extra sender would waste input tokens.
    const newMemberIds = !cacheStableTranscript && newReadForPrompt
      ? [...new Set(newReadForPrompt.map((m) => String(m.senderId)).filter((id) => id && id !== 'self' && !memberIds.includes(id)))]
      : [];
    const newMemberText = newMemberIds.length > 0
      ? (memory?.formatForPrompt?.(chatKey, { userIds: newMemberIds, stableOrder: true }) ?? '')
      : '';
    // 表情库清单（M2 落 sticker-tools 后接真数据；此处读取注入点）
    const stickerListText = stickerListProvider ? await stickerListProvider(chatKey, c.sticker?.promptMaxTokens ?? c.sticker?.promptMaxStickers ?? 10, {signal}) : '';

    let chatPersona = chatPersonaFor(c, chatKey);
    // 主人识别（SPEC §7.5 message.owner-check）：触发批里有没有主人在说话（只按 QQ 号），
    // 有 → 换主人专属人设 + 追加主人规则（priority 72）。能力缺省 = 完全回退全局人设。
    let ownerRules = [];
    const ownerChecker = capability?.providers?.('message.owner-check')?.[0]?.provider;
    if (typeof ownerChecker === 'function') {
      try {
        const verdict = await ownerChecker({ chatKey, entries: batch, cfg: c });
        if (verdict?.persona) chatPersona = { ...chatPersona, ...verdict.persona, botName: chatPersona.botName, selfNickname: c.persona?.selfNickname };
        if (Array.isArray(verdict?.rules)) ownerRules = verdict.rules;
      } catch (err) { log.warn?.(`[orchestrator] message.owner-check 异常（回退全局人设）：${err?.message ?? err}`); }
    }
    const activity=proactive?proactiveActivity(all,[...globalBlocklist,...(c.blocklist?.[chatKey.split(':').pop()]??[])]):null;
    if(activity)contextScope?.capture(chatKey,activity.sources);
    const projected=new Map(contextMessages.map(m=>[m.id,m]));
    const conversationMessages=all.filter(m=>projected.has(m.id)).map(m=>projected.get(m.id));
    const useContextPrefix=cacheStableTranscript && anchorCfg.enabled!==false;
    if(!useContextPrefix)contextPrefixes.delete(chatKey);
    const userPrompt = await userPromptFor({
      lifecycle, chatPersona, triggerEntries: batch, pastState: pastForPrompt, memText, newMemberText, stickerListText, isPrivate,
      activeTopic: activeFor(chatKey)?.topic ?? null,
      anchorState, memberNotes: c.memberNotes ?? {}, speakerFormat: speakerFormatFn, now: new Date(now()), proactive,proactiveContext:activity?.context,
      cacheStableTranscript,memoryRecords,
      conversationMessages,
      contextPrefix:useContextPrefix?contextPrefixes.forChat(chatKey,{memText,memoryRecords,stickerListText,windowStart:conversationMessages[0]?.id??null}):null,
    });
    const skillSections = await loader?.promptSections?.(callbackContext) ?? [];
    if (signal?.aborted) throw signal.reason ?? new Error('已中止');
    const systemPrompt = await systemPromptFor({ lifecycle, cfg: { ...c, persona: chatPersona }, chatKey, isPrivate, skillSections, extraSections: ownerRules, ownerIds: ownerIdsOf(c) });
    session.promptChars = systemPrompt.length + userPrompt.length;

    // 工具集（唯一口径；excludedTools 可解释）
    const toolBundle = buildToolsFor ? buildToolsFor({ chatKey, session, c, cfgChat }) : { tools: [], excludedTools: [] };
    session.excludedTools = toolBundle.excludedTools ?? [];
    // 按需加载（工具收纳）可见化：日志里能看出本轮只下发了多少 schema。
    if (c?.tools?.search?.enabled === true) {
      const deferred = (toolBundle.excludedTools?.length ?? 0);
      log.info?.(`[orch] 工具收纳：本轮下发 ${toolBundle.tools?.length ?? 0} 个 schema（含 tool_search），不可用 ${deferred} 个`);
    }

    const previousMessages = session.messages ?? [];
    const previousRounds = session.rounds ?? 0;
    const execContext = { ...(execContextFor ? execContextFor({ chatKey, session }) : {}), signal };
    checkProactive(); // 插件、记忆及提示词提供者异步执行期间，设置或新消息也可能变化。
    sessions.update(session, { systemPrompt, userPrompt, pastStateCount: pastForPrompt.count + (anchorState?.mode === 'anchor' ? anchorState.extraMessages.length : 0), traceVersion: 1, activeStep: null });
    const result = await agentRunner({
      session, systemPrompt, userPrompt, tools: toolBundle.tools, toolsFor: () => toolBundle.toolsNow?.() ?? toolBundle.tools, triggerEntries: batch,
      execContext,
      cfg: c, cfgFor: cfg, canEndAfterSend: toolBundle.canEndAfterSend,
      log, signal, llmInvoker, components, lifecycle, capabilities: capability, skipBeforeContext: true,
      invokeTool: (name, args, context) => {
        const invoke = () => toolBundle.invoke(name, args, context);
        return typeof send.withSession === 'function' ? send.withSession(session, invoke) : invoke();
      }, hooksOf: (name) => loader?.hooksOf?.(name, { chatKey, signal, botName: chatPersona.botName }) ?? [],
      onStream: ({step,delta}) => {
        const activeStep={...step,messageIndex:previousMessages.length+step.messageIndex};
        if(sessions.stream)sessions.stream(session,activeStep,delta);
        else sessions.update(session,{activeStep});
      },
      onRound: ({ round, messages, sent, usage, providerId, provider, model, vendor, providerName, modelName, activeStep, progress }) => {
        sessions.update(session, { messages: [...previousMessages, ...messages], sent, usage, rounds: previousRounds + round, providerId, provider, model, vendor, providerName, modelName,
          ...(progress ? {progress} : {}),
          activeStep: activeStep ? { ...activeStep, messageIndex: previousMessages.length + activeStep.messageIndex } : null });
      },
    });
    if (result.error) throw result.error;
    // 8. 活跃模式状态机（finish 时）
    applyChatActive({ session, result, cfgChat, chatKey, isPrivate });
    return {
      sent: result.sent, rounds: previousRounds + result.rounds, usage: result.usage,
      finishReason: result.finishReason, promptChars: session.promptChars,
      model: session.model, vendor: session.vendor,
    };
  }

  let stickerListProvider = null;
  const promptAnchors = new Map();
  const promptAnchorLimits = new Map();
  let speakerFormatFn = null;

  // ---------- 活跃模式状态机（§6.8）----------
  function applyChatActive({ session, result, cfgChat, chatKey, isPrivate }) {
    void isPrivate;
    const c = cfg();
    if (c.chatActive?.enabled !== true) { activeFor(chatKey); return; }
    const ttl = Math.max(60_000, (Number(c.chatActive.ttlMinutes) || 30) * 60_000);
    const topic = session.activeTopic;
    const reason = String(result.finishReason ?? '');
    if (/话题(结束|终止|偏离)/.test(reason)) { active.delete(chatKey); const old=activeTimers.get(chatKey); if(old)clearTimeout(old); activeTimers.delete(chatKey); return; }
    if (topic && String(topic).length <= ACTIVE_TOPIC_MAX && session.contextTier >= 1 && session.contextTier <= 3) {
      const old=activeTimers.get(chatKey); if(old){clearTimeout(old);wakeTimers.delete(old);}
      const until=now()+ttl;
      active.set(chatKey, { topic: String(topic), until }); // 换话题延续
      const t = setTimeout(() => { active.delete(chatKey); activeTimers.delete(chatKey); wakeTimers.delete(t); }, ttl);
      activeTimers.set(chatKey, t);
      return;
    }
    if (active.has(chatKey)) {
      const old=activeTimers.get(chatKey); if(old){clearTimeout(old);wakeTimers.delete(old);}
      const until=now()+ttl;
      active.set(chatKey, { ...active.get(chatKey), until });
      const t=setTimeout(()=>{active.delete(chatKey);activeTimers.delete(chatKey);wakeTimers.delete(t);},ttl);
      activeTimers.set(chatKey, t);
    }
  }

  // ---------- 记忆整理触发（§6.9；实际整理在 M4）----------
  async function maybeConsolidate(chatKey, { signal = null, current = () => true } = {}) {
    let c = cfg();
    const eligible = () => !signal?.aborted && current() && !isPausedNow()
      && cfg().memory?.consolidateEnabled !== false
      && !(cfg().memory?.useChatModel === false ? !cfg().memory.model || !cfg().memory.provider : !cfg().api?.model)
      && now() - (memory?.lastConsolidatedAt?.(chatKey) ?? 0) >= Math.max(1_800_000, Number(cfg().memory?.consolidateMinIntervalMs) || 21_600_000);
    if (!eligible()) return;
    const sourceLease = serviceLeaseOf?.('community.client', { signal });
    try {
      let globalIds = [];
      if (Number(c.memory?.discoverMaxMembers ?? 3) !== 0) {
        const reader = typeof sourceLease?.provider?.getBlocklist === 'function'
          ? options => sourceLease.provider.getBlocklist(options) : globalBlocklistOf;
        const sourceSignal = sourceLease?.signal ?? signal;
        globalIds = typeof reader === 'function'
          ? await awaitDiscovery(resolveGlobalBlocklist(c, () => reader({ signal: sourceSignal })), sourceSignal)
          : effectiveGlobalBlocklist(c);
        if (sourceLease?.isValid?.() === false) return;
      }
      // A background lookup may outlive settings, cooldown or the worker that
      // requested it. Re-read every dispatch gate before selecting archived rows.
      if (!eligible()) return;
      c = cfg();
      const st = memory?.stats?.(chatKey) ?? { totalImpressions: 0, maxPerMember: 0 };
      const configuredMinImpr = Number(c.memory?.consolidateMinImpressions ?? 4);
      const minImpr = Number.isFinite(configuredMinImpr) ? Math.max(0, Math.floor(configuredMinImpr)) : 4;
      const maxPer = Number(c.memory?.maxImpressionsPerMember) || 5;
      const consolidating = st.totalImpressions > minImpr || st.maxPerMember > maxPer;
      const configuredMax = Number(c.memory?.discoverMaxMembers ?? 3);
      const discoverMax = Number.isFinite(configuredMax) ? Math.max(0, Math.floor(configuredMax)) : 3;
      const configuredMin = Number(c.memory?.discoverMinMessages ?? 20);
      const discoverMin = Number.isFinite(configuredMin) ? Math.max(1, Math.floor(configuredMin)) : 20;
      const discovered = [];
      if (discoverMax) {
        const blocked = new Set([...globalIds, ...(c.blocklist?.[chatKey.split(':').pop()] ?? [])].map(String));
        const history = (store?.recent?.(chatKey, DISCOVERY_SCAN_WINDOW) ?? []).filter((entry) => !entry.self && !entry.isPoke && !entry.recalled && String(entry.text ?? '').trim() && /^\d{1,15}$/.test(String(entry.senderId)) && Number(entry.senderId) > 0 && !blocked.has(String(entry.senderId)));
        const known = new Set();
        for (const member of memory?.query?.(chatKey) ?? []) {
          if (!member.impressions?.length) continue;
          if (/^\d{1,15}$/.test(String(member.userId ?? ''))) { known.add(String(member.userId)); continue; }
          const name = String(member.name ?? '');
          if (!name) continue;
          const matches = new Set([
            ...Object.entries(c.memberNotes ?? {}).filter(([id, note]) => note === name && /^\d{1,15}$/.test(id)).map(([id]) => id),
            ...history.filter((entry) => entry.senderName === name).map((entry) => String(entry.senderId)),
          ]);
          if (matches.size === 1) known.add([...matches][0]);
        }
        const counts = new Map();
        history.forEach((entry, index) => { const id = String(entry.senderId); if (known.has(id)) return; const item = counts.get(id) ?? { id, count: 0 }; item.count++; item.last = index; counts.set(id, item); });
        discovered.push(...[...counts.values()].filter((item) => item.count >= discoverMin).sort((a, b) => b.last - a.last).slice(0, discoverMax).map((item) => item.id));
      }
      if (!consolidating && !discovered.length) return;
      // 自动与控制台手动整理共用 memory-consolidate adapter；缺少 provider 时只记录事件，
      // 不阻塞本轮聊天，也不在此处另起第二套整理循环。
      if (!eligible() || sourceLease?.isValid?.() === false) return;
      const result = consolidateMemory({ memory, chatKey, userIds: consolidating ? null : discovered, create: discovered.length > 0, createUserIds: discovered.length ? discovered : null, signal });
      if (result?.status !== 202 && result?.status !== 409) {
        bus?.emit('memory.update', {
          phase: 'consolidate-error', chatKey,
          error: result?.body?.reason ?? '记忆整理能力不可用',
        });
      }
    } finally { sourceLease?.dispose?.(); }
  }

  // ---------- 主动开话题（§6.11）----------
  function proactiveIntervals(chatKey='',c=cfg()) {
    const policy=proactivePolicy(c,chatKey);
    return [policy.checkIntervalMinMs,policy.checkIntervalMaxMs];
  }
  function proactiveDelay(key='',c=cfg()) {
    const [min,max]=proactiveIntervals(key,c);return min+Math.floor(random()*(max-min));
  }
  function proactiveChats(c) {
    const chats=new Set();
    for(const[kind,field]of [['group','groups'],['private','private']])
      for(const id of c.allow?.[field]??[])if(/^[1-9]\d{0,14}$/.test(String(id)))chats.add(`${kind}:${id}`);
    // Configuring a friend is not permission to contact them. Allow-all still
    // uses only existing conversations; overrides never manufacture recipients.
    for(const chat of store.listChats?.()??[]){const match=/^(group|private):([1-9]\d{0,14})$/.exec(chat.chatKey);if(match&&allChatsAllowed(c,match[1]))chats.add(chat.chatKey);}
    const selfId=String(transport?.selfId??transport?.status?.()?.selfId??'');
    return [...chats].filter(key=>{const[kind,id]=key.split(':');return(kind!=='private'||id!==selfId)&&chatAllowed(c,kind,id);});
  }
  function syncProactivePlans(c=cfg()) {
    let changed=false;const wanted=new Set(proactiveChats(c).filter(key=>proactivePolicy(c,key).enabled));
    for(const key of proactivePlans.keys())if(!wanted.has(key)){proactivePlans.delete(key);changed=true;}
    for(const key of wanted){const signature=JSON.stringify(proactiveIntervals(key,c)),old=proactivePlans.get(key);
      if(!old||old.signature!==signature){proactivePlans.set(key,{signature,nextAt:now()+proactiveDelay(key,c)});changed=true;}}
    return changed;
  }
  function proactiveStatus() {
    const c = cfg();
    return { enabled: c.proactive?.enabled === true, running: proactiveRunning && !isPausedNow(), paused: isPausedNow(),
      nextCheckAt: isPausedNow() ? null : proactiveNextAt, lastCheckAt: proactiveLastCheckAt,
      lastOutcome: proactiveLastOutcome, revision: proactiveRevision, generation: proactiveIdentity, scope: 'chats', decision:'model', unified:c.proactive?.unified!==false,
      ...(c.proactive?.unified===false?{byChat:Object.fromEntries([...proactivePlans].map(([key,plan])=>[key,{nextCheckAt:isPausedNow()?null:plan.nextAt}]))}:{}) };
  }
  function publishProactive() { ++proactiveRevision; bus?.emit('status', { proactiveStatus: proactiveStatus() }); }
  function startProactiveLoop() {
    if (isPausedNow()) return;
    const split=cfg().proactive?.unified===false,interval = split?'split':JSON.stringify(proactiveIntervals());
    // Settings are auto-saved. Restarting this deadline on every unrelated
    // write can postpone the first check forever. Only cadence changes re-arm it.
    if (proactiveRunning && interval === proactiveInterval) {
      if(split&&syncProactivePlans()){scheduleNextProactive();publishProactive();}return;
    }
    stopProactiveLoop();
    proactiveRunning = true;
    proactiveInterval = interval;
    scheduleNextProactive();
    publishProactive();
  }
  async function tickProactive() {
    // 排程先行：即使本 tick 被任一闸挡住，下次检查仍已安排。
    const c = cfg(),split=c.proactive?.unified===false,due=new Set();
    if(split){syncProactivePlans(c);for(const[key,plan]of proactivePlans)if(plan.nextAt<=now()){due.add(key);plan.nextAt=now()+proactiveDelay(key,c);}}
    scheduleNextProactive();
    const generation = proactiveGeneration, check = ++proactiveCheck;
    proactiveLastCheckAt = now();
    const outcome = value => { if (generation === proactiveGeneration && check === proactiveCheck) { proactiveLastOutcome = value; publishProactive(); } };
    if (c.proactive?.enabled !== true) return outcome('disabled');
    if (isPausedNow()) return outcome('paused');
    if (!c.api?.model) return outcome('no-model');
    const connected = () => { const state = transport?.status?.(); return state?.connected !== false && state?.transportReady !== false; };
    if (!connected()) return outcome('disconnected');
    const maxConcurrent = Math.max(1, Number(c.maxConcurrentRuns) || 2);
    if (sessions.running().length >= maxConcurrent) return outcome('busy');
    const allowed = proactiveChats(c);
    const locallyBlocked = new Set(effectiveGlobalBlocklist(c));
    const blocked = new Set();
    const candidates = allowed.filter(key => {
      const policy=proactivePolicy(c,key);
      if(!policy.enabled){blocked.add('disabled-chat');return false;}
      if(split&&!due.has(key)){blocked.add('not-due');return false;}
      if (key.startsWith('private:') && locallyBlocked.has(key.slice(8))) { blocked.add('blocked'); return false; }
      if (isChatQuiet(c.commandMute, key, now())) { blocked.add('quiet'); return false; }
      if (unreadForWake(key).length > 0) { blocked.add('unread'); return false; }
      if (sessions.current(key)) { blocked.add('busy'); return false; }
      const last = store.recent(key, 1)[0];
      if (last && (now() - last.ts) < policy.idleThresholdMs) { blocked.add('recent'); return false; }
      return true;
    });
    if (!candidates.length) return outcome(!allowed.length ? 'no-chats' : blocked.size === 1 ? [...blocked][0] : 'not-ready');
    const key = candidates[Math.floor(random() * candidates.length)], [kind, id] = key.split(':');
    const selectedPolicy=JSON.stringify(proactivePolicy(c,key));
    outcome('checking');
    const current = () => {
      const latest = cfg(), last = store.recent(key, 1)[0];
      const policy=proactivePolicy(latest,key);
      return generation === proactiveGeneration && policy.enabled && !isPausedNow()
        && (!split||latest.proactive?.unified===false&&JSON.stringify(policy)===selectedPolicy)
        && connected()
        && chatAllowed(latest, kind, id) && !isChatQuiet(latest.commandMute, key, now())
        && (kind !== 'private' || id !== String(transport?.selfId ?? '') && !effectiveGlobalBlocklist(latest).includes(id))
        && !unreadForWake(key).length && (!last || now()-last.ts >= policy.idleThresholdMs);
    };
    try {
      if (kind === 'private' && (await resolveGlobalBlocklist(cfg(), globalBlocklistOf)).includes(id)) return outcome('blocked');
      if (!current()) return outcome('changed');
      const result = await wake(key, { proactive: true, proactiveGuard: current });
      outcome(result?.skipped ?? ({done:'sent',noreply:'silent',error:'error',aborted:'aborted'}[result?.status] || 'changed'));
    } catch (error) { outcome('error'); log.warn?.(`[orch] 主动聊天检查失败：${error?.message ?? error}`); }
  }
  function scheduleNextProactive() {
    if (!proactiveRunning || isPausedNow()) return;
    const c=cfg(),split=c.proactive?.unified===false;
    if(split)syncProactivePlans(c);
    let nextAt;
    if(split&&proactivePlans.size){nextAt=Infinity;for(const plan of proactivePlans.values())nextAt=Math.min(nextAt,plan.nextAt);}
    else nextAt=split&&proactiveTimer&&proactiveNextAt>now()?proactiveNextAt:now()+proactiveDelay('',c);
    if(split&&proactiveTimer&&proactiveNextAt===nextAt)return;
    if (proactiveTimer) { clearTimeoutFn(proactiveTimer); wakeTimers.delete(proactiveTimer); }
    const generation = proactiveGeneration,delay=Math.max(1,nextAt-now());
    proactiveNextAt = nextAt;
    const timer = setTimeoutFn(() => {
      if (proactiveTimer !== timer || generation !== proactiveGeneration || !proactiveRunning) return;
      proactiveTimer = null;
      proactiveNextAt = null;
      wakeTimers.delete(timer);
      tickProactive().catch(error => {
        if (generation === proactiveGeneration) { proactiveLastOutcome = 'error'; publishProactive(); }
        log.warn?.(`[orch] 主动聊天检查失败：${error?.message ?? error}`);
      });
    }, delay);
    proactiveTimer = timer;
    if (typeof proactiveTimer.unref === 'function') proactiveTimer.unref();
    wakeTimers.add(proactiveTimer);
  }
  function stopProactiveLoop() {
    ++proactiveGeneration;
    proactiveRunning = false;
    proactivePlans.clear();
    proactiveNextAt = null;
    if (proactiveLastOutcome === 'checking') proactiveLastOutcome = 'changed';
    if (proactiveTimer) { clearTimeoutFn(proactiveTimer); wakeTimers.delete(proactiveTimer); proactiveTimer = null; }
    publishProactive();
  }

  // ---------- 提醒循环（§6.12；reminders 仓在 M2）----------
  function startReminderLoop(reminders) {
    stopReminderLoop();
    reminderStore = reminders;
    const generation = reminderGeneration;
    const controller = new AbortController();
    reminderController = controller;
    const tick = async () => {
      if (generation !== reminderGeneration) return;
      if (reminderTimer) wakeTimers.delete(reminderTimer);
      reminderTimer = null;
      const due = reminders?.due?.(now()) ?? [];
      for (const r of due) {
        if (generation !== reminderGeneration || isPausedNow()) break;
        if (reminderFiring.has(r.id)) continue;
        if (reminders.pending && !reminders.pending(r.chatKey).some((item) => item.id === r.id)) continue;
        reminderFiring.add(r.id);
        try {
          // 走 SendQueue 完整管道；发送成功才 markFired（反过来断线会永久丢提醒）
          // Persisted fragments have already been prepared. Reusing them must
          // neither run a non-idempotent converter again nor trim split edges.
          const previous = reminderProgress.get(r.id) ?? r.pendingTexts;
          const remaining = previous ?? prepareTextBatch(r.text, {
            plainText, split: splitForSend, limit: cfg().send?.hardSplitAt ?? 4000,
          });
          if (previous == null) {
            // Save the plan before its first external effect. Even a rejected
            // first chunk must retry the same output of a stateful converter.
            if (reminders.updatePendingTexts?.(r.id, remaining) === false) throw new Error('提醒已取消，未发送');
            reminderProgress.set(r.id, remaining);
          }
          const result = await send.sendTextBatch(r.chatKey, remaining, { signal: controller.signal, textFormat: 'prepared', source: { type: 'reminder', id: r.id } });
          if (result?.failed?.length) {
            const pending = remaining.slice(result.failed[0].index);
            reminderProgress.set(r.id, pending);
            reminders.updatePendingTexts?.(r.id, pending);
            throw new Error(result.failed.map((item) => item.error).join('；'));
          }
          if (!result?.sent?.length && result?.deduped !== true) throw new Error('提醒没有成功发送');
          reminders.markFired(r.id);
          reminderProgress.delete(r.id);
        } catch (err) {
          log.warn?.(`[orch] 提醒发送失败（保留待发）：${err?.message}`);
        } finally {
          reminderFiring.delete(r.id);
        }
      }
      if (generation !== reminderGeneration) return;
      reminderTimer = setTimeoutFn(tick, 20_000);
      if (typeof reminderTimer.unref === 'function') reminderTimer.unref();
      wakeTimers.add(reminderTimer);
    };
    reminderTimer = setTimeoutFn(tick, 5_000); // 启动 5 秒首查
    if (typeof reminderTimer.unref === 'function') reminderTimer.unref();
    wakeTimers.add(reminderTimer);
  }
  function stopReminderLoop() {
    reminderStore = null;
    reminderGeneration++;
    reminderController?.abort(Object.assign(new Error('提醒调度已停止'), { __aborted: true }));
    reminderController = null;
    if (reminderTimer) { clearTimeoutFn(reminderTimer); wakeTimers.delete(reminderTimer); reminderTimer = null; }
  }
  function reminderTimersDelete(t) { wakeTimers.delete(t); }

  // ---------- 会话控制（§6.13）----------
  function retrySession(id) {
    const s = sessions.peek(id);
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.kind === 'outbound') return { ok: false, error: '这是独立发送记录，请从原提醒或插件重新发送' };
    if (s.status !== 'error') return { ok: false, error: '只有失败的会话才能重试' };
    if (s.sent?.length > 0) return { ok: false, error: '该会话已发出过消息，重试会导致重复发言' };
    if (sessions.current(s.chatKey)?.status === 'running') return { ok: false, error: '该会话正在运行中' };
    const from = s.startedAt ?? now();
    const to = s.endedAt ?? now();
    const ids = Array.isArray(s.triggerEntryIds) && s.triggerEntryIds.length ? s.triggerEntryIds : null;
    const restored = ids && store.markEntriesUnread
      ? store.markEntriesUnread(s.chatKey, ids)
      : store.markUnreadInWindow(s.chatKey, from, to);
    if (restored === 0) return { ok: false, error: '触发消息已无法定位（时间窗内没有可恢复的消息）' };
    // 原地复用同一会话 id（新开一条会在页面上出现两条记录）。
    const delay = Math.max(200, wakeBaseDelay(s.chatKey));
    sessions.update(s, {
      status: 'waiting', waitUntil: now() + delay, error: null,
      finishReason: null, activeTopic: null, endedAt: null, retryTriggerIds: ids,
    });
    scheduleWake(s.chatKey, delay, { verified: Boolean(ids), sessionId: id, reuse: true });
    return { ok: true, restored };
  }

  function abortSession(id) {
    const s = sessions.peek(id);
    if (!s) return { ok: false, error: '会话不存在' };
    if (s.status === 'waiting') {
      removeCapacityWait(s.chatKey, id);refreshCapacityPositions();
      const pw = pendingWake.get(s.chatKey);
      if (pw && pw.sessionId === id) {
        clearTimeout(pw.timer);
        wakeTimers.delete(pw.timer);
        pendingWake.delete(s.chatKey);
      }
      sessions.discard(id); // 干净消失（内存与持久化文件均删除）
      return { ok: true };
    }
    if (s.status === 'running') {
      mentionedDuringRun.delete(id);
      const ac = aborters.get(id);
      if (ac) ac.abort(Object.assign(new Error('用户中止'), { __aborted: true }));
      sessions.finish(id, 'aborted', { error: null, finishReason: '用户中止' });
      return { ok: true, status: 'aborted' };
    }
    // A run can finish between painting the button and receiving this request.
    // Acknowledge that race without changing the actual terminal outcome.
    return { ok: true, alreadyFinished: true, status: s.status };
  }

  function abortAll() {
    capacityGeneration++;capacityDrainScheduled=false;
    for (const [chatKey,item] of capacityWaiting) {
      removeCapacityWait(chatKey);
      const session = sessions.peek(item.waitingSessionId);
      if (session?.status === 'waiting') sessions.discard(session.id);
    }
    mentionedDuringRun.clear();
    for (const check of wakeChecks) {
      check.cancelled = true;
      check.controller?.abort(new Error('全局中止'));
      const s = check.waiting;
      if (!s || sessions.peek(s.id) !== s) continue;
      if (s.status === 'waiting') sessions.discard(s.id);
      else if (s.status === 'running') sessions.finish(s.id, 'aborted', { error: '全局中止' });
    }
    wakeChecks.clear();
    for (const [chatKey, pw] of pendingWake) {
      clearTimeout(pw.timer);
      wakeTimers.delete(pw.timer);
      if (pw.sessionId) sessions.discard(pw.sessionId);
      pendingWake.delete(chatKey);
    }
    for (const ac of aborters.values()) ac.abort(Object.assign(new Error('全局中止'), { __aborted: true }));
    for (const t of [...wakeTimers]) {
      if (t === proactiveTimer || t === reminderTimer) continue;
      clearTimeout(t);
      wakeTimers.delete(t);
    }
  }

  function drainBacklogAfterResume() {
    for (const chat of store.listChats?.() ?? []) {
      if (unreadForWake(chat.chatKey).length === 0) continue;
      if (sessions.current(chat.chatKey) || pendingWake.has(chat.chatKey)) continue;
      scheduleWake(chat.chatKey, null, { verified: false, proactive: false });
    }
  }

  function pause() {
    // Identity/status observers can ask to pause while handling the notification
    // emitted by this transition. A repeated pause must not publish recursively
    // or replace the loops saved by the original transition.
    if (paused) return;
    suspendedLoops = { proactive: proactiveRunning, reminders: reminderStore };
    paused = true;
    cancelDiscovery();
    stopProactiveLoop(); stopReminderLoop(); abortAll();
  }
  function resume({ skipBacklog = false } = {}) {
    const wasPaused = paused;
    paused = false;
    if (discoveryController.signal.aborted) { ++discoveryGeneration; discoveryController = new AbortController(); }
    if (wasPaused && suspendedLoops) {
      const loops = suspendedLoops; suspendedLoops = null;
      if (cfg().proactive?.enabled === true) startProactiveLoop();
      if (loops.reminders) startReminderLoop(loops.reminders);
    }
    if (wasPaused) publishProactive();
    if (wasPaused && !skipBacklog) drainBacklogAfterResume();
  }
  function stop() { offCapacityEnd?.();cancelDiscovery(); suspendedLoops = null; contextWatch?.(); contextWatch = null; contextPrefixes.clear(); abortAll(); stopProactiveLoop(); stopReminderLoop(); for(const timer of activeTimers.values()){clearTimeout(timer);wakeTimers.delete(timer);} activeTimers.clear(); active.clear(); }

  function status() {
    for (const chatKey of active.keys()) activeFor(chatKey);
    const waiting = new Map([...pendingWake.entries()].map(([chatKey,pw]) => [chatKey,{chatKey,sessionId:pw.sessionId}]));
    for (const [chatKey,item] of capacityEntries()) waiting.set(chatKey,{chatKey,sessionId:item.waitingSessionId,queued:true});
    return {
      paused: isPausedNow(),
      running: sessions.running().map((s) => ({ id: s.id, chatKey: s.chatKey, startedAt: s.startedAt })),
      waiting: [...waiting.values()],
      maxConcurrentRuns:Math.max(1, Number(cfg().maxConcurrentRuns) || 2),
      wakeTimers: wakeTimers.size,
      proactive: proactiveStatus(),
      activeTopics: [...active.entries()].map(([chatKey, v]) => ({ chatKey, ...v })),
    };
  }

  return {
    onIncoming, wake, scheduleWake, abortAll, pause, resume, drainBacklogAfterResume, stop, status, isPaused:isPausedNow,
    retrySession, abortSession, startProactiveLoop, stopProactiveLoop, startReminderLoop, stopReminderLoop,
    storeConfigForChat,
    // 注入点（M1 装配 / M2 插件接线）
    _inject: {
      setBanStateProvider: (fn) => { banStateProvider = fn; },
      setStickerListProvider: (fn) => { stickerListProvider = fn; },
      setSpeakerFormat: (fn) => { speakerFormatFn = fn; },
    },
    _active: active,
    _applyChatActive: applyChatActive,
    _tickProactive: tickProactive,
  };
}

export { formatEntry, triggerLabels, personaForChat };
