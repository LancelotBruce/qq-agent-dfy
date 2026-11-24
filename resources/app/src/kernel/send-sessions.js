import { AsyncLocalStorage } from 'node:async_hooks';

// A logical outbound operation has its own archive unless an explicit tool
// execution owns it. Never infer ownership from a busy target chat: reminders
// and model replies can legitimately send there at the same time.
export function createSendSessionRecorder({ sessions, log = console } = {}) {
  const context = new AsyncLocalStorage();
  const same = (a, b) => a === b || (a?.msgId != null && b?.msgId != null
    ? String(a.msgId) === String(b.msgId) && a.text === b.text
    : a?.at === b?.at && a?.text === b?.text);
  function append(target, receipts) {
    for (const receipt of receipts) if (!target.some(old => same(old, receipt))) target.push(receipt);
  }
  async function withSession(session, operation) {
    const scope = { session, receipts: [], active: true };
    return context.run(scope, async () => {
      try { return await operation(); }
      finally { scope.active = false; session.sent ??= []; append(session.sent, scope.receipts); }
    });
  }
  function archive(chatKey, source, startedAt, result, error, signal) {
    const sent = Array.isArray(result?.sent) ? result.sent : [], failed = result?.failed ?? [];
    if (!error && !failed.length && !sent.length) return;
    if (!sessions?.create || !sessions?.finish) return;
    const origin = source?.type === 'reminder' ? { type: 'reminder', id: String(source.id ?? '').slice(0, 128) }
      : source?.type === 'plugin' ? { type: 'plugin', id: String(source.id ?? '').slice(0, 128), name: String(source.name ?? source.id ?? '').slice(0, 100) }
      : { type: 'outbound' };
    const trigger = origin.type === 'reminder' ? '到点提醒'
      : origin.type === 'plugin' ? `插件主动发送 · ${origin.name || origin.id}` : '主动发送';
    try {
      const session = sessions.create(chatKey, { trigger, kind: 'outbound', source: origin });
      const aborted = result?.aborted || error?.__aborted || signal?.aborted;
      const failure = error ? String(error.message ?? error) : failed.map(item => item.error).join('；');
      sessions.finish(session.id, aborted ? 'aborted' : failure ? 'error' : 'done', {
        startedAt, sent, error: failure || null, finishReason: aborted ? '发送已中止' : null,
      });
    } catch (failure) { log.error?.(`[send] 发送记录保存失败：${failure?.message ?? failure}`); }
  }
  async function observe(chatKey, options, operation) {
    const scope = context.getStore(), startedAt = Date.now();
    const owned = () => scope?.active && sessions?.peek?.(scope.session.id) === scope.session;
    try {
      const result = await operation();
      if (owned()) append(scope.receipts, Array.isArray(result?.sent) ? result.sent : []);
      else archive(chatKey, options?.source, startedAt, result, null, options?.signal);
      return result;
    } catch (error) {
      if (!owned()) archive(chatKey, options?.source, startedAt, null, error, options?.signal);
      throw error;
    }
  }
  return { observe, withSession };
}
