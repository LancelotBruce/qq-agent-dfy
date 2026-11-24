// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek 余额 / 当日用量查询 · v1.9.0
//
// v1.9.0（本版）：
//   · 修「主人被判成不是主人」：一批触发消息里可能混进别人的发言（比如你 @ 我
//     问余额，同一批里还有别人发的图片），旧逻辑取「最后一条」的发送者，会取到
//     别人。现在改成「谁 @ 我，谁才是提问的人」——只拿 @ 我的那几条的发送者比。
//   · 群里只认「@ 自己」：没 @ 我（@ 的是群里另一个机器人）就彻底沉默。
//   · 0.5 接口适配：ctx.send 是能力对象（sendTextBatch），没有 ctx.sender；
//     session.trigger 只是摘要，触发消息从 store.recent + triggerEntryIds 取。
//   · 余额见底时按冷却给模型一句卖萌讨饭许可；群里仍然只发余额本身。
// ─────────────────────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBalanceClient } from './balance-api.js';

const TOOL_MAIN = 'deepseek_balance_query';
const DEFAULT_OWNER = '1000000000';
// 不再预设求情句式：余额见底时只给"可以讨一句"的许可，话由模型按人设自己说。
const USAGE_INTENT = /(用量|花了多少|花了多少钱|花费|费用|消耗|token|调用次数|调用量|缓存命中|用量统计)/i;
const CQ_AT_RE = /\[CQ:at(?:,[^\]]*?)?qq=(\d+)[^\]]*\]/g;

let cfg = () => ({});
let log = () => {};
let warn = () => {};

// ── 数据根定位（0.5 与 0.4 目录层数不同，向上最多 8 层找带 config.json 的 data 根） ──
const HERE = path.dirname(fileURLToPath(import.meta.url));

function locateDataDir() {
  let dir = HERE;
  for (let i = 0; i < 8; i++) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
    for (const name of ['data-v05', 'data']) {
      if (fs.existsSync(path.join(dir, name, 'config.json'))) return path.join(dir, name);
    }
  }
  return path.resolve(HERE, '..', '..', '..', '..', 'data');
}

const DATA_DIR = locateDataDir();
const CORE_CONFIG_PATH = path.join(DATA_DIR, 'config.json');
const BEGGAR_STATE_PATH = path.join(DATA_DIR, 'deepseek-balance-beggar.json');

let coreCache = null;
let coreAt = 0;
function coreCfg() {
  if (coreCache && Date.now() - coreAt < 30000) return coreCache;
  try {
    coreCache = JSON.parse(fs.readFileSync(CORE_CONFIG_PATH, 'utf8'));
  } catch (error) {
    warn(`读取核心配置失败：${error?.message ?? error}`);
    coreCache = {};
  }
  coreAt = Date.now();
  return coreCache;
}

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = api?.log || log;
  warn = api?.warn || warn;

  api.registerTool({
    id: TOOL_MAIN,
    name: 'DeepSeek余额/用量',
    description: '查 DeepSeek 余额（人民币，充值+赠送）或当日用量（花费、token、次数、缓存命中）。有人说「余额」「还剩多少钱」「用量」「今天花了多少」就直接调，别自行判断对方是不是主人——工具内部按 QQ 判定并把结果发到当前会话。群里这条 @ 的不是我（@ 的是别的机器人）时保持沉默是预期。',
    category: 'utility',
    icon: '💰',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(ctx) {
      const chatKey = String(ctx?.chatKey || '');
      const isPrivate = /^(private|friend):/.test(chatKey);

      // ① 群里只认 @ 自己：没 @ 我（@ 的是别的机器人）就彻底闭嘴
      if (!isPrivate) {
        const atSelf = await atSelfLive(ctx, chatKey);
        if (!atSelf) {
          return {
            content: '这条消息 @ 的不是我（群里还有一个机器人），保持沉默：不要发任何消息，也不要调用任何发送工具，什么都不要回。',
          };
        }
      }

      // ② 主人判定：谁 @ 我谁才是提问的人
      if (!(await isOwnerLive(ctx, chatKey, isPrivate))) {
        return { content: '余额和用量是主人的私人数据，不便公开。被问到时说明这是主人专用，不要编造数字，也不要发送。' };
      }

      const wantsUsage = USAGE_INTENT.test(await triggerTextLive(ctx, chatKey));
      try {
        if (wantsUsage) {
          const usage = await getTodayUsage();
          const text = fmtUsage(usage);
          await say(ctx, chatKey, text);
          return { content: `${text}\n（以上已直接发到当前会话，不要再重复发一遍。）`, _cardSent: true };
        }

        const client = clientOf();
        const info = await client.getBalance(false);
        const text = client.format(info);
        await say(ctx, chatKey, text);

        const low = lowBalanceHit(info);
        if (low) {
          const coolMs = (Number((cfg() || {}).beggarCooldownMin) || 120) * 60000;
          if (Date.now() - readBeggarAt() >= coolMs) {
            markBeggarAt();
            return {
              content: `${text}\n（已发送。余额只有 ${low.who} 了，可以顺势讨一句充值：说什么、怎么说完全由你自己发挥，按你的人设来，别套固定句式，一句就够；别提具体数字、别复述余额。）${beggarTone()}`,
              _cardSent: true,
            };
          }
        }
        return { content: `${text}\n（已发送，不要重复发。）`, _cardSent: true };
      } catch (error) {
        const msg = `${wantsUsage ? '用量' : '余额'}查询失败：${error?.message ?? error}`;
        warn(msg);
        const text = wantsUsage ? await fallbackUsageText(error) : msg;
        try { await say(ctx, chatKey, text); } catch { /* 发送失败也要把内容还给模型 */ }
        return { content: text, _cardSent: true };
      }
    },
  });

  log(`已加载：单工具 ${TOOL_MAIN}（群里只认 @ 自己 · 主人按 @ 我的那条判 · 余额/用量按触发文本分流 · 查完直接发送）`);
}

// ── 触发消息（0.5：session.trigger 只是摘要，真消息从 store.recent 按 id 取） ──

async function triggerEntriesLive(ctx, chatKey) {
  const ids = Array.isArray(ctx?.session?.triggerEntryIds) ? ctx.session.triggerEntryIds.map(String) : [];
  let recent = [];
  try {
    const r = ctx?.store?.recent ? ctx.store.recent(chatKey, 30) : [];
    recent = Array.isArray(r) ? r : (await r) || [];
  } catch { recent = []; }
  if (!Array.isArray(recent) || !recent.length) return [];
  if (!ids.length) return recent.slice(-1);
  const set = new Set(ids);
  return recent.filter((m) => set.has(String(m?.id)));
}

function nicksOf(ctx) {
  const core = coreCfg();
  const persona = core?.persona || {};
  return [
    ctx?.botName,
    (cfg() || {}).botName,
    persona.nickname,
    persona.selfNickname,
    core?.onebot?.selfNickname,
    '机器人',
  ].filter(Boolean).map((s) => String(s).trim()).filter(Boolean);
}

function selfIdOf() {
  return String(coreCfg()?.onebot?.expectedSelfId || '').trim();
}

function textAtMe(text, nicks, selfId) {
  const t = String(text ?? '');
  if (!t) return false;
  for (const n of nicks) if (t.includes('@' + n)) return true;
  if (selfId) {
    for (const m of t.matchAll(CQ_AT_RE)) if (m[1] === selfId) return true;
  }
  return false;
}

function isAtMeEntry(m, nicks, sid) {
  if (!m || m.self === true) return false;
  if (m.atMe === true) return true;
  if (m.atMe === false) return false;
  return textAtMe(m?.text, nicks, sid);
}

/** 群聊里这条（或这批）消息有没有 @ 我。 */
async function atSelfLive(ctx, chatKey) {
  const entries = await triggerEntriesLive(ctx, chatKey);
  if (entries.length) {
    const nicks = nicksOf(ctx);
    const sid = selfIdOf();
    return entries.some((m) => isAtMeEntry(m, nicks, sid));
  }
  const trig = ctx?.session?.trigger;
  if (Array.isArray(trig)) {
    const nicks = nicksOf(ctx);
    const sid = selfIdOf();
    return trig.some((e) => e?.atMe === true || textAtMe(e?.text, nicks, sid));
  }
  if (typeof trig === 'string' && trig) return textAtMe(trig, nicksOf(ctx), selfIdOf());
  return false;
}

function ownerQQ() {
  const raw = String((cfg() || {}).ownerQQ || '').trim();
  return raw || DEFAULT_OWNER;
}

async function isOwnerLive(ctx, chatKey, isPrivate) {
  const owner = ownerQQ();
  if (!owner) return false;
  if (isPrivate) {
    return chatKey.replace(/^(private|friend):/, '').trim() === owner;
  }

  const entries = await triggerEntriesLive(ctx, chatKey);
  const nicks = nicksOf(ctx);
  const sid = selfIdOf();

  // ① 谁 @ 了我，谁才是提问的人——只看 @ 我的那几条，避免同批别人的发言顶替
  const atMeOnes = entries.filter((m) => isAtMeEntry(m, nicks, sid));
  if (atMeOnes.length) {
    return atMeOnes.some((m) => String(m?.senderId || '').trim() === owner);
  }

  // ② 这批没人 @ 我（口令式群聊）：退化到这批里最后一条真人发言
  const pick = [...entries].reverse().find((m) => m && m.self !== true && String(m?.senderId || '').trim());
  if (pick) return String(pick.senderId).trim() === owner;

  const trig = ctx?.session?.trigger;
  if (Array.isArray(trig)) {
    for (let i = trig.length - 1; i >= 0; i--) {
      const id = String(trig[i]?.senderId ?? trig[i]?.userId ?? '').trim();
      if (id) return id === owner;
    }
  }
  return false;
}

async function triggerTextLive(ctx, chatKey) {
  const entries = await triggerEntriesLive(ctx, chatKey);
  if (entries.length) {
    const nicks = nicksOf(ctx);
    const sid = selfIdOf();
    const asked = entries.filter((m) => isAtMeEntry(m, nicks, sid));
    const use = asked.length ? asked : entries;
    return use.map((m) => String(m?.text ?? '')).join(' ').slice(0, 400);
  }
  const trig = ctx?.session?.trigger;
  if (Array.isArray(trig)) return trig.map((e) => String(e?.text ?? '')).join(' ').slice(0, 400);
  if (typeof trig === 'string') return trig.slice(0, 400);
  return '';
}

// ── 发送：0.5 的 ctx.send 是能力对象，不是函数 ──────────────────────────────

async function say(ctx, chatKey, text) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  const opts = {};
  if (ctx?.send && typeof ctx.send.sendTextBatch === 'function') {
    const r = await ctx.send.sendTextBatch(chatKey, [body], opts);
    if (r && typeof r === 'object' && r.ok === false) throw new Error(`发送失败（failed=${r.failed ?? '?'}）`);
    return true;
  }
  if (ctx?.sender && typeof ctx.sender.sendTextBatch === 'function') {
    await ctx.sender.sendTextBatch(chatKey, [body], opts);
    return true;
  }
  if (typeof ctx?.send === 'function') {
    await ctx.send(chatKey, [{ type: 'text', data: { text: body } }], opts);
    return true;
  }
  throw new Error('当前核心没有可用的发送接口（既无 ctx.send 也无 ctx.sender）');
}

// ── 客户端构建：Key 优先取插件设置，空则读核心 config.json ────────────────

function clientOf() {
  const settings = cfg() || {};
  let key = String(settings.apiKey || '').trim();
  if (!key) key = String(coreCfg()?.api?.apiKey || '').trim();
  return createBalanceClient({
    apiKey: key,
    baseUrl: String(settings.baseUrl || ''),
    ttlMs: Number(settings.refreshMs) || undefined,
  });
}

// ── 低余额判定（阈值只用于判断，不进消息） ────────────────────────────────

function lowBalanceHit(info) {
  const thr = Number((cfg() || {}).lowThreshold) || 0;
  if (!thr) return null;
  const infos = Array.isArray(info?.balance_infos) ? info.balance_infos : [];
  const cny = infos.find((b) => String(b?.currency || '').toUpperCase() === 'CNY') || infos[0];
  const total = Number(cny?.total_balance);
  if (!Number.isFinite(total) || total > thr) return null;
  return { who: String(cny?.total_balance ?? total), thr };
}

/** 只给风格倾向，不塞固定句式；没配就完全交给模型发挥。 */
function beggarTone() {
  const t = String((cfg() || {}).beggarTone || '').trim();
  return t ? `（老板设的风格倾向：${t}，具体怎么说你自己组织。）` : '';
}

function readBeggarAt() {
  try {
    const j = JSON.parse(fs.readFileSync(BEGGAR_STATE_PATH, 'utf8'));
    return Number(j?.at) || 0;
  } catch { return 0; }
}

function markBeggarAt() {
  try {
    fs.writeFileSync(BEGGAR_STATE_PATH, JSON.stringify({ at: Date.now(), day: todayKeyOf() }), 'utf8');
  } catch (error) {
    warn(`写乞讨冷却状态失败：${error?.message ?? error}`);
  }
}

// ── 当日用量：核心本机统计接口（与控制台面板同源） ─────────────────────────

export async function getTodayUsage() {
  const core = coreCfg();
  const port = Number(core?.server?.port) || 3210;
  const token = String(core?.server?.token || '').trim();
  const query = token ? `?range=today&token=${encodeURIComponent(token)}` : '?range=today';
  const url = `http://127.0.0.1:${port}/api/usage/stats${query}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.ok) throw new Error(String(data?.error || '接口返回异常'));
  return data;
}

function fmtWan(n) {
  const v = Number(n) || 0;
  if (v >= 100000000) return `${(v / 100000000).toFixed(2)}亿`;
  if (v >= 10000) return `${(v / 10000).toFixed(1)}万`;
  return String(Math.round(v));
}

function chatLabel(key) {
  const s = String(key || '');
  if (s.startsWith('group:')) return `群 ${s.slice(6)}`;
  if (s.startsWith('private:')) return `私聊 ${s.slice(8)}`;
  return s || '未知会话';
}

function pad2(n) { return String(n).padStart(2, '0'); }

function todayKeyOf(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function fmtUsage(data) {
  const t = data?.totals || {};
  const day = String(data?.days?.[0]?.day || todayKeyOf());
  const lines = [`今日用量（${day}）：`];

  const cost = Number(t.cost) || 0;
  const peak = Number(t.peakCost) || 0;
  const off = Number(t.offPeakCost) || 0;
  let money = `花费 ¥${cost.toFixed(2)}`;
  if (Number(t.peakTokens) > 0 && peak > 0) money += `（高峰 ¥${peak.toFixed(2)} / 闲时 ¥${off.toFixed(2)}）`;
  lines.push(money);

  const hit = Number(t.cacheHitRate) || 0;
  lines.push(`Token 输入 ${fmtWan(t.promptTokens)} / 输出 ${fmtWan(t.completionTokens)} · 缓存命中 ${(hit * 100).toFixed(0)}%`);
  lines.push(`调用 ${Math.round(Number(t.runs) || 0)} 次 · 联网搜索 ${Math.round(Number(data?.searchCount ?? data?.totals?.webSearchCount ?? 0))} 次`);

  const chats = (Array.isArray(data?.chats) ? data.chats : [])
    .filter((c) => (Number(c?.cost) || 0) > 0)
    .slice(0, 3);
  if (chats.length) {
    lines.push('花费分布：' + chats.map((c) => `${chatLabel(c.key)} ¥${(Number(c.cost) || 0).toFixed(2)}`).join(' · '));
  }
  return lines.join('\n');
}

/** 接口不可达时的兜底：读核心实时用量文件（只有 token 数，没有费用）。 */
async function fallbackUsageText(error) {
  const head = `用量接口不可达（${error?.message ?? error}），改用本地用量文件，费用暂不可用。`;
  try {
    const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'usage-today.json'), 'utf8'));
    const hit = d.promptTokens ? (Number(d.cachedTokens) || 0) / Number(d.promptTokens) : 0;
    return `${head}\n今日（${d.dayKey}）Token 输入 ${fmtWan(d.promptTokens)} / 输出 ${fmtWan(d.completionTokens)}`
      + ` · 缓存命中 ${(hit * 100).toFixed(0)}% · 调用 ${Math.round(Number(d.runs) || 0)} 次`
      + ` · 联网搜索 ${Math.round(Number(d.webSearchCount) || 0)} 次`;
  } catch (e2) {
    return `${head}\n本地用量文件也读不到：${e2?.message || e2}`;
  }
}
