// Host consumer for the public 0.4 function and native object contracts.
// These are live policy decisions, distinct from the transport mute cache.
export function captureChatBanState(capability) {
  const candidates = (capability?.providers?.('chat.ban-state') ?? []).map(row => ({ ...row, version: capability.version?.('chat.ban-state', row.ownerId) }));
  return { candidates, isCurrent() {
    const rows = capability?.providers?.('chat.ban-state') ?? [];
    return rows.length === candidates.length && rows.every((row, index) => row.ownerId === candidates[index].ownerId
      && row.provider === candidates[index].provider && capability.version?.('chat.ban-state', row.ownerId) === candidates[index].version);
  } };
}

export async function readChatBanState(capability, chatKey, { signal, log = console, timeoutMs = 5000, snapshot = captureChatBanState(capability) } = {}) {
  if (!capability?.providers || signal?.aborted) return { muted: false };
  const name = 'chat.ban-state';
  const candidates = snapshot.candidates;
  const unchanged = snapshot.isCurrent;
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason ?? new Error('策略检查已取消'));
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('策略检查超时')), timeoutMs);
  let off, interrupted;
  const cancelled = new Promise(resolve => { interrupted = () => resolve({ cancelled: true }); controller.signal.addEventListener('abort', interrupted, { once: true }); });
  const current = row => capability.providers(name).some(next => next.ownerId === row.ownerId && next.provider === row.provider)
    && capability.version?.(name, row.ownerId) === row.version;
  try {
    for (const row of candidates) {
      if (controller.signal.aborted) break;
      if (!unchanged() || !current(row)) return { muted: false, stale: true };
      // A removed/replaced provider must neither block this wake nor revive
      // after a disable/re-enable transition while its promise is outstanding.
      let invalidated;
      const invalid = new Promise(resolve => { invalidated = resolve; });
      off = capability.onChange?.(() => { if (!unchanged()) invalidated({ stale: true }); });
      try {
        const work = Promise.resolve().then(() => {
          if (!current(row) || controller.signal.aborted) return { cancelled: true };
          return typeof row.provider === 'function'
            ? row.provider({ action: 'check', chatKey, kind: 'group', signal: controller.signal })
            : row.provider?.check?.(chatKey.slice('group:'.length), { signal: controller.signal });
        });
        const result = await Promise.race([work, cancelled, invalid]);
        if (result?.stale || !unchanged()) return { muted: false, stale: true };
        if (result?.cancelled || controller.signal.aborted || !current(row)) continue;
        if (result === true || (result?.known === true && result.muted === true)) {
          return { muted: true, reason: typeof result?.reason === 'string' ? result.reason.slice(0, 400) : undefined };
        }
      } catch {
        if (!controller.signal.aborted && current(row)) log.warn?.(`[orchestrator] ${row.ownerId} 的群聊策略检查失败，继续核验协议禁言`);
      } finally { off?.(); off = null; }
    }
    if (!unchanged()) return { muted: false, stale: true };
    if (controller.signal.aborted && !signal?.aborted) log.warn?.('[orchestrator] 群聊策略检查超时，继续核验协议禁言');
    return { muted: false };
  } finally {
    clearTimeout(timer); off?.(); signal?.removeEventListener('abort', abort);
    controller.signal.removeEventListener('abort', interrupted);
    controller.abort();
  }
}
