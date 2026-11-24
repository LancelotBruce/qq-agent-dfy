// agent-runner：一次运行的工具循环（§6.7）。
// maxRounds 12；工具集过滤唯一口径（excludedTools 可解释）；hooks 五时序；剩余 3 轮催发；
// 媒体 parts 不进 tool 消息（随 user 补发 R-19）；内联工具调用解析；finish 收尾。
import { chatCompletionWithRetry, addUsage, emptyUsage } from './llm.js';
import { isDeepStrictEqual } from 'node:util';
import { rescueUnsentReply } from './reply-rescue.js';
import { parseInlineToolCalls } from './inline-tools.js';
import { leaseReplyProvider } from './reply-provider.js';
import { replyBatchPayload } from './reply-batch.js';
import { planReplyCompletion, hasReplyDecisionProvider } from './reply-completion.js';
import { captureModelNames } from './model-names.js';
export { parseInlineToolCalls } from './inline-tools.js';

const HOOK_TIMEOUT_MS = 5000; // SPEC §17.1：Skill hook 超时（定时器不可 unref——否则进程静默退出）

function inlineDefinition(call) {
  const value=call?.function??call;
  if(typeof value?.name!=='string'||!value.name.trim())return null;
  try {
    return {name:value.name,arguments:typeof value.arguments==='string'?value.arguments:JSON.stringify(value.args??value.arguments??{})};
  } catch {return null;}
}
function sameInline(a,b) {
  if(a.name!==b.name)return false;
  try{return isDeepStrictEqual(JSON.parse(a.arguments),JSON.parse(b.arguments));}
  catch{return a.arguments===b.arguments;}
}

async function runHooks(hooks, payload, log) {
  const results = [];
  for (const { ownerId, fn, recordError, managesTimeout } of hooks) {
    let timer;
    try {
      const call = Promise.resolve(fn(payload));
      const r = await (managesTimeout ? call : Promise.race([
        call,
        new Promise((resolve) => { timer = setTimeout(() => resolve({ __timeout: true }), HOOK_TIMEOUT_MS); }),
      ]));
      if (r?.__timeout) { recordError?.(new Error(`hook 超时（${HOOK_TIMEOUT_MS}ms）`)); log.warn?.(`[runner] hook ${ownerId} 超时（${HOOK_TIMEOUT_MS}ms），跳过`); }
      else results.push({ ownerId, result: r });
    } catch (err) {
      log.error?.(`[runner] hook ${ownerId} 异常（不阻断）：${err?.message ?? err}`); // 单个抛错只记日志
    } finally { clearTimeout(timer); }
  }
  return results;
}

let generationSequence=0;
/**
 * 跑一次 agent 循环。
 * @returns { sent, rounds, usage, finishReason, messages, error }
 */
export async function runAgent({
  session, systemPrompt, userPrompt, tools, execContext, toolsFor = null,
  cfg, cfgFor = null, canEndAfterSend = null, log = console, callLLM = null, llmInvoker = null, capabilities = null, components = null, lifecycle = null,
  invokeTool, hooksOf: readHooksOf = () => [], signal = null, onRound = null, onStream = null,
  skipBeforeContext = false, triggerEntries = [],
} = {}) {
  const doCallLLM = callLLM ?? llmInvoker ?? components?.['llm.complete'] ?? chatCompletionWithRetry;
  const parseInlineCalls = components?.['core.tools.parseInline'] ?? parseInlineToolCalls;
  const rescueReply = components?.['core.reply.rescue'] ?? rescueUnsentReply;
  const replyState = {};
  const groundedProvider = capabilities?.providers?.('reply.grounded-select')?.[0]?.provider;
  const replySignal = [signal,execContext?.signal,lifecycle?.signal].filter(Boolean);
  const providerSignal = replySignal.length > 1 ? AbortSignal.any(replySignal) : replySignal[0];
  const selectReply = name => leaseReplyProvider(capabilities,name,{signal:providerSignal,timeoutMs:cfg?.api?.timeoutMs});
  const maxRounds = Math.max(1, Number(cfg?.api?.maxRounds) || 12);
  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];
  const sent = [];
  const usage = session.usage ?? emptyUsage();
  let finishReason = null;
  let rounds = 0;
  let lastError = null;
  let finished = false;
  let searched = Number(session.webSearchCount) > 0;
  let replyCompletion = null, completionAttempted = false, deliveryAttempted = false;
  // 请求保持标准 messages；详情需要的 raw/toolCall 只加到落盘快照。
  const metadata = new Map();
  // Progress belongs to the trace, never to the model's messages. The pending
  // slot has the same message index as the eventual response/result.
  let operation = null;
  let progress = {phase:'preparing', since:Date.now(), updatedAt:Date.now()};
  function beginOperation(kind, extra = {}) {
    const started = performance.now(), step = { kind, messageIndex: messages.length, startedAt: Date.now(), state: 'running', elapsedMs: 0, ...extra };
    progress = {phase:kind === 'tool' ? 'tool' : 'request', since:step.startedAt, updatedAt:step.startedAt,
      ...(kind === 'tool' ? {name:extra.name} : {requestAttempt:0, lastOutputAt:null})};
    step.progress = {...progress};
    let done = false;
    const finish = state => {
      if (!done) { done = true; step.state = state; step.elapsedMs = Math.max(0, performance.now() - started); signal?.removeEventListener('abort', abort); }
      return step;
    };
    const abort = () => { finish('aborted'); publish(); };
    operation = { step, finish, sample: () => ({ ...step, elapsedMs: done ? step.elapsedMs : Math.max(0, performance.now() - started) }) };
    if (signal?.aborted) finish('aborted'); else signal?.addEventListener('abort', abort, { once: true });
    return operation;
  }
  const allSent = () => {
    const out = [];
    for (const item of [...sent, ...(session.sent ?? []), ...(execContext?.session?.sent ?? [])]) {
      if (!out.some((x) => x === item || (x.msgId != null && item.msgId != null && x.msgId === item.msgId && x.text === item.text))) out.push(item);
    }
    return out;
  };
  const publish = () => onRound?.({ round: rounds, messages: messages.map((m) => ({ ...m, ...metadata.get(m) })), sent: allSent(), usage,
    providerId: session.providerId, provider: session.provider, model: session.model, vendor: session.vendor,
    providerName:session.providerName,modelName:session.modelName,progress:{...progress}, activeStep: operation?.sample() ?? null });
  const updateProgress = (value, broadcast = true) => {
    if (signal?.aborted || operation?.step.state !== 'running') return;
    const at = Date.now();
    progress = {...progress, ...value, since:value.phase && value.phase !== progress.phase ? at : progress.since, updatedAt:at};
    operation.step.progress = {...progress};
    if (broadcast) publish();
  };
  const canceled = () => {
    if (!signal?.aborted) return false;
    lastError = signal.reason ?? Object.assign(new Error('已中止'), { __aborted: true });
    return true;
  };
  let finalizationRequired = false;
  const hooksOf = name => {
    const hooks = readHooksOf(name) ?? [];
    // Remember the exact hooks we will execute, including one registered during
    // generation which unloads itself before the after-batch inspection.
    if (['before-tool','after-tool','after-response'].includes(name) && hooks.length) finalizationRequired = true;
    return hooks;
  };
  const keepFinalizationRound = () => {
    // A selected extension may need its next preflight/response/finish hooks.
    // Latch that requirement before awaits: unloading it mid-run must not turn
    // its unfinished work into permission for the fast path.
    try {
      const current = typeof cfgFor === 'function' ? cfgFor() : cfg;
      finalizationRequired ||= cfg?.chatActive?.enabled === true || current?.chatActive?.enabled === true
        || typeof canEndAfterSend !== 'function' || canEndAfterSend() !== true
        || !!session.activeTopic || !!session.finishReason || hasReplyDecisionProvider(capabilities)
        || rescueReply !== rescueUnsentReply || parseInlineCalls !== parseInlineToolCalls
        || ['reply.local-policy','reply.after-tool-batch'].some(name =>
          capabilities?.providers?.(name)?.some(row => typeof row.provider === 'function'))
        || ['before-tool','after-tool','after-response'].some(name => (hooksOf(name) ?? []).length > 0);
    } catch (error) {
      finalizationRequired = true;
      log.warn?.(`[runner] 无法确认收尾依赖，保留正常结束流程：${error?.message??error}`);
    }
    return finalizationRequired;
  };
  publish();

  // before-context（组装前）——已在调用侧做（系统提示/用户提示已组装），此处只跑一次
  const hookContext = { session, signal, chatKey: execContext?.chatKey ?? session.chatKey, botName: execContext?.botName };
  if (!skipBeforeContext) await runHooks(hooksOf('before-context'), { ...hookContext, messages }, log);
  // before-llm-messages：可原地修改 messages（同一数组引用）
  await runHooks(hooksOf('before-llm-messages'), { ...hookContext, messages }, log);

  let toolDefs = [...(toolsFor ? toolsFor() : tools)];
  // One final protocol correction may exceed the normal budget by one request.
  // Its tool set is restricted and it never opens another general agent loop.
  for (let round = 0; round < maxRounds || replyCompletion; round++) {
    const completing = replyCompletion;
    replyCompletion = null;
    rounds = round + 1;
    // 按需工具加载：tool_search 上一轮加载过的工具，这一轮才进 schema。
    if (toolsFor && !completing) toolDefs = [...toolsFor()];
    if (canceled()) break;
    keepFinalizationRound();

    // 本地策略能力可在工具循环前提前收尾；没有 provider 完全回退原行为。
    const preflight = selectReply('reply.local-policy');
    if (preflight) {
      finalizationRequired = true;
      try {
        const policy = await preflight.invoke({ phase:'preflight', session, messages, round, remaining: maxRounds - round });
        if (policy?.shouldEnd) { finishReason = policy.reason ?? 'local_policy'; break; }
      } catch (err) { log.warn?.(`[runner] reply.local-policy 异常，回退默认循环：${err?.message ?? err}`); }
      finally {preflight.dispose();}
    }
    // 剩余 3 轮且未发言 → 注入催发（否则轮次耗尽想说的话发不出去）
    const remaining = maxRounds - round;
    if (!completing && remaining <= 3 && allSent().length === 0 && round > 0) {
      messages.push({
        role: 'user',
        content: `【系统提醒】还剩 ${remaining} 轮工具调用机会。如果你有话想说，请立刻调用 send_message 发出来；不想说就别调用了。`,
      });
    }

    let res, generationDurationMs, generation;
    try {
      if (canceled()) break;
      const tracksRequests = doCallLLM === chatCompletionWithRetry;
      let requests = 0;
      if (!tracksRequests) usage.calls += 1; // 注入调用仍按一次逻辑请求兼容；内置链按实际 HTTP 尝试计费。
      let streamAttempt=0;
      const streamKey=`${session.id}:${Date.now()}:${++generationSequence}`;
      generation = beginOperation('generation',{streamId:`${streamKey}:0`,streamAttempt:0,revision:0,content:'',reasoning:''});publish();
      if (canceled()) break;
      res = await doCallLLM({ messages, tools: completing?.tools ?? toolDefs,
        ...(completing?.api ? {overrides:completing.api} : {}),
        cfg, signal,sessionId:session.chatKey||session.id, capabilities, log, components, lifecycle, onRequest: () => {
        if (tracksRequests || requests > 0) usage.calls += 1;
        requests++;
        updateProgress({requestAttempt:requests}, false);
        publish();
      }, onProgress: value => {
        updateProgress(value);
      }, onDelta: delta => {
        if(signal?.aborted||generation.step.state!=='running')return;
        const step=generation.step;
        if(delta.reset){step.streamId=`${streamKey}:${++streamAttempt}`;step.streamAttempt=streamAttempt;step.revision=0;step.content='';step.reasoning='';updateProgress({phase:'request',lastOutputAt:null},false);}
        if(delta.reasoning||delta.content||delta.toolCalls)updateProgress({phase:delta.toolCalls?'tool-arguments':delta.content?'responding':'thinking',lastOutputAt:Date.now()},false);
        const fromRevision=step.revision;
        step.content+=String(delta.content||'');step.reasoning+=String(delta.reasoning||'');step.revision++;
        const sample=generation.sample();
        if(onStream)onStream({step:sample,delta:{reset:!!delta.reset,content:String(delta.content||''),reasoning:String(delta.reasoning||''),fromRevision,revision:step.revision}});
        else publish();
      } }, completing ? 0 : 2);
      generationDurationMs = generation.finish('completed').elapsedMs;publish();
    } catch (err) {
      generation?.finish(signal?.aborted ? 'aborted' : 'error');publish();
      lastError = err;
      break;
    }
    if (res.usage) addUsage(usage, res.usage);
    for (const [key, value] of Object.entries(res.extraUsage ?? {})) {
      const n = Number(value);
      if (!Number.isFinite(n) || !n) continue;
      usage.extra ??= {};
      usage.extra[key] = (Number(usage.extra[key]) || 0) + n;
    }
    session.model = res._usedModel ?? res.model ?? session.model;
    session.vendor = res._usedApi?.baseUrl ?? session.vendor; // 渠道与模型同源（成本报表）
    session.providerId = res._usedApi?.provider ?? cfg?.api?.provider ?? '';
    session.provider = session.providerId;
    Object.assign(session,captureModelNames({providerId:session.providerId,model:session.model},cfg));
    session.reasoning = res.reasoning ?? session.reasoning;
    const raw = res.raw ?? (res.usage ? { usage: res.usage } : undefined);
    const recordResponse = (message = res.message ?? {}) => {
      // Tool/inline/rescue paths replace content and tool_calls. Keep the final
      // reasoning for both the trace and providers that require it next round.
      const reasoning = res.message?.reasoning_content ?? res.reasoning;
      const entry = { role: 'assistant', ...(typeof reasoning === 'string' ? { reasoning_content: reasoning } : {}), ...message };
      messages.push(entry);
      metadata.set(entry, { ...(raw ? { raw } : {}), generationDurationMs, generationStartedAt: generation.step.startedAt, generationState: generation.step.state });
      if (completing) metadata.set(entry, {...metadata.get(entry), replyCompletion: true});
      if (operation === generation) operation = null;
      return entry;
    };
    if (canceled()) {
      recordResponse();
      break;
    }

    await runHooks(hooksOf('after-response'), { ...hookContext, response: res }, log);
    if (canceled()) { recordResponse(); break; }

    const msg = res.message ?? {};
    const originalReplyBody = typeof msg.content==='string'?msg.content:'';
    // Remember the selected decision boundary before any async provider can be
    // removed. Unloading a vetoing provider must not enable a fallback send.
    const externalReplyDecision = hasReplyDecisionProvider(capabilities);
    finalizationRequired ||= externalReplyDecision;
    let toolCalls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];
    let rescueGuard = null;
    let rescueLease = null;
    let inlineLease = null;
    let inlineGuard = null;
    try {
    // 内联工具调用（模型把调用写成文本）→ 改写 assistant 条目为 tool_calls 形态
    if (toolCalls.length === 0 && typeof msg.content === 'string') {
      let inline = null;
      inlineLease = selectReply('reply.inline-calls');
      if (inlineLease) {
        finalizationRequired = true;
        try { inline = await inlineLease.invoke({ text: msg.content, response: res, session }); } catch (err) { log.warn?.(`[runner] reply.inline-calls 异常，回退内置解析：${err?.message ?? err}`); }
      }
      const contributed = Array.isArray(inline) || (inline && Array.isArray(inline.calls));
      if (contributed) inlineGuard=inlineLease.valid;
      else {inlineLease?.dispose();inlineLease=null;}
      if (inline && !Array.isArray(inline) && Array.isArray(inline.calls)) {
        // Old reply providers contribute {calls:[{name,args}]}; preserve the
        // selected core parser and merge only their additional definitions.
        const combined=(parseInlineCalls(msg.content)??[]).map(inlineDefinition).filter(Boolean);
        for(const call of inline.calls){const next=inlineDefinition(call);if(next&&!combined.some(old=>sameInline(old,next)))combined.push(next);}
        inline=combined;
      } else if (!Array.isArray(inline)) inline = parseInlineCalls(msg.content);
      inline=(Array.isArray(inline)?inline:[]).map(inlineDefinition).filter(Boolean);
      if (inline.length > 0) {
        toolCalls = inline.map((c, i) => ({ id: `inline_${round}_${i}`, type: 'function', function: c }));
        log.warn?.(`[runner] 从文本中解析出 ${inline.length} 个内联工具调用`);
      }
    }

    if (toolCalls.length === 0) {
      // A scheduled check is not an unanswered user request. Plain prose may
      // be the model choosing not to disturb someone: do not salvage it into
      // a send or spend another round nudging the model to deliver a reply.
      if(session.proactive===true){
        recordResponse({content:msg.content??''});
        finishReason=allSent().length||res.finishReason&&res.finishReason!=='stop'?(res.finishReason??'stop'):'模型决定保持安静';
        break;
      }
      // grounded-select：让外部 reply-rescue/provider 记录候选草稿或重置候选；
      // 没有 provider 时完全回退原始响应，不影响默认行为。
      if (typeof groundedProvider === 'function') {
        try {
          const decision = await groundedProvider({ response: res, content: msg.content ?? '', session, messages });
          if (decision?.reset === true) session.replyDrafts = [];
          if (decision?.remember) { session.replyDrafts = session.replyDrafts ?? []; session.replyDrafts.push(String(decision.remember).slice(0, 400)); }
          if (decision?.content) msg.content = String(decision.content);
        } catch (err) { log.warn?.(`[runner] reply.grounded-select 异常，回退原文：${err?.message ?? err}`); }
      }
      if (canceled()) { recordResponse(msg); break; }
      let rescued;
      try {
        const trigger=typeof session.triggerText==='string'?session.triggerText:(Array.isArray(session.trigger)?session.trigger:[]).map(item=>String(item?.text??'')).join('\n').slice(0,400);
        if(originalReplyBody.trim())rescued=await rescueReply({text:originalReplyBody,trigger,sent:allSent(),api:res._usedApi??cfg?.api,
          capabilities,signal,state:replyState,timeoutMs:cfg?.api?.timeoutMs,log});
        rescueLease=rescued;
        const proposed=Array.isArray(rescued?.calls)?rescued.calls.map(inlineDefinition).filter(Boolean):[];
        if(typeof rescued?.valid==='function'&&rescued.valid()&&proposed.length&&proposed.every(call=>call.name==='send_message')){
          rescueGuard=rescued.valid;
          toolCalls=proposed.map((definition,index)=>({id:`rescue_${round}_${index}`,type:'function',function:definition}));
        }
      } catch(error) {log.warn?.(`[runner] reply rescue 失败，保留未发送正文：${error?.message??error}`);}
      if (canceled()) { recordResponse(msg); break; }
      if(!toolCalls.length){
        recordResponse({ content: msg.content ?? '' });
        replyCompletion = planReplyCompletion({text:originalReplyBody,finishReason:res.finishReason,
          tools:toolDefs,sent:allSent(),attempted:completionAttempted,deliveryAttempted,capabilities,
          defaultRescue:rescueReply===rescueUnsentReply&&!externalReplyDecision,signal});
        if (replyCompletion) {
          // Continue with the already successful model/credential binding, not
          // another pass through unrelated fallback candidates. Never trace it.
          if (res._usedApi) replyCompletion.api = {...res._usedApi};
          completionAttempted = true;
          messages.push({role:'user',content:replyCompletion.prompt});
          log.warn?.('[runner] 正文未调用发送工具，进行一次发送协议纠正');
          publish();
          continue;
        }
        finishReason = completing ? '有正文但未调用发送工具（已纠正一次）' : res.finishReason ?? 'stop';
        break;
      }
    }

    const assistant=recordResponse({ content: rescueGuard?null:msg.content??'', tool_calls: toolCalls });
    if(rescueGuard)metadata.set(assistant,{...metadata.get(assistant),rescued:true});
    publish();
    const mediaParts = []; // 媒体 parts 不进 tool 消息（R-19）
    const beforeSent = allSent().length, batchResults = [];
    let completionSendAttempted = false, endAfterBatch = false, batchOk = true;
    for (const tc of toolCalls) {
      if (canceled()) break;
      const name = tc.function?.name;
      // An uncertain prior delivery must not be retried merely because the model
      // later wrote a draft. SendQueue/transport errors use their normal policy.
      if (typeof name === 'string' && name.startsWith('send_')) deliveryAttempted = true;
      let completionBlock = null;
      if (completing) {
        if (!completing.tools.some(tool => tool.function.name === name)) completionBlock = '回复纠正只允许 send_message 或 finish';
        else if (name === 'send_message') {
          if (completionSendAttempted) completionBlock = '回复纠正只允许一次发送调用，多条消息请使用数组';
          completionSendAttempted = true;
        }
      }
      if (name === 'web_search' || name === 'web_fetch') { searched=true;session.webSearchCount=(Number(session.webSearchCount)||0)+1; }
      let args = {}, argumentError = null;
      try {
        args = tc.function?.arguments ? JSON.parse(tc.function.arguments) : {};
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('not an argument object');
      } catch {
        args = {};
        argumentError = '工具参数必须是有效的 JSON 对象，请按工具定义重新调用；不要把整个参数对象转成字符串';
      }
      const sentBeforeTool = allSent();
      const toolOperation = beginOperation('tool', { name, args });
      try { publish(); } catch (error) { toolOperation.finish('error');throw error; }
      // before-tool（可否决）
      let blocked = null;
      for (const { ownerId, fn, recordError, managesTimeout } of argumentError ? [] : hooksOf('before-tool')) {
        let timer;
        try {
          const call = Promise.resolve(fn({ ...hookContext, toolName: name, argsRaw: tc.function?.arguments }));
          const v = await (managesTimeout ? call : Promise.race([
            call,
            new Promise((r) => { timer = setTimeout(() => { recordError?.(new Error(`before-tool 超时（${HOOK_TIMEOUT_MS}ms）`)); r(null); }, HOOK_TIMEOUT_MS); }),
          ]));
          if (v && v.block) { blocked = v; break; }
          void ownerId;
        } catch (err) { log.error?.(`[runner] before-tool hook 异常：${err?.message}`); }
        finally { clearTimeout(timer); }
      }
      let resultText;
      let toolOk = false;
      let endTurnRequested = false;
      let rescueCurrent=true;
      const proposalGuard = inlineGuard ?? rescueGuard;
      const proposalLease = inlineLease ?? rescueLease;
      try {if(proposalGuard)rescueCurrent=proposalGuard()===true;}catch{rescueCurrent=false;}
      if (argumentError) {
        resultText = `错误：${argumentError}`;
      } else if (completionBlock) {
        resultText = `错误：${completionBlock}`;
      } else if (blocked) {
        resultText = `错误：${blocked.reason ?? '该工具调用被插件否决'}`;
      } else if(!rescueCurrent) {
        resultText = '错误：回复提供者已变更，未执行这次发送';
      } else {
        try {
          if (canceled()) break;
          const toolContext = proposalGuard && proposalLease?.signal
            ? {...execContext,signal:AbortSignal.any([signal,execContext?.signal,proposalLease.signal].filter(Boolean))}
            : execContext;
          let r = await invokeTool(name, args, toolContext);
          // registry 包一层执行结果；捆绑工具自身也有业务 ok/result，兼容直接注入调用。
          if (r?.ok && r.result && typeof r.result === 'object' && typeof r.result.ok === 'boolean') r = r.result;
          const toolSent = r?.sent ?? r?.result?.sent;
          for (const item of Array.isArray(toolSent) ? toolSent : []) {
            if (!sent.some((x) => x === item || (x.msgId != null && item.msgId != null && x.msgId === item.msgId && x.text === item.text))) sent.push(item);
          }
          // Already-returned ToolResult media stays outside text on failures too;
          // collection adds no media/network operation or permission bypass.
          if (Array.isArray(r.mediaParts) && r.mediaParts.length > 0) mediaParts.push(...r.mediaParts);
          if (r.ok) {
            toolOk = true;
            endTurnRequested = name === 'send_message' && (r.result?.endTurn === true || r.endTurn === true);
            // 业务对象也可直接返回 {ok:true,text:...}，不能将其压成空的成功标记。
            // mediaParts 独立补发到 user 消息，不混入 tool 文本。
            const { mediaParts: omittedMedia, ...business } = r;
            const value = Object.hasOwn(r, 'result') ? r.result : business;
            resultText = typeof value === 'string' ? value : JSON.stringify(value);
            if (name === 'finish') {
              finishReason = session.finishReason ?? args.reason ?? args.summary ?? 'finish';
              finished = true;
            }
          } else {
            resultText = `错误：${r.error ?? '执行失败'}`;
          }
        } catch (err) {
          resultText = `错误：${err?.message ?? err}`;
        }
      }
      const entry = { role: 'tool', tool_call_id: tc.id, content: resultText };
      messages.push(entry);
      batchResults.push({...entry,name,isError:!toolOk});
      const timing = toolOperation.finish(toolOk ? 'completed' : 'error');
      const toolSent = allSent().filter(item => !sentBeforeTool.some(old => old === item || (old.msgId != null && item.msgId != null && old.msgId === item.msgId && old.text === item.text)));
      if (!toolOk) batchOk = false;
      if (endTurnRequested && toolSent.length > 0) endAfterBatch = true;
      metadata.set(entry, { toolCall: { name, args, result: resultText, ok: toolOk, sent: toolSent, durationMs: timing.elapsedMs, startedAt: timing.startedAt, state: timing.state } });
      if (operation === toolOperation) operation = null;
      publish(); // 已发的部分消息立即回写，后续错误不得自动复读
      await runHooks(hooksOf('after-tool'), { ...hookContext, toolName: name, argsRaw: tc.function?.arguments, result: resultText }, log);
      if (canceled() || finished) break;
    }
    if (finished || lastError) break;
    // 媒体 parts 随 user 消息补发（tool 消息只带文本——多数端点不接受 media in tool）
    if (mediaParts.length > 0) {
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: `[系统：以下是工具返回的 ${mediaParts.length} 个媒体，请直接"看"了回应]` },
          ...mediaParts,
        ],
      });
    }
    publish();
    keepFinalizationRound();
    if (!canceled()) {
      const afterBatch = selectReply('reply.after-tool-batch');
      if (afterBatch) try {
        finalizationRequired = true;
        const policy = await afterBatch.invoke(replyBatchPayload({api:res._usedApi??cfg?.api,
          entries:triggerEntries,calls:toolCalls,results:batchResults,beforeSent,allSent:allSent(),searched,
          session,round,remaining:maxRounds-round-1}));
        if (policy?.shouldEnd) {finishReason=policy.reason??'local_policy_batch';break;}
      } catch (err) {log.warn?.(`[runner] reply.after-tool-batch 异常，回退默认收尾策略：${err?.message??err}`);}
      finally {afterBatch.dispose();}
    }
    // Only the sending tool's acknowledged, explicit completion can omit the
    // next model round. Finish the entire batch first; results from other tools
    // (including plain-text queries) must still reach the agent. Other tools
    // cannot claim this shortcut, even if the model marked the send as final.
    const needsFinalization = keepFinalizationRound();
    if (endAfterBatch && batchOk && batchResults.every(row => row.name === 'send_message')
      && mediaParts.length === 0 && !canceled() && !needsFinalization) {
      finishReason = '已发送并结束本轮';
      break;
    }
    if (endAfterBatch && round < maxRounds - 1 && !canceled()) {
      messages.push({role:'user',content:'【收尾仍需完成】已确认发送成功的消息不要重复发送。当前功能、插件或其它工具结果仍需正常处理；先完成尚需的记忆写入、提醒或后续操作，再调用 finish。需要延续话题时填写 activeTopic，话题已结束时在 reason 中说明“话题结束”。'});
    }
    if (completing && !(needsFinalization && round < maxRounds - 1)) {
      finishReason = allSent().length ? '已纠正发送工具调用' : '回复纠正后仍未发送';
      break;
    }
    if (round === maxRounds - 1) { finishReason = 'max_rounds'; }
    } finally {
      try {inlineLease?.dispose?.();} catch(error) {log.warn?.(`[runner] inline lease 清理失败：${error?.message??error}`);}
      try {rescueLease?.dispose?.();} catch(error) {log.warn?.(`[runner] reply lease 清理失败：${error?.message??error}`);}
    }
  }

  // sent 的单一真相是 execContext.session.sent（send_message/finish 工具直写）；
  // runner 本地 sent 数组只兜"工具返回 {sent} 但未写 session"的路径（不重复计）
  const finalSent = allSent();
  canceled();
  publish();
  return { sent: finalSent, rounds, usage, finishReason, messages: messages.map((m) => ({ ...m, ...metadata.get(m) })), activeStep: operation?.sample() ?? null, error: lastError };
}
