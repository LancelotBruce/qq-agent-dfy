// B 阶段：用一次便宜的小模型调用，给「小时块」打标签（闲聊/正事/约定/待办/事实），
// 抽关键词与人物，把值得长期记的点写成语义卡。
//
// 设计约束（照抄主工程的口径）：
//   · 按块分析，不按条 —— 一条一次调用会把成本放大 20 倍，而且没有上下文判断不准。
//   · 只分析「已经结束的小时」，进行中的小时等它长够大再说，避免每 10 分钟重复分析同一块。
//   · 有硬预算（每天 N 次）+ 每次只处理少量块；失败不重试风暴。
//   · 分析失败绝不影响主流程：本模块所有异常都吞掉并记日志。
import fs from 'node:fs';
import path from 'node:path';
import { getArchMemory } from './arch.js';
import { dayKeyOf, hourKeyOf } from './longterm.js';

const STATE_VERSION = 1;
const FENCE = String.fromCharCode(96, 96, 96);

function readJson(file, fb) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch { return fb; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 状态写不进去只影响预算/去重，不影响主流程 */ }
}

function loadState(file) {
  const raw = readJson(file, null);
  const state = raw && typeof raw === 'object' ? raw : {};
  state.version = STATE_VERSION;
  state.chunks = state.chunks && typeof state.chunks === 'object' ? state.chunks : {};
  state.budget = state.budget && typeof state.budget === 'object' ? state.budget : {};
  const today = dayKeyOf(Date.now());
  if (state.budget.day !== today) {
    state.budget = { day: today, calls: 0, promptTokens: 0, completionTokens: 0 };
  }
  return state;
}

const TYPES = new Set(['chitchat', 'topic', 'plan', 'task', 'fact', 'conflict']);

function clamp(n, min, max, fb) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fb;
  return Math.min(max, Math.max(min, v));
}

function cleanList(v, max, len) {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const x of v) {
    const s = String(x || '').trim();
    if (!s || s.length > len || out.includes(s)) continue;
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

/** 从模型回答里抽出 JSON（容忍代码围栏 / 前后废话）。 */
export function parseAnalysis(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  let body = raw;
  const i = raw.indexOf(FENCE);
  if (i >= 0) {
    const j = raw.indexOf(FENCE, i + FENCE.length);
    if (j > i) {
      body = raw.slice(i + FENCE.length, j).trim().replace(/^json/i, '').trim();
    }
  }
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let obj;
  try { obj = JSON.parse(body.slice(start, end + 1)); } catch { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const type = TYPES.has(obj.type) ? obj.type : 'chitchat';
  const points = (Array.isArray(obj.points) ? obj.points : [])
    .slice(0, 3)
    .map((p) => ({
      type: TYPES.has(p?.type) && p.type !== 'chitchat' ? p.type : 'topic',
      text: String(p?.text || '').trim().slice(0, 80),
      importance: clamp(p?.importance, 0, 5, 2),
      keywords: cleanList(p?.keywords, 5, 14)
    }))
    .filter((p) => p.text.length >= 4);
  return {
    summary: String(obj.summary || '').trim().slice(0, 80),
    type,
    importance: clamp(obj.importance, 0, 5, 1),
    keywords: cleanList(obj.keywords, 6, 14),
    people: cleanList(obj.people, 5, 20),
    points
  };
}

function buildMessages(chunk, maxChars) {
  const snippets = (chunk.snippets || []).slice().sort((a, b) => Number(b.w || 1) - Number(a.w || 1));
  const picked = [];
  let used = 0;
  for (const s of snippets) {
    const line = (s.self ? '我' : (s.who || '?')) + ': ' + String(s.text || '').slice(0, 100);
    if (used + line.length > maxChars) break;
    picked.push(line);
    used += line.length + 1;
  }
  const user = [
    '群：' + chunk.chatKey,
    '时段：' + chunk.hourKey,
    '这一小时的摘要：' + String(chunk.summary || '').slice(0, 320),
    '原话（按信息量排序）：'
  ].concat(picked).join('\n');

  const system = [
    '你是 QQ 群的聊天记忆分析师。读一个小时的聊天片段，判断哪些内容值得长期记住。',
    '只输出 JSON，不要任何解释、不要代码围栏。格式：',
    '{"summary":"这一小时聊了什么（<=50字）",',
    ' "type":"chitchat|topic|plan|task|fact|conflict",',
    ' "importance":0-5,',
    ' "keywords":["3-6个检索词"],',
    ' "people":["出现的人名或群名片"],',
    ' "points":[{"type":"plan|task|fact|topic","text":"值得长期记住的一句话（<=40字）","importance":0-5,"keywords":["..."]}]}',
    '判定口径：importance 0=纯水聊/刷屏，1=情绪玩梗，2=普通话题，3=有明确信息（人名/数字/安排，或长期有用的群体常识：外号、称呼、谁和谁什么关系、某个梗的由来），4=约定或待办或长期事实，5=长期关键（身份、关系、禁忌）。',
    'points 最多 3 条；没有值得记的就给空数组。外号/称呼/关系这类群体常识也值得记（type=topic，importance>=3）。',
    '不要记录：玩笑梗、表情、重复刷屏、隐私（手机号/住址/密码/身份证）。',
    '闲聊不要硬记成事实；拿不准就不记。'
  ].join('\n');
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/**
 * 跑一轮分析。
 * @param {{ memoryRoot:string, longterm:object, settings:object, log:Function }} args
 */
function makeDebug(memoryRoot) {
  const file = path.join(memoryRoot, 'analyzer-debug.log');
  return (msg) => {
    try {
      const line = new Date().toISOString() + ' ' + msg + '\n';
      fs.appendFileSync(file, line);
      const st = fs.statSync(file);
      if (st.size > 256 * 1024) {
        const keep = fs.readFileSync(file, 'utf8').split('\n').slice(-200).join('\n');
        fs.writeFileSync(file, keep, 'utf8');
      }
    } catch { /* 调试日志失败不影响主流程 */ }
  };
}

export async function runAnalysis({ memoryRoot, longterm, settings = {}, log = () => {} } = {}) {
  const dbg = makeDebug(memoryRoot);
  dbg('start enabled=' + settings.enabled + ' budget=' + settings.dailyBudget);
  if (settings.enabled === false || !longterm) return { analyzed: 0, added: 0, skipped: 'disabled' };
  const budgetMax = clamp(settings.dailyBudget, 0, 500, 40);
  const maxPerRun = clamp(settings.maxPerRun, 1, 10, 3);
  const maxChars = clamp(settings.maxInputChars, 600, 3000, 1400);
  const lookbackDays = clamp(settings.lookbackDays, 1, 30, 3);
  const minDay = dayKeyOf(Date.now() - lookbackDays * 86400000);
  const stateFile = path.join(memoryRoot, 'analyzer-state.json');
  const state = loadState(stateFile);
  if (budgetMax > 0 && state.budget.calls >= budgetMax) return { analyzed: 0, added: 0, skipped: 'budget' };

  const nowHour = hourKeyOf(Date.now());
  const candidates = [];
  for (const id of longterm.listChunkIds()) {
    if (!/^hour_/.test(id)) continue;
    const chunk = longterm.readChunk(id);
    if (!chunk || !chunk.chatKey) continue;
    if (String(chunk.hourKey || '').slice(0, 10) < minDay) continue;   // 只回看最近几天，别为考古烧钱
    const msgs = Array.isArray(chunk.snippets) ? chunk.snippets.length : 0;
    if (msgs < 8) continue;
    const st = state.chunks[id];
    if (st && msgs <= (st.msgs || 0)) continue;
    const closed = String(chunk.hourKey || '') < nowHour;
    if (!closed) {
      // 进行中的小时：只有首次且内容够多，或长到明显更大时才分析
      if (!st) { if (msgs < 40) continue; }
      else if (msgs - (st.msgs || 0) < 25 || Date.now() - (st.at || 0) < 40 * 60000) continue;
    }
    candidates.push({ id, chunk, msgs, closed });
  }
  dbg('candidates=' + candidates.length + ' budgetCalls=' + state.budget.calls + '/' + budgetMax);
  if (!candidates.length) return { analyzed: 0, added: 0, skipped: 'nothing' };

  candidates.sort((a, b) => String(b.chunk.hourKey || '').localeCompare(String(a.chunk.hourKey || '')));

  let llm;
  try {
    llm = await import('../../../src/llm.js');   // lib -> conversation-memory -> plugins -> app/src
  } catch (error) {
    log('分析器：加载核心 llm 失败：' + (error?.message ?? error));
    return { analyzed: 0, added: 0, skipped: 'llm-unavailable' };
  }

  const cards = getArchMemory().cards;
  let analyzed = 0;
  let added = 0;
  let failures = 0;

  for (const c of candidates) {
    if (analyzed >= maxPerRun) break;
    if (budgetMax > 0 && state.budget.calls >= budgetMax) break;
    if (failures >= 2) break;

    let result = null;
    let usage = null;
    const t0 = Date.now();
    dbg('call ' + c.id + ' msgs=' + c.msgs);
    try {
      const res = await llm.chatCompletion({
        messages: buildMessages(c.chunk, maxChars),
        tools: null,
        temperature: 0.2,
        maxTokens: 500,
        // 这是结构化抽取，不需要思考：跟着用户设置走（可能开着 thinking）时，
        // reasoning 会把 max_tokens 吃光、content 变成空串。按次强制关掉。
        skillContext: { thinkingMode: 'off' }
      });
      usage = res?.usage || null;
      const content = res?.message?.content;
      result = parseAnalysis(content);
      dbg('done ' + c.id + ' ' + (Date.now() - t0) + 'ms contentChars=' + String(content || '').length
        + ' parse=' + (result ? 'ok' : 'null')
        + (result ? ' result=' + JSON.stringify({ t: result.type, i: result.importance, p: result.points.length, s: result.summary }) : ''));
    } catch (error) {
      failures += 1;
      dbg('error ' + c.id + ' ' + (Date.now() - t0) + 'ms ' + (error?.message ?? error));
      log('分析 ' + c.id + ' 失败：' + (error?.message ?? error));
      continue;
    }

    state.budget.calls += 1;
    state.budget.promptTokens += Number(usage?.prompt_tokens) || 0;
    state.budget.completionTokens += Number(usage?.completion_tokens) || 0;
    state.chunks[c.id] = {
      msgs: c.msgs,
      at: Date.now(),
      ok: Boolean(result),
      importance: result ? result.importance : null,
      points: result ? result.points.length : 0
    };
    analyzed += 1;

    if (!result) {
      log('分析 ' + c.id + '：返回不是合法 JSON，已跳过');
      continue;
    }
    try {
      const n = cards.ingestAnalysis(c.chunk, result);
      added += n;
      if (n > 0) {
        log('分析 ' + c.id + '：' + result.type + '/' + result.importance + '，写入 ' + n + ' 张卡');
      }
    } catch (error) {
      log('分析 ' + c.id + ' 写卡失败：' + (error?.message ?? error));
    }
  }

  writeJson(stateFile, state);
  return { analyzed, added, tokens: { prompt: state.budget.promptTokens, completion: state.budget.completionTokens } };
}

export function analysisStats(memoryRoot) {
  try {
    const state = loadState(path.join(memoryRoot, 'analyzer-state.json'));
    return { budget: state.budget, chunks: Object.keys(state.chunks).length };
  } catch {
    return null;
  }
}
