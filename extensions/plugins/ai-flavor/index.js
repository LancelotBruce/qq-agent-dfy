// 去 AI 味（ai-flavor）—— 拦截提示 + 草稿改写
//
// 思路来自「不能纯禁，禁的同时要给可替换语料」：
//   1. before-llm-messages：把「禁写清单 + 现成说法」塞进系统提示，且每次随机抽样，
//      避免固定的几条语料自己又变成新的八股；
//   2. after-response：模型已经写出来的草稿里如果还蹦出八股句，直接替换成语料库里的说法，
//      这一步是真正意义上的「拦截」，不依赖模型自觉。
//
// 两道都不碰宿主核心，只挂钩子；关掉设置里的开关即完全不生效。

import { CORPUS, TAG_HINT } from './corpus.js';

const PLUGIN_ID = 'ai-flavor';

let ctxRef = null;
const stats = { injected: 0, rewrites: 0, lastAt: 0, lastChanges: [], samplesUsed: 0 };

function settings() {
  try { return ctxRef?.config?.all?.() ?? {}; } catch { return {}; }
}

/** 逗号/分号/换行 都能当分隔符。 */
function splitList(raw) {
  const out = [];
  for (const item of String(raw ?? '').split(/[,，、;；\n]+/)) {
    const v = item.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

/**
 * 把设置里的自定义内容并进语料库。
 * extraBanned：一行一条，只进禁写清单（不改写，避免误删正文）。
 * extraSay：一行 `标签|说法1,说法2`，往对应标签的语料里追加；标签不存在就新建。
 */
function buildCorpus(cfg) {
  const rows = CORPUS.map((row) => ({ tag: row.tag, banned: [...row.banned], say: [...row.say] }));
  const bannedOnly = splitList(cfg?.extraBanned);

  for (const line of String(cfg?.extraSay ?? '').split(/\n+/)) {
    const text = line.trim();
    if (!text || !text.includes('|')) continue;
    const [tagRaw, sayRaw] = text.split('|');
    const tag = tagRaw.trim();
    const says = splitList(sayRaw);
    if (!tag || !says.length) continue;
    let row = rows.find((item) => item.tag === tag);
    if (!row) { row = { tag, banned: [], say: [] }; rows.push(row); }
    for (const say of says) if (!row.say.includes(say)) row.say.push(say);
  }
  return { rows, bannedOnly };
}

function pickFew(list, count, used) {
  const pool = list.filter((item) => !used.has(item));
  const source = pool.length ? pool : list;
  const out = [];
  for (let i = 0; i < Math.min(count, source.length); i++) {
    const idx = Math.floor(Math.random() * source.length);
    const value = source.splice(idx, 1)[0];
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

function buildDirective(cfg, rows, bannedOnly) {
  const perTag = Math.max(1, Math.min(4, Number(cfg?.samplePerTag) || 2));
  const used = new Set();
  const lines = ['【说人话·硬约束】闲聊用短句，单句 1-15 字，一行一句；讨论、给观点、佐证或反驳时不受字数限制，可分多条讲清楚；不写括号注释，不堆句号，不用书面总结词。'];
  const banned = [];
  const sampleLines = [];

  for (const row of rows) {
    if (row.banned.length) banned.push(row.banned.slice(0, 4).join(' / '));
    if (row.say.length) {
      const picked = pickFew(row.say, perTag, used);
      if (picked.length) {
        picked.forEach((item) => used.add(item));
        const hint = TAG_HINT[row.tag] ? `（${TAG_HINT[row.tag]}）` : '';
        sampleLines.push(`· ${row.tag}${hint} → ${picked.join(' / ')}`);
      }
    }
  }
  for (const phrase of bannedOnly) banned.push(phrase);

  if (banned.length) lines.push(`这些句式一律不许出现：${banned.slice(0, 15).join('；')}。`);
  if (sampleLines.length) {
    lines.push('要表达同类意思就从下面挑，换着用，别老用同一句：');
    lines.push(...sampleLines);
  }
  const text = lines.join('\n');
  stats.samplesUsed = used.size;
  if (text.length <= 1200) return text;
  // 超长时按整行裁，不切半句：以前 slice(0,1200) 会留下「· 对比转折（解释、澄清、转」
  // 这种半截解释，白占 token 还容易被模型当指令读。
  const kept = [];
  let len = 0;
  for (const line of lines) {
    if (len + line.length + 1 > 1200) break;
    kept.push(line);
    len += line.length + 1;
  }
  return kept.join('\n');
}

/** 把草稿里的八股句换成语料。返回 { text, changes }。 */
function rewriteText(raw, rows, bannedOnly) {
  let text = String(raw ?? '');
  const used = new Set();
  const changes = [];

  for (const row of rows) {
    if (!row.say.length) continue;
    for (const phrase of row.banned) {
      if (!phrase || phrase.length < 3) continue;
      while (text.includes(phrase)) {
        const pool = row.say.filter((item) => !used.has(item));
        const candidate = (pool.length ? pool : row.say)[Math.floor(Math.random() * (pool.length ? pool.length : row.say.length))];
        if (!candidate) break;
        // 全句替换，且避免同一句语料在一条消息里出现两次
        text = text.replace(phrase, candidate);
        used.add(candidate);
        changes.push(`${phrase} → ${candidate}`);
      }
    }
  }
  for (const phrase of bannedOnly) {
    // 没有替换语的只做标记，不硬删（删正文比留八股更糟）
    if (phrase && text.includes(phrase)) changes.push(`${phrase}（无替换语，仅记录）`);
  }
  return { text, changes };
}

/**
 * before-llm-messages：把风格指令挂到「当前这一轮 user 消息」末尾。
 *
 * 缓存稳定性：这段是每轮随机抽样的（buildDirective 里 Math.random 选语料），
 * 以前追加在 system 尾部，等于每轮都给 system 造一个新尾巴，前缀缓存在 system
 * 结尾处断掉，后面的 user/历史全部重算。user 消息本来就每轮都变，挂在这里零成本，
 * 措辞、抽样逻辑、@ 后的兜底拦截都不改，只换挂载位置。
 */
function injectStyle(payload = {}) {
  const cfg = settings();
  if (cfg.enabled === false || cfg.inject === false) return;
  const messages = payload?.messages;
  if (!Array.isArray(messages) || !messages.length) return;
  const { rows, bannedOnly } = buildCorpus(cfg);
  const directive = buildDirective(cfg, rows, bannedOnly);
  if (!directive) return;
  try {
    let userIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i] && messages[i].role === 'user') { userIndex = i; break; }
    }
    if (userIndex >= 0) {
      const target = messages[userIndex];
      if (target.content && typeof target.content !== 'string') return; // 多模态内容，不动
      const content = typeof target.content === 'string' ? target.content : '';
      if (content.includes('【说人话·硬约束】')) return; // 已经注过了，别叠加
      messages[userIndex] = { ...target, content: `${content.trimEnd()}\n\n${directive}` };
    } else {
      // 没有 user 消息（极少数路径）：退回 system 兜底，保证指令一定进得去
      const sysIndex = messages.findIndex((message) => message && message.role === 'system');
      if (sysIndex >= 0) {
        const target = messages[sysIndex];
        const content = typeof target.content === 'string' ? target.content : '';
        if (content.includes('【说人话·硬约束】')) return;
        messages[sysIndex] = { ...target, content: `${content}\n\n${directive}` };
      } else {
        messages.unshift({ role: 'system', content: directive });
      }
    }
    stats.injected += 1;
    stats.lastAt = Date.now();
    if (cfg.verbose === true) ctxRef?.log?.info?.(`[ai-flavor] 已注入风格指令（${stats.samplesUsed} 条语料）`);
  } catch (error) {
    ctxRef?.log?.warn?.(`[ai-flavor] 注入失败：${error?.message ?? error}`);
  }
}

/** after-response：草稿里还有八股句就当场换掉。 */
function rewriteDraft(payload = {}) {
  const cfg = settings();
  if (cfg.enabled === false || cfg.rewrite === false) return;
  const message = payload?.response?.message;
  if (!message || typeof message.content !== 'string' || !message.content.trim()) return;
  // 带工具调用的一轮内容通常是空的或过渡句，改了没意义，也怕影响工具解析
  if (Array.isArray(message.tool_calls) && message.tool_calls.length) return;
  try {
    const { rows, bannedOnly } = buildCorpus(cfg);
    const { text, changes } = rewriteText(message.content, rows, bannedOnly);
    if (!changes.length) return;
    message.content = text;
    stats.rewrites += changes.length;
    stats.lastChanges = changes.slice(-8);
    stats.lastAt = Date.now();
    ctxRef?.log?.info?.(`[ai-flavor] 改写 ${changes.length} 处：${changes.slice(0, 4).join('；')}`);
  } catch (error) {
    ctxRef?.log?.warn?.(`[ai-flavor] 改写失败：${error?.message ?? error}`);
  }
}

export const hooks = {
  'before-llm-messages': injectStyle,
  'after-response': rewriteDraft,
};

export function setup(ctx) {
  ctxRef = ctx;
  const cfg = settings();
  ctx?.log?.info?.(`[ai-flavor] 已挂载（注入=${cfg.inject !== false} 改写=${cfg.rewrite !== false} 语料 ${CORPUS.length} 类）`);
  ctx?.lifecycle?.onStop?.(() => { ctxRef = null; });
}

/** 自测/排查用：不启插件也能单独跑一遍改写。 */
export const internals = { buildCorpus, buildDirective, rewriteText, stats };

/**
 * 供 core-tools 的发送入口调用（flavor-bridge）。
 * 0.5 的真实消息走 send_message 工具，所以必须在这里拦一道，after-response 只是兜底。
 * 返回同长度数组；没有任何改动时原样返回。
 */
export function rewriteOutgoingTexts(texts, settingsOverride) {
  const cfg = { ...(settingsOverride ?? settings()) };
  if (cfg.enabled === false || cfg.rewrite === false) return texts;
  const { rows, bannedOnly } = buildCorpus(cfg);
  const out = [];
  let total = 0;
  for (const text of Array.isArray(texts) ? texts : []) {
    if (typeof text !== 'string' || !text.trim()) { out.push(text); continue; }
    const { text: rewritten, changes } = rewriteText(text, rows, bannedOnly);
    out.push(rewritten);
    if (changes.length) {
      total += changes.length;
      if (ctxRef) ctxRef?.log?.info?.(`[ai-flavor] 发送前改写 ${changes.length} 处：${changes.slice(0, 4).join('；')}`);
    }
  }
  if (total) { stats.rewrites += total; stats.lastAt = Date.now(); }
  return out;
}
