import { allChatsAllowed, chatAllowed } from './chat-access.js';

// This admission applies only to opted-in private subcommands. Ordinary
// private chat continues through its existing allow/deny rules.
export function createMemberCommandAccess({ cfg, listGroups, getMember }) {
  const misses = new Map();
  let lookupCount = 0;
  return async function memberAccess(senderId, { signal, current, groupHint } = {}) {
    const snapshot = cfg();
    const denied = (snapshot.deny?.private ?? []).map(String);
    if (denied.includes(senderId) || !current?.() || lookupCount >= 4) return false;
    const key = JSON.stringify([senderId, snapshot.allow, snapshot.deny, snapshot.blocklist]);
    if ((misses.get(key) ?? 0) > Date.now()) return false;
    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(6000)].filter(Boolean));
    const valid = () => !operationSignal.aborted && current() && cfg() === snapshot;
    lookupCount++;
    try {
      let groups = (snapshot.allow?.groups ?? []).map(String);
      if (allChatsAllowed(snapshot, 'group')) {
        const rows = await listGroups({ signal: operationSignal });
        groups = Array.isArray(rows) ? rows.map(row => String(row.id)) : [];
      }
      const candidates = [...new Set([String(groupHint ?? ''), ...groups])]
        .filter(id => groups.includes(id) && /^[1-9]\d{0,15}$/.test(id) && chatAllowed(snapshot, 'group', id)
          && !(snapshot.blocklist?.[id] ?? []).map(String).includes(senderId));
      for (const groupId of candidates) {
        if (!valid()) return false;
        try {
          const member = await getMember(groupId, senderId, { signal: operationSignal, current: valid });
          if (!valid()) return false;
          if (String(member?.userId) === senderId && ['member', 'admin', 'owner'].includes(member.role)) return true;
        } catch { if (!valid()) return false; }
      }
      if (misses.size >= 1000) for (const [entry, expires] of misses) if (expires <= Date.now()) misses.delete(entry);
      if (misses.size < 1000) misses.set(key, Date.now() + 30_000);
      return false;
    } catch {
      return false;
    } finally {
      lookupCount--;
    }
  };
}
