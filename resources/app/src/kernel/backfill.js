// backfill：启动补拉。机器人进程不在时，群里的消息没人落盘；
// 协议端（SnowLuma 等 OneBot 实现）是独立常驻进程，重启不影响它，
// 因此在连接就绪后按"本地库最后一条消息时间"作水位，向协议端取回更新的消息并入库。
// 只入库、不触发回复：走 ingest 正常准入（白名单/屏蔽闸门照旧），read=false 留未读。
import path from 'node:path';

const GROUP_HISTORY = 'get_group_msg_history';
const FRIEND_HISTORY = 'get_friend_msg_history';
const PAGE_SIZE = 200;          // 协议端单次上限实测 200 条，给更多也只会回 200
const MAX_PAGES = 3;            // 单会话最多回溯 600 条，够覆盖常见掉线窗口
const REQUEST_TIMEOUT_MS = 8000;
const CONNECT_SETTLE_MS = 1500; // 等首帧实时事件先落地，避免与实时写入抢顺序

export function createBackfill({
  cfg, store, ingest, dataDir = null, log = console,
  isConnected = () => false, selfIdOf = () => null,
  waitMs = 90000,
} = {}) {
  let started = false;
  let running = false;
  let report = null;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function endpoint() {
    const onebot = cfg()?.onebot ?? {};
    const url = String(onebot.httpUrl ?? '').trim().replace(/\/+$/, '');
    const token = String(onebot.httpAccessToken || onebot.accessToken || '').trim();
    return { url, token };
  }

  async function call(action, body) {
    const { url, token } = endpoint();
    if (!url) throw new Error('onebot.httpUrl 未配置');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${url}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await response.text();
      let payload;
      try { payload = JSON.parse(text); } catch { throw new Error(`协议端返回非 JSON：${text.slice(0, 120)}`); }
      if (payload?.status && payload.status !== 'ok') throw new Error(String(payload?.message || payload?.wording || '协议端返回失败'));
      return payload?.data ?? payload;
    } finally { clearTimeout(timer); }
  }

  /** 白名单里允许的会话；只补这些，其余群本来也不入库。 */
  function targets() {
    const allow = cfg()?.allow ?? {};
    const out = [];
    for (const id of allow.groups ?? []) { const value = String(id ?? '').trim(); if (value) out.push({ kind: 'group', id: value }); }
    for (const id of allow.private ?? []) { const value = String(id ?? '').trim(); if (value) out.push({ kind: 'private', id: value }); }
    return out;
  }

  const chatKeyOf = (kind, id) => `${kind}:${id}`;

  /** 水位：本地库最后一条消息的时间（毫秒）。库为空返回 0。 */
  function watermark(chatKey) {
    const last = store.recent?.(chatKey, 1)?.[0];
    const ts = Number(last?.ts);
    return Number.isFinite(ts) && ts > 0 ? ts : 0;
  }

  function listOf(data) {
    if (Array.isArray(data)) return data;
    if (Array.isArray(data?.messages)) return data.messages;
    if (Array.isArray(data?.message)) return data.message;
    return [];
  }

  /** 从最新往更早翻页，直到覆盖水位或翻满上限。 */
  async function fetchSince(kind, id, since) {
    const { url } = endpoint();
    if (!url) throw new Error('onebot.httpUrl 未配置');
    const action = kind === 'group' ? GROUP_HISTORY : FRIEND_HISTORY;
    const idField = kind === 'group' ? 'group_id' : 'user_id';
    const collected = [];
    let seq = null;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const body = { [idField]: Number(id), count: PAGE_SIZE };
      if (seq !== null && seq !== undefined) body.message_seq = seq;
      const data = await call(action, body);
      const list = listOf(data);
      if (!list.length) break;
      collected.push(...list);
      // 返回按时间正序（最老在前），用最老一条判断是否已覆盖水位
      const oldestTs = Number(list[0]?.time) * 1000;
      const oldestSeq = list[0]?.message_seq;
      if (!Number.isFinite(oldestTs) || oldestTs <= since) break;
      if (oldestSeq === null || oldestSeq === undefined || oldestSeq === seq) break;
      seq = oldestSeq;
    }
    return collected;
  }

  async function backfillOne({ kind, id }) {
    const chatKey = chatKeyOf(kind, id);
    const since = watermark(chatKey);
    const selfId = String(selfIdOf() ?? '');
    const list = await fetchSince(kind, id, since);
    const ordered = [...list].sort((a, b) => (Number(a?.time) || 0) - (Number(b?.time) || 0));
    let added = 0, skipped = 0, rejected = 0;
    for (const raw of ordered) {
      const tsMs = Number(raw?.time) * 1000;
      if (Number.isFinite(tsMs) && tsMs <= since) { skipped += 1; continue; }
      if (selfId && String(raw?.user_id ?? '') === selfId) { skipped += 1; continue; }
      const mid = raw?.message_id ?? null;
      if (mid !== null && store.findByMid?.(chatKey, mid)) { skipped += 1; continue; }
      const event = { ...raw, message_type: kind, [kind === 'group' ? 'group_id' : 'user_id']: Number(id) };
      try {
        const result = await ingest.ingestMessage({ kind, id: String(id), event });
        if (result?.accepted) added += 1;
        else rejected += 1;
      } catch (error) {
        log.warn?.(`[backfill] ${chatKey} 入库失败：${error?.message ?? error}`);
        rejected += 1;
      }
    }
    return { chatKey, since, fetched: list.length, added, skipped, rejected };
  }

  async function waitForConnection() {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      if (isConnected()) return true;
      await sleep(700);
    }
    return false;
  }

  /** 启动补拉：等连接就绪后跑一次。进程内单次保护，force 可手动再跑。 */
  async function start({ force = false } = {}) {
    if (running) return report;
    if (started && !force) return report;
    started = true;
    running = true;
    try {
      if (!(await waitForConnection())) {
        report = { ok: false, reason: 'not-connected', at: Date.now(), added: 0, chats: [] };
        log.warn?.('[backfill] 协议端未在等待窗口内连上，跳过补拉');
        return report;
      }
      await sleep(CONNECT_SETTLE_MS);
      const chats = [];
      for (const target of targets()) {
        if (!isConnected()) break; // 中途断线就停，避免半截补入
        try {
          const result = await backfillOne(target);
          if (result.fetched) chats.push(result);
        } catch (error) {
          log.warn?.(`[backfill] ${chatKeyOf(target.kind, target.id)} 补拉失败：${error?.message ?? error}`);
          chats.push({ chatKey: chatKeyOf(target.kind, target.id), error: String(error?.message ?? error) });
        }
      }
      const added = chats.reduce((sum, item) => sum + (Number(item.added) || 0), 0);
      report = { ok: true, at: Date.now(), added, chats };
      if (added > 0) {
        const touched = chats.filter((item) => Number(item.added) > 0).map((item) => `${item.chatKey}(+${item.added})`).join(' ');
        log.info?.(`[backfill] 补回 ${added} 条掉线期间消息：${touched}`);
      } else {
        log.info?.('[backfill] 无需补拉');
      }
      return report;
    } finally {
      running = false;
    }
  }

  return { start, status: () => report, targets, watermark };
}
