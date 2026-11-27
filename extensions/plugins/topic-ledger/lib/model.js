// 用一次小模型调用把事件链整理成台账条目。
// 口径：只抽「事实 / 已定 / 未决 / 约定 / 原话 / 情绪」，不写散文、不复述整段。
// 更新时只让它给增量补丁（新增了什么、哪条未决已被定下来），避免整篇重写导致的漂移。
import fs from 'node:fs';
import { DEBUG_LOG } from './paths.js';
import { clockOf } from './state.js';

const FENCE = String.fromCharCode(96, 96, 96);

export function dbg(msg) {
  try {
    fs.mkdirSync(DEBUG_LOG.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
    fs.appendFileSync(DEBUG_LOG, `${new Date().toISOString()} ${msg}\n`);
    const st = fs.statSync(DEBUG_LOG);
    if (st.size > 256 * 1024) {
      const keep = fs.readFileSync(DEBUG_LOG, 'utf8').split('\n').slice(-300).join('\n');
      fs.writeFileSync(DEBUG_LOG, keep, 'utf8');
    }
  } catch { /* 日志失败不影响主流程 */ }
}

function pickLines(chain, maxChars) {
  const msgs = chain.msgs || [];
  if (!msgs.length) return '';
  const interesting = (m) => /[0-9０-９]|点|号|块|元|明天|后天|周|月|日|约|定|行|不行|改|错|对|好|不去|去吧|V我|地址|电话|几点|多久|多少/.test(m.text);
  let picked = msgs;
  if (msgs.length > 24) {
    const head = msgs.slice(0, 3);
    const tail = msgs.slice(-12);
    const mids = msgs.slice(3, -12).filter(interesting).slice(-9);
    picked = [...head, ...mids, ...tail];
  }
  const lines = [];
  let used = 0;
  for (const m of picked) {
    const line = `${clockOf(m.ts)} ${m.self ? '我' : m.who}${m.uid ? '(' + m.uid + ')' : ''}: ${m.text.slice(0, 120)}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

function cleanList(v, max, len) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = String(x ?? '').replace(/\s+/g, ' ').trim();
    if (!s || s.length > len) continue;
    if (out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let body = raw;
  const i = raw.indexOf(FENCE);
  if (i >= 0) {
    const j = raw.indexOf(FENCE, i + FENCE.length);
    if (j > i) body = raw.slice(i + FENCE.length, j).trim().replace(/^json/i, '').trim();
  }
  const s = body.indexOf('{');
  const e = body.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(body.slice(s, e + 1)); } catch { return null; }
}

function quoteList(chain, raw) {
  const out = [];
  if (!Array.isArray(raw)) return out;
  for (const q of raw) {
    if (!q || typeof q !== 'object') continue;
    const text = String(q.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (text.length < 4) continue;
    const who = String(q.who ?? '').trim().slice(0, 24) || '?';
    const at = /^(\d{1,2}:\d{2})/.exec(String(q.at ?? '').trim());
    let ts = chain.lastTs;
    if (at) {
      const hit = (chain.msgs || []).find((m) => clockOf(m.ts) === `${at[1].padStart(5, '0')}` || clockOf(m.ts) === at[1]);
      if (hit) ts = hit.ts;
    }
    out.push({ who, ts, text });
    if (out.length >= 4) break;
  }
  return out;
}

const SYSTEM = [
  '你是聊天台账整理员。把一段群聊/私聊的「事件链」整理成结构化条目，供以后回查细节。',
  '只输出 JSON，不要解释、不要代码围栏。',
  '字段：{"title":"这件事叫什么（<=14字，不要书名号）",',
  ' "facts":["客观事实，保留数字/时间/地点/型号/价格"],',
  ' "decided":["已经定下来的结论"],',
  ' "pending":["还没定、还悬着的问题（知道在等谁、等什么时候就写上）"],',
  ' "promises":["约定或待办，必须带时间与人名，原话里的时间不许改写"],',
  ' "quotes":[{"who":"谁","at":"HH:MM","text":"关键原话，<=40字"}],',
  ' "mood":"一句话情绪基调（谁急/谁无所谓/气氛如何）"}',
  '规则：只写这段对话里真实出现过的内容，不脑补、不评价、不写建议；没有的字段给空数组或空字符串。',
  '写法（省字数，但别丢事）：每条 ≤32 字；不同主题分条，不许为了短把没定的事并掉或漏掉；同一分钟同一人的多句可并一条；',
  '不复述往来（禁止「A说…，B又说…，A回…」这种来回），直接陈述结果：谁提了什么、定了/没定；不要把「说」当动词重复，',
  '比如写「我嫌88斤还胖」，不要写「我 说88斤还嫌胖」；原话只放 quotes；同一件事不要既写进事实又写进约定；',
  '不重复时间戳（时间只在句首出现一次）；不堆「然后、接着、于是」；人名照抄昵称。',
  '数值、时间、型号、金额一律保留原样（例如 6000、4060Ti、14:40、周六下午三点），不许改写成「一些」「大概」「过几天」这种模糊说法。',
  '别硬凑：这段要是纯粹闲聊、没约定也没新变化，facts 一两句说清气氛就够，pending/promises 空着；不要为了凑栏目把一句话拆成几条，也不要给闲聊拔高出一个「结论」。宁可粗，不要假完整。'
].join('\n');

const PATCH_SYSTEM = [
  '你是聊天台账维护员。已经有一条台账条目，现在这段对话又往前发展了。',
  '只输出「增量」，不要整篇重写。只输出 JSON，不要解释、不要代码围栏。',
  '字段：{"title":"如果原标题不准就换成更准的，否则省略",',
  ' "facts_add":[], "decided_add":[], "pending_add":[], "pending_close":["已经解决、不再悬着的原条目文字"],',
  ' "promises_add":[], "quotes_add":[{"who":"","at":"HH:MM","text":""}],',
  ' "mood":"更新后的情绪基调，没变就省略",',
  ' "changes":["这次变化的一句话说明，比如「阿伟把时间认错成 3 点，后来改成 4 点」"]}',
  '规则：只补新出现的细节；同一件事不要换个说法重复加；数值时间型号保留原样。',
  '写法：每条 ≤32 字；不同主题分条，不许为省字漏事；不复述往来，直接写结果；不要把「说」当动词重复；同一件事不要事实与约定各写一遍；不重复时间戳。',
  '别硬凑：新消息只是在闲聊、没约定也没新情况，就什么都不加，facts_add 留空；不要为了显得有进展硬编条数。'
].join('\n');

async function loadLlm() {
  try { return await import('../../../src/llm.js'); } catch (error) {
    dbg('load llm failed ' + (error?.message ?? error));
    return null;
  }
}

function usageOf(res) {
  const u = res?.usage || {};
  return {
    promptTokens: Number(u.prompt_tokens ?? u.promptTokens ?? 0) || 0,
    completionTokens: Number(u.completion_tokens ?? u.completionTokens ?? 0) || 0
  };
}

/** 初稿：整条链 → 条目。 */
export async function draftChain(chain, { maxInputChars = 1600 } = {}) {
  const llm = await loadLlm();
  if (!llm) return { ok: false, error: 'llm 不可用' };
  const lines = pickLines(chain, maxInputChars);
  const user = `会话：${chain.chatKey}\n时间：${clockOf(chain.startTs)}–${clockOf(chain.lastTs)}\n原话：\n${lines}`;
  const t0 = Date.now();
  let res = null; let obj = null; let tries = 0;
  const tot = { promptTokens: 0, completionTokens: 0 };
  const acc = (u) => { const x = usageOf(u); tot.promptTokens += x.promptTokens; tot.completionTokens += x.completionTokens; };
  for (; tries < 3 && !obj; tries += 1) {
    res = await llm.chatCompletion({
      messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }],
      tools: null,
      temperature: 0.2,
      maxTokens: 6000,
      skillContext: { thinkingMode: 'off' }
    });
    acc(res?.usage);
    obj = parseJson(res?.message?.content);
    if (!obj && tries < 2) await new Promise((r) => setTimeout(r, 800));
  }
  const rawLen = String(res?.message?.content ?? '').length;
  const rsn = String(res?.reasoning ?? '').length;
  const fin = String(res?.finishReason ?? '');
  const ctok = Number(res?.usage?.completion_tokens ?? 0) || 0;
  dbg(`draft ${chain.id} ${Date.now() - t0}ms parse=${obj ? 'ok' : 'null'} chars=${rawLen} reason=${rsn} finish=${fin} ctok=${ctok} tries=${tries}`);
  if (!obj) {
    dbg(`draft raw ${chain.id}: ${String(res?.message?.content ?? '').replace(/\s+/g, ' ').slice(0, 600)}`);
    if (rsn) dbg(`draft reasoning tail ${chain.id}: ${String(res.reasoning).replace(/\s+/g, ' ').slice(-300)}`);
    return { ok: false, error: '模型没给出合法 JSON', usage: tot };
  }
  return {
    ok: true,
    usage: tot,
    entry: {
      title: String(obj.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 16),
      facts: cleanList(obj.facts, 6, 90),
      decided: cleanList(obj.decided, 5, 90),
      pending: cleanList(obj.pending, 5, 90),
      promises: cleanList(obj.promises, 4, 100),
      quotes: quoteList(chain, obj.quotes),
      mood: String(obj.mood ?? '').trim().slice(0, 60)
    }
  };
}

const DAY_SYSTEM = [
  '你是聊天台账整理员。下面是某个会话某一天的聊天采样。',
  '把这一天整理成 1-4 条独立事件条目：同一件事的来龙去脉算一条，不要按时间写成流水账。',
  '只输出 JSON，不要解释、不要代码围栏。',
  '格式：{"entries":[{"title":"这件事叫什么（<=12字）",',
  ' "facts":["客观事实，保留数字/时间/地点/型号/金额"],"decided":["已经定下来的"],',
  ' "pending":["还没定、还悬着的"],"promises":["约定或待办，带时间与人名"],',
  ' "quotes":[{"who":"谁","at":"HH:MM","text":"关键原话，<=40字"}],',
  ' "changes":["前后不一致或改口的地方，比如「某人把时间认错成 3 点，过了一会才说其实是 4 点」"],',
  ' "mood":"一句话情绪基调"}]}',
  '规则：只写采样里真实出现过的内容，不脑补、不评价、不写建议；没有的字段给空数组或空字符串；数值时间型号金额一律保留原样。',
  '别硬凑：纯闲聊的时段不用单独成条，并进相邻那件事或直接略过；不要为了凑满 1-4 条把闲聊拔高成事件。',
  '写法（省字数，但别丢事）：每条 ≤32 字；不同主题分条，不许为了短把没定的事并掉或漏掉；同一分钟同一人的多句可并一条；',
  '不复述往来（禁止「A说…，B又说…，A回…」），直接陈述结果：谁提了什么、定了还是没定；不要把「说」当动词重复，',
  '比如写「我嫌 88 斤还胖」，不要写「我 说88斤还嫌胖」；原话只放 quotes；',
  '同一件事不要既写进事实又写进约定；不重复时间戳；不堆「然后、接着、于是」；人名照抄昵称。'
].join('\n');

function pickDayLines(msgs, maxChars = 2200) {
  const all = Array.isArray(msgs) ? msgs : [];
  if (!all.length) return '';
  let picked = all;
  if (all.length > 40) {
    const want = 36;
    const step = Math.floor(all.length / want);
    const idx = new Set([0, 1, 2, 3, 4, 5, all.length - 1, all.length - 2, all.length - 3]);
    for (let i = 6; i < all.length - 6; i += Math.max(1, step)) idx.add(i);
    picked = [...idx].sort((a, b) => a - b).map((i) => all[i]);
  }
  const lines = [];
  let used = 0;
  for (const m of picked) {
    const line = `${clockOf(m.ts)} ${m.self ? '我' : m.who}: ${String(m.text || '').slice(0, 100)}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join('\n');
}

/**
 * 历史补录：一天一个会话 → 若干条台账条目。
 * @returns {{ok:boolean, entries:Array, usage?:object, error?:string}}
 */
export async function digestDay({ chatKey, label, msgs }, { maxInputChars = 2200 } = {}) {
  const llm = await loadLlm();
  if (!llm) return { ok: false, error: 'llm 不可用' };
  const lines = pickDayLines(msgs, maxInputChars);
  if (!lines) return { ok: false, error: '这天没有可用内容' };
  const pseudo = { chatKey, label, msgs };
  const user = `会话：${chatKey}\n日期：${label}\n聊天采样：\n${lines}`;
  const t0 = Date.now();
  let res = null; let obj = null; let tries = 0;
  const tot = { promptTokens: 0, completionTokens: 0 };
  for (; tries < 3 && !obj; tries += 1) {
    res = await llm.chatCompletion({
      messages: [{ role: 'system', content: DAY_SYSTEM }, { role: 'user', content: user }],
      tools: null,
      temperature: 0.2,
      maxTokens: 6000,
      skillContext: { thinkingMode: 'off' }
    });
    const u = usageOf(res); tot.promptTokens += u.promptTokens; tot.completionTokens += u.completionTokens;
    obj = parseJson(res?.message?.content);
    if (!obj && tries < 2) await new Promise((r) => setTimeout(r, 800));
  }
  dbg(`digest ${chatKey} ${label} ${Date.now() - t0}ms parse=${obj ? 'ok' : 'null'} chars=${String(res?.message?.content ?? '').length} tries=${tries}`);
  if (!obj) return { ok: false, error: '模型没给出合法 JSON', usage: tot };
  const raw = Array.isArray(obj.entries) ? obj.entries : (obj.title ? [obj] : []);
  const entries = raw
    .filter((e) => e && typeof e === 'object')
    .slice(0, 4)
    .map((e) => ({
      title: String(e.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 16),
      facts: cleanList(e.facts, 5, 90),
      decided: cleanList(e.decided, 4, 90),
      pending: cleanList(e.pending, 4, 90),
      promises: cleanList(e.promises, 4, 100),
      quotes: quoteList(pseudo, e.quotes),
      changes: cleanList(e.changes, 3, 100),
      mood: String(e.mood ?? '').trim().slice(0, 60)
    }))
    .filter((e) => e.title || e.facts.length || e.decided.length || e.pending.length || e.promises.length);
  return { ok: true, entries, usage: tot };
}

const FINAL_SYSTEM = [
  '你是聊天台账的终稿编辑。已经有一条写好的台账条目，现在这条事件链结束了。',
  '把已有条目和这条链的原话合在一起，精修成终稿：合并重复、补上漏掉的关键事、把已经解决/已经作废的未决关掉，',
  '最后才出现的变化写进事实或约定；已有的真实信息不要丢，不准为了整齐改写原意。',
  '只输出 JSON，不要解释、不要代码围栏。',
  '字段：{"title":"这件事叫什么（<=14字，不要书名号）",',
  ' "facts":["客观事实，保留数字/时间/地点/型号/价格"],',
  ' "decided":["已经定下来的结论"],',
  ' "pending":["还没定、还悬着的问题（知道在等谁、等什么时候就写上）"],',
  ' "pending_close":["已经解决、不再悬着的旧条目文字，必须照抄旧条目的写法"],',
  ' "promises":["约定或待办，必须带时间与人名，原话里的时间不许改写"],',
  ' "quotes":[{"who":"谁","at":"HH:MM","text":"关键原话，<=40字"}],',
  ' "mood":"一句话情绪基调（谁急/谁无所谓/气氛如何）"}',
  '规则：只写真实出现过的内容，不脑补、不评价、不写建议；没有的字段给空数组或空字符串。',
  '写法：每条 ≤32 字；不同主题分条，不许为了短把没定的事并掉或漏掉；同一分钟同一人的多句可并一条；',
  '不复述往来（禁止「A说…，B又说…，A回…」），直接陈述结果；不要把「说」当动词重复；原话只放 quotes；',
  '同一件事不要既写进事实又写进约定；不重复时间戳；人名照抄昵称。',
  '数值、时间、型号、金额一律保留原样，不许改写成「一些」「大概」「过几天」。',
  '别硬凑：纯闲聊就一两句说清气氛，没有未决或约定就留空，不要拔高出一个「结论」。'
].join('\n');

/** 终稿精修：已有条目 + 整条链采样 → 一份收口的终稿。 */
export async function refineChain(chain, { maxInputChars = 2600 } = {}) {
  const llm = await loadLlm();
  if (!llm) return { ok: false, error: 'llm 不可用' };
  const lines = pickLines(chain, maxInputChars);
  if (!lines) return { ok: false, error: '这条链没有可用原话' };
  const current = [
    `标题：${chain.title || '（无）'}`,
    `事实：${(chain.facts || []).join('；') || '（无）'}`,
    `已定：${(chain.decided || []).join('；') || '（无）'}`,
    `未决：${(chain.pending || []).join('；') || '（无）'}`,
    `约定：${(chain.promises || []).join('；') || '（无）'}`,
    `情绪：${chain.mood || '（无）'}`
  ].join('\n');
  const user = `会话：${chain.chatKey}\n时间：${clockOf(chain.startTs)}–${clockOf(chain.lastTs)}\n已有条目：\n${current}\n\n完整原话采样：\n${lines}`;
  const t0 = Date.now();
  let res = null; let obj = null; let tries = 0;
  const tot = { promptTokens: 0, completionTokens: 0 };
  const acc = (u) => { const x = usageOf(u); tot.promptTokens += x.promptTokens; tot.completionTokens += x.completionTokens; };
  for (; tries < 3 && !obj; tries += 1) {
    res = await llm.chatCompletion({
      messages: [{ role: 'system', content: FINAL_SYSTEM }, { role: 'user', content: user }],
      tools: null,
      temperature: 0.2,
      maxTokens: 6000,
      skillContext: { thinkingMode: 'off' }
    });
    acc(res?.usage);
    obj = parseJson(res?.message?.content);
    if (!obj && tries < 2) await new Promise((r) => setTimeout(r, 800));
  }
  dbg(`refine ${chain.id} ${Date.now() - t0}ms parse=${obj ? 'ok' : 'null'} chars=${String(res?.message?.content ?? '').length} tries=${tries}`);
  if (!obj) return { ok: false, error: '模型没给出合法 JSON', usage: tot };
  return {
    ok: true,
    usage: tot,
    entry: {
      title: String(obj.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 16),
      facts: cleanList(obj.facts, 6, 90),
      decided: cleanList(obj.decided, 5, 90),
      pending: cleanList(obj.pending, 5, 90),
      pendingClose: cleanList(obj.pending_close, 6, 90),
      promises: cleanList(obj.promises, 4, 100),
      quotes: quoteList(chain, obj.quotes),
      mood: String(obj.mood ?? '').trim().slice(0, 60)
    }
  };
}

/** 增量补丁：已有条目 + 新消息 → 只补变化。 */
export async function patchChain(chain, { maxInputChars = 1600, sinceCount = 0 } = {}) {
  const llm = await loadLlm();
  if (!llm) return { ok: false, error: 'llm 不可用' };
  const newMsgs = (chain.msgs || []).slice(Math.max(0, sinceCount));
  const lines = pickLines({ ...chain, msgs: newMsgs.length ? newMsgs : chain.msgs }, maxInputChars);
  const current = [
    `标题：${chain.title || '（无）'}`,
    `事实：${chain.facts.join('；') || '（无）'}`,
    `已定：${chain.decided.join('；') || '（无）'}`,
    `未决：${chain.pending.join('；') || '（无）'}`,
    `约定：${chain.promises.join('；') || '（无）'}`
  ].join('\n');
  const user = `已有条目：\n${current}\n\n新增原话：\n${lines}`;
  const t0 = Date.now();
  let res = null; let obj = null; let tries = 0;
  const tot = { promptTokens: 0, completionTokens: 0 };
  const acc = (u) => { const x = usageOf(u); tot.promptTokens += x.promptTokens; tot.completionTokens += x.completionTokens; };
  for (; tries < 3 && !obj; tries += 1) {
    res = await llm.chatCompletion({
      messages: [{ role: 'system', content: PATCH_SYSTEM }, { role: 'user', content: user }],
      tools: null,
      temperature: 0.2,
      maxTokens: 6000,
      skillContext: { thinkingMode: 'off' }
    });
    acc(res?.usage);
    obj = parseJson(res?.message?.content);
    if (!obj && tries < 2) await new Promise((r) => setTimeout(r, 800));
  }
  dbg(`patch ${chain.id} ${Date.now() - t0}ms reason=${String(res?.reasoning ?? '').length} finish=${String(res?.finishReason ?? '')} parse=${obj ? 'ok' : 'null'} tries=${tries}`);
  if (!obj) return { ok: false, error: '模型没给出合法 JSON', usage: tot };
  return {
    ok: true,
    usage: tot,
    patch: {
      title: String(obj.title ?? '').replace(/\s+/g, ' ').trim().slice(0, 16),
      factsAdd: cleanList(obj.facts_add, 4, 90),
      decidedAdd: cleanList(obj.decided_add, 4, 90),
      pendingAdd: cleanList(obj.pending_add, 4, 90),
      pendingClose: cleanList(obj.pending_close, 4, 90),
      promisesAdd: cleanList(obj.promises_add, 3, 100),
      quotesAdd: quoteList(chain, obj.quotes_add),
      mood: String(obj.mood ?? '').trim().slice(0, 60),
      changes: cleanList(obj.changes, 3, 100)
    }
  };
}



