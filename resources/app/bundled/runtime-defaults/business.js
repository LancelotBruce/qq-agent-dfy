import fs from 'node:fs';
import path from 'node:path';
import { buildToolAvailabilityContext, canonicalToolParameters } from '../../src/kernel/tools.js';
import { createToolSearchSession } from '../../src/kernel/tool-search.js';
import {isChatQuiet,resolveQuietCommand} from '../../src/kernel/command-mute-state.js';

export function readPersonaText({ appRoot }) {
  try { return fs.readFileSync(path.join(appRoot, 'assets', 'personas', 'xiaojingyu.txt'), 'utf8').trimEnd(); }
  catch { return ''; }
}

// These policies receive the same live objects as the default kernel. They
// remain independent of startup assembly so an appended implementation can
// replace one policy without reproducing kernel construction or lifecycle.
export function buildToolBundle({ c = {}, cfgFor }, { registry, loader }) {
  const tools = [];
  const excludedTools = [];
  const offered = new Map();
  const ctx = buildToolAvailabilityContext(c, loader);
  for (const def of registry.list()) {
    const availability = registry.availability(def.id, ctx);
    if (!availability.ok) { excludedTools.push({ id: def.id, code: availability.code, reason: availability.reason }); continue; }
    tools.push({
      type: 'function',
      function: { name: def.id, description: def.description ?? '', parameters: canonicalToolParameters(def.modelParams ?? def.params ?? { type: 'object', properties: {} }) },
    });
    offered.set(def.id, def);
  }
  // Registration order still decides conflict winners, guards and execution.
  // Only the model projection is sorted: async registration or reloading one
  // extension must not reshuffle every otherwise unchanged tool in the prefix.
  tools.sort((a, b) => a.function.name < b.function.name ? -1 : a.function.name > b.function.name ? 1 : 0);

  // ── 按需工具加载（0.4 的 tool-search 收纳，5.1 内核里整段不见了）──────
  // 只把常驻工具（tools.search.alwaysLoaded）的 schema 发给模型，其余工具只给
  // 名字目录；模型先调 tool_search 检索，命中后**下一轮**才拿到完整 schema。
  // searchSession 为 null 时行为与改动前完全一致（开关关掉 / 无延迟工具 / 真工具占了名字）。
  const searchCfg = c.tools?.search;
  let searchSession = null;
  if (searchCfg?.enabled === true) {
    const defs = [];
    for (const [id, def] of offered) {
      defs.push({ id, name: def.name ?? id, description: def.description ?? '', parameters: def.modelParams ?? def.params ?? { type: 'object', properties: {} } });
    }
    searchSession = createToolSearchSession(defs, { alwaysLoaded: searchCfg.alwaysLoaded, maxResults: searchCfg.maxResults });
  }
  const byName = new Map(tools.map((t) => [t.function.name, t]));
  const searchTool = searchSession ? (() => {
    // 目录直接写进工具描述：整轮不变，前缀稳定，不必每轮重拼消息。
    const schema = JSON.parse(JSON.stringify(searchSession.schema));
    schema.function.description += `\n\n${searchSession.catalogText()}`;
    return schema;
  })() : null;
  const exposedTools = () => {
    if (!searchSession) return tools;
    const ids = searchSession.requestTools().map((d) => d.id);
    return [...ids.map((id) => byName.get(id)).filter(Boolean), searchTool];
  };
  const loadedNow = () => new Set(searchSession ? searchSession.requestTools().map((d) => d.id) : []);
  const searchRejects = new Map();

  const currentAvailability = name => {
    // Enabling or registering a new tool must not let an old request invoke a
    // schema it was never shown. Replacement definitions need a fresh bundle too.
    if (!offered.has(name)) return { ok: false, reason: '本轮未提供此工具，请重新获取工具列表' };
    if (typeof registry.get === 'function' && registry.get(name) !== offered.get(name)) return { ok: false, reason: '工具已更新或移除，请重新获取工具列表' };
    const latest = typeof cfgFor === 'function' ? cfgFor() : c;
    if (!latest || typeof latest !== 'object') return { ok: false, reason: '当前工具设置不可用' };
    return registry.availability(name, buildToolAvailabilityContext(latest, loader));
  };
  return {
    tools: exposedTools(), excludedTools,
    // 每轮重建：tool_search 加载后的工具要到下一轮才可见（不能给旧 schema 执行）。
    toolsNow: exposedTools,
    // Replacing finish or the bundle is conservative by default. A custom
    // implementation must explicitly retain this compatibility contract.
    canEndAfterSend() {
      return offered.get('finish')?.allowAfterSendCompletion === true && currentAvailability('finish').ok;
    },
    async invoke(name, args, execCtx) {
      if (searchSession && name === 'tool_search') {
        const loaded = searchSession.searchAndLoad(args?.query, args?.max_results);
        return { ok: true, result: { ok: true, ...loaded } };
      }
      // 延迟工具在加载前一律拒绝：模型只看得到名字，没有 schema 就没有执行资格。
      if (searchSession && offered.has(name) && !loadedNow().has(name)) {
        const n = (searchRejects.get(name) ?? 0) + 1;
        searchRejects.set(name, n);
        if (n >= 2) {
          // 逃生阀（同 0.4）：检索不中时同一工具被拒两次后自动加载，避免任务卡死。
          searchSession.searchAndLoad(`select:${name}`, 1);
          return { ok: false, error: '这个工具已按调用意图自动加载，请下一轮再调用它。' };
        }
        return { ok: false, error: `工具 ${name} 还没加载。先调用 tool_search 检索它（query 可直接写 select:${name}），下一轮再调用。` };
      }
      const availability = currentAvailability(name);
      if (!availability.ok) return { ok: false, error: availability.reason };
      // Mark the model boundary explicitly. Direct registry/SDK calls retain
      // literal text semantics; this marker grants no permissions.
      return registry.invoke(name, args, { execCtx:{...execCtx,argumentSource:'model'}, isCurrent: () => currentAvailability(name).ok });
    },
  };
}

export async function forwardLinkedMedia(chatKey, entry, { runtimeState, capability, cfg, send }) {
  const { generation, signal, active } = runtimeState();
  if (!active) return { claimed: false, reason: 'stopped' };
  const quiet=()=>isChatQuiet(cfg().commandMute,chatKey)&&entry?.atMe!==true;
  if(quiet())return {claimed:false,reason:'quiet'};
  const text = String(entry?.text ?? '');
  if (!/https?:\/\/(?:[\w-]+\.)*(?:bilibili\.com|b23\.tv|douyin\.com|v\.douyin\.com|xiaoheihe\.cn)\//i.test(text)) return { claimed: false };
  const result = await capability.claimAsync('media.download', { chatKey, entry, text, cfg: cfg(), signal });
  const current = runtimeState();
  if (!current.active || generation !== current.generation) return { claimed: Boolean(result), sent: false, reason: 'stopped' };
  if(quiet())return {claimed:Boolean(result),sent:false,reason:'quiet'};
  if (!result) return { claimed: false, reason: 'no-provider' };
  const payload = result.result;
  const segments = Array.isArray(payload) ? payload : payload?.segments;
  if (!Array.isArray(segments) || segments.length === 0) return { claimed: true, sent: false, reason: 'provider-empty' };
  const sent = await send.sendSegments(chatKey, segments, { source: 'media.download', signal });
  return { claimed: true, sent: true, ownerId: result.ownerId, sentCount: sent?.sent?.length ?? 0 };
}

export async function handleProviderEvent({ kind, id, type, event }, { ingest, orchestrator, cfg, config, store, bus, log, capability, selfIdOf, forwardMedia, signal, current = () => true }) {
  const active = () => !signal?.aborted && current();
  if (!active()) return;
  if (type === 'message') {
    const result = await ingest.ingestMessage({ kind, id, event, signal });
    if (result.accepted && active()) {
      const c = cfg();
      const control=resolveQuietCommand({cfg:c,kind,id,event,entry:result.entry,selfId:selfIdOf()});
      if(control){
        // Patch this chat only. Both command messages are archived/read without
        // invoking a model, including when an account is paused or unconfigured.
        config.update({commandMute:{active:{[control.key]:control.until}}});
        store.markEntryRead(result.chatKey,result.entry.id);
        bus?.emit('chat.update',result.chatKey);
        bus?.emit('status',{configUpdated:true,commandMuteUpdated:true,quietChange:{chatKey:result.chatKey,until:control.until}});
        log.info?.(`[kernel] ${result.chatKey} ${control.type==='quiet'?'进入安静状态（仍可被 @ 唤醒）':'结束安静状态'}`);
        return;
      }
      await orchestrator.onIncoming(result.chatKey, result.entry);
      void Promise.resolve().then(() => active() && forwardMedia(result.chatKey, result.entry, { signal, current })).catch((error) => {
        if (active()) log.warn?.(`[media] 链接媒体转发失败：${error?.message ?? error}`);
      });
    }
    return;
  }
  if (type === 'poke') {
    const result = await ingest.ingestPoke(event, { signal });
    if (result.accepted && active()) await orchestrator.onIncoming(result.chatKey, result.entry);
    return;
  }
  if (type === 'recall') {
    const chatKey = `${kind}:${id}`;
    if (event.message_id != null) { store.markRecalled(chatKey, Number(event.message_id)); bus.emit('chat.update', chatKey); }
    return;
  }
  if (type === 'ban' && String(event.user_id) === String(selfIdOf())) {
    const muted = Number(event.duration) > 0;
    const provider = capability.providers('chat.ban-state')[0]?.provider;
    try { provider?.[muted ? 'note-muted' : 'note-unmuted']?.(String(event.group_id), event.duration); } catch { /* 忽略 */ }
    log.info?.(`[kernel] 机器人${muted ? '被禁言' : '被解禁'}（群 ${event.group_id}）`);
  }
}
