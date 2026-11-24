/**
 * 群友好感度与关系网（affinity）—— 确定性型插件 v1.5.0
 *
 * 机制说明：
 *  - 记分：钩子 `before-context`（核心确定性触发，每条消息都会被记账，模型无法忽略）
 *  - 情绪：钩子 `after-response` 读取模型回复末尾的隐藏标记 [aff:特别喜欢|喜欢|平淡|讨厌|特别讨厌]，
 *    就地吃掉标记（不发到群里）并折算成好感度增减 —— 比调用工具省得多，不需要来回一轮 function call
 *  - 查询：registerTool（check / rank / ties / network / reset 五个工具，说明文字已尽量压短以省 token）
 *  - 设定：**只认控制台面板**（「插件」页 → 设置，表单由 configSchema 自动渲染），
 *    v1.5.0 起不再支持在聊天里改设定，也不再生成 meta.overrides
 *  - 名单：每次落盘顺手导出 data/affinity-名单.csv，可用 Excel 打开改分数；
 *    检测到表格被手动改过会自动回读，不需要在群里喊话
 *  - 数据：持久化到项目 data/affinity.json（不放在插件目录里，方便打包上架）
 *
 * 遵守的硬约束（skill-reference.md §14）：
 *  - 钩子里不发消息、不发网络请求、不重试（只做本地读档 + 计分 + 落盘）
 *  - 发消息只走 ctx.sender 的发送队列，从不绕过它直连协议端
 *  - 调 QQ 接口只用 ctx.onebot 的封装方法，并全部 try/catch
 *  - available() 同步返回，绝不返回 Promise
 *  - 配置在执行时用 cfg() 读，不在 setup 时快照
 *  - deactivate / dispose 里清掉 activate 建的定时器
 *  - 工具 id 只用 [a-zA-Z0-9_-]，required 为空时省略
 */

import fs from 'node:fs/promises';
import path from 'node:path';

const DAY = 86400000;
const SEEN_KEEP = 800; // 每个会话最多记住多少条"已处理"消息，防重复计分
const PENDING_KEEP = 5; // 每个人最多积压多少条升级播报
const PENDING_TTL = 6 * 3600 * 1000; // 超过 6 小时的升级播报就不再打扰群里
const LEVEL_TITLES = ['陌生', '眼熟', '熟人', '老友', '挚友'];
const DEFAULT_THRESHOLDS = [50, 200, 500, 1000];

// 关系网（群友 ↔ 群友）
const TIE_TITLES = ['点头之交', '认识', '熟络', '要好', '死党'];
const DEFAULT_TIE_THRESHOLDS = [5, 15, 40, 100];
const TIE_AT_WEIGHT = 3; // @ 或引用回复：强信号
const TIE_ADJ_WEIGHT = 1; // 紧邻接话：弱信号
const TIE_CO_WEIGHT = 1; // 同一时间窗都活跃：弱信号
const TIE_ADJ_MS = 5 * 60 * 1000; // 相邻两条消息在 5 分钟内才算"接话"
const TIE_WINDOW_MS = 10 * 60 * 1000; // 10 分钟算一个共同活跃窗口
const TIE_WINDOW_MAX_USERS = 6; // 窗口里超过这么多人就不两两配对，避免组合爆炸
const TIE_CO_DAILY_CAP = 3; // 同一对人每天最多靠"共同活跃"加 3 次

// 记忆同步
const MEMORY_MARKER = '好感度档案';
const MEMORY_SYNC_INTERVAL = 30 * 60 * 1000; // 同一个人 30 分钟内不重复写记忆

// 掉落抗性：等级越高越不容易掉。数值是"实际掉落占原始值的百分比"，对应 Lv.1~Lv.5
const DEFAULT_RESIST = [100, 80, 60, 40, 20];

// 机器人的情绪档位：模型在回复末尾写一个隐藏标记，由 after-response 钩子读取后落地并吃掉标记
const SENTIMENT_LEVELS = ['特别喜欢', '喜欢', '平淡', '讨厌', '特别讨厌'];
const DEFAULT_SENTIMENT_GAINS = [8, 3, 0, -3, -8];
const SENTIMENT_TAG = 'aff'; // 标记形如 [aff:特别喜欢]
const MOOD_LOG_KEEP = 5;

// 打赏档位：金额下限（元）→ 好感分。tipTiers 配置按 "下限:分值" 递增书写
const DEFAULT_TIP_TIERS = [{ min: 0, score: 6 }, { min: 10, score: 12 }, { min: 50, score: 25 }];
// 长词必须排在短词前面，否则「特别喜欢」会被「喜欢」先匹配掉
const SENTIMENT_RE = new RegExp(`\\[${SENTIMENT_TAG}[:：]\\s*(${SENTIMENT_LEVELS.join('|')})\\s*\\]`, 'g');
const SENTIMENT_PROBE = new RegExp(`\\[${SENTIMENT_TAG}[:：]`, 'i');
const SENTIMENT_MALFORMED_RE = new RegExp(`\\[${SENTIMENT_TAG}[:：][^\\]\\n]{0,12}\\]?`, 'gi');
const CSV_CHECK_INTERVAL = 5 * 1000; // 名单表格的改动最多每 5 秒检查一次

// 可编辑名单（CSV）
const CSV_NAME = 'affinity-名单.csv';
const CSV_HEADER = [
  '会话', 'QQ号', '昵称', '好感度', '等级', '称号', '掉落抗性%',
  '发言数', '首次见面', '最近互动', '今天自动加分', '今天情绪增减', '主人'
];

const DEFAULTS = {
  perMessage: 1,
  autoGain: true,
  randomGain: true,
  gainMin: 0,
  gainMax: 1,
  atBotBonus: 1,
  replyBonus: 1,
  dailyCap: 10,
  decayAfterDays: 7,
  decayPerDay: 1,
  resistTable: '100,80,60,40,20',
  sentimentGains: '3,1,0,-1,-2',
  dailySentimentCap: 30,
  shieldTable: '0,1,2,3,4',
  shieldRefillMin: 120,
  hintCooldownMin: 15,
  deltaHint: true,
  allowNegative: true,
  scoreFloor: -100,
  negativeRecover: true,
  showNumbers: true,
  syncMemory: true,
  exportCsv: true,
  autoImportCsv: true,
  tieThresholds: '5,15,40,100',
  scanLimit: 200,
  topN: 10,
  announceLevelUp: true,
  allowReset: false,
  botQq: '',
  ownerQq: '1000000004',
  ownerScore: 200,
  levelThresholds: '10,40,100,200',
  tipOwners: '',
  tipTiers: '0:6,10:12,50:25',
  tipDailyCap: 30
};

let cfg = () => ({});
let log = () => {};
let warn = () => {};

let db = null; // { version, meta:{selfId, csvWrittenAt, memoryShape}, chats:{ [chatKey]: {members, ties, seen, lastSpeaker, lastScanAt} } }
let dbFile = '';
let loaded = false;
let dirty = false;
let activeCtx = null; // activate() 拿到的上下文（可能带 sender）
let flushTimer = null;

// ───────────────────────────── 生命周期 ─────────────────────────────

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
  warn = typeof api?.warn === 'function' ? api.warn : () => {};

  api.registerTool({
    id: 'check',
    name: '好感度查询',
    description:
      '查某人对你的好感度：分数、等级、发言数、群内排名。有人问「我好感度多少」「我和你多熟」「查 XX 的好感度」时用，target 留空＝查自己；必须调工具，别编。',
    category: 'query',
    icon: '💗',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要查的人，可以是 QQ 号（如 10001）或群昵称（如 小明）。留空表示查发问者自己。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询好感度。', isError: true };

        await ensureLoaded();
        // 查询前先补扫一次，保证分数是最新的
        await accumulate({ chatKey, store: ctx?.store, triggerEntries: ctx?.session?.triggerEntries });
        syncOwners();

        const chat = db.chats[chatKey];
        const members = chat?.members || {};
        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const target = String(args?.target ?? '').trim();
        let userId = '';
        let ambiguous = 0;

        if (target) {
          // 主人可能从没在这个群发过言，但查 TA 必须能查到（恒为满级）
          const pure = target.replace(/[^\d]/g, '');
          if (pure && isOwner(pure, s) && !members[pure]) {
            return { content: ownerReport(pure, '', s, true) };
          }
          if (!Object.keys(members).length) {
            return { content: '这个会话还没有任何好感度记录（还没人发过言，或插件刚装上）。等大家聊几句再来查就有了。' };
          }
          const hit = findMember(members, target);
          if (!hit) {
            return {
              content:
                `没有找到「${target}」的好感度记录。可能 TA 最近没在这个群发过言，` +
                '或者名字/号码写错了。可以让对方先说句话，或用 rank 工具看排行榜确认有哪些人。'
            };
          }
          userId = hit.userId;
          ambiguous = hit.ambiguous || 0;
        } else {
          if (!Object.keys(members).length) {
            return { content: '这个会话还没有任何好感度记录（还没人发过言，或插件刚装上）。等大家聊几句再来查就有了。' };
          }
          const req = await resolveRequester(ctx, chatKey, selfId, s);
          if (!req.userId) {
            return {
              content: '没能确认是谁在问好感度。请让对方在提问时带上自己的 QQ 号或昵称，或者改用 rank 工具看排行榜。',
              isError: true
            };
          }
          userId = req.userId;
        }

        const rec = members[userId] || (members[userId] = newRecord(Date.now()));
        await fillName(ctx, rec, userId);
        if (isOwner(userId, s)) {
          pinOwner(rec, s);
        } else {
          applyDecay(rec, Date.now(), s);
        }
        markDirty();
        await flush();

        const rankInfo = rankOf(members, userId, s);
        const own = isOwner(userId, s);
        const lines = [];

        if (s.showNumbers === false) {
          // 定性模式：不向模型提供任何数字，从源头上杜绝它说漏分数
          const d = own
            ? { short: titleOf(rec.score, s), text: 'TA 是主人，关系是满级的、最铁的那一档。' }
            : describeLevel(rec.score, s);
          lines.push(
            `对象：${displayName(rec.name, userId, s)}${target ? '' : '（正在提问的这个人）'}`,
            `关系：${d.short}${own ? ' · 身份：主人' : ''}`,
            `状态：${d.text}`
          );
          if (own) lines.push('进度：已经是最高档，没有更高的了。');
          else lines.push(`进度：${progressWords(rec.score, s)}`);
          if (!own && rankInfo.rank === 1 && rankInfo.total > 1) {
            lines.push('在这个群里，TA 是跟你最熟的那个人。');
          }
          if (!own && Array.isArray(rec.moodLog) && rec.moodLog.length) {
            lines.push(`备注：你上次对 TA 的印象是「${rec.moodLog[rec.moodLog.length - 1].mood}」。`);
          }
        } else {
          const resistPct = Math.round(resistFactor(rec.score, s) * 100);
          lines.push(
            `对象：${rec.name || userId}（QQ ${userId}）${target ? '' : '，也就是正在提问的这个人'}`,
            own
              ? `好感度：${rec.score} 分（满级，主人固定值，不参与加分、扣分和衰减）`
              : `好感度：${rec.score} 分${rec.score < 0 ? '（低于零，TA 把你惹毛过，处于冰点）' : ''}`,
            `等级：Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」${own ? ' · 身份：主人' : ` · 掉落抗性 ${resistPct}%（承受 ${resistPct}% 的衰减和扣分）`}`,
            `升级进度：${own ? '已经是最高等级，无需再攒' : progressText(rec.score, s)}`,
            `累计发言：${rec.msgs} 条${
              rec.dayGain || rec.daySentiment
                ? `（今天 发言+${Number(rec.dayGain) || 0}${rec.daySentiment ? ` / 情绪±${Number(rec.daySentiment) || 0}` : ''}）`
                : ''
            }`,
            `认识时间：${fmtDate(rec.firstSeen)} 起，最近互动 ${fmtDate(rec.lastSeen)}`,
            `群内排名：第 ${rankInfo.rank} 名 / 共 ${rankInfo.total} 人`
          );
          if (!own && Array.isArray(rec.moodLog) && rec.moodLog.length) {
            const last = rec.moodLog[rec.moodLog.length - 1];
            lines.push(`我上次对 TA 的印象：${fmtDate(last.at)}「${last.mood}」${last.delta > 0 ? '+' : ''}${last.delta} 分`);
          }
        }

        if (ambiguous > 1) {
          lines.push(`注意：群里有 ${ambiguous} 个人的名字都能匹配「${target}」，这里显示的是分数最高的那位。想精确指定就用 QQ 号查。`);
        }

        // 关系网摘要：TA 在群里最熟的几个人
        const ties = topTies(chat, userId, s, 3);
        if (ties.length) {
          const names = ties.map((t) => {
            const nm = members[t.other]?.name || t.other;
            return s.showNumbers === false
              ? `${nm}（${tieWords(t.w, s).title}）`
              : `${nm}（${tieLevelOf(t.w, s).title}，权重 ${t.w}）`;
          });
          lines.push(`群里最熟的人：${names.join('、')}`);
        }

        // 把"这个群友和机器人的关系"同步进长期记忆
        const mem = await syncMemberMemory(ctx, chatKey, userId, s);
        await flush();
        if (mem && mem.ok === false && !mem.skipped) {
          lines.push(`（系统提示，不用说给群友听：记忆同步未成功——${mem.reason || '未知原因'}）`);
        }

        const notices = takePending(chatKey, userId);
        if (notices.length) {
          lines.push('', `另外请在回答里顺口提一句（只提一次，别重复播）：${notices.join('；')}`);
        }

        if (s.showNumbers === false) {
          lines.push('');
          lines.push(
            '【重要】主人关闭了数字显示。上面没有给出任何分数、条数、权重或天数，' +
            '你在回答里也绝对不要说出、估算或编造任何具体数字，只按档位称呼（陌生/眼熟/熟人/老友/挚友/冰点、' +
            '点头之交/认识/熟络/要好/死党）用你自己的话自然表达（例如关系是挚友，就直接说「我们是挚友啊」这种口气）。'
          );
        }

        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询好感度失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'rank',
    name: '好感度排行榜',
    description:
      '本会话好感度排行（分数＋等级）。有人说「好感度排行」「谁跟你最熟」时用。',
    category: 'query',
    icon: '🏆',
    parameters: {
      type: 'object',
      properties: {
        topN: {
          type: 'number',
          description: '列出前几名，1~50。不填则用插件设置里的默认值。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询排行榜。', isError: true };

        await ensureLoaded();
        await accumulate({ chatKey, store: ctx?.store, triggerEntries: ctx?.session?.triggerEntries });
        syncOwners();

        const members = db.chats[chatKey]?.members || {};
        const list = sortedMembers(members);
        if (!list.length) return { content: '这个会话还没有好感度记录，等大家聊几句再来查排行榜。' };

        const n = clamp(Number(args?.topN) || Number(s.topN) || 10, 1, 50);
        const now = Date.now();
        const shown = Math.min(n, list.length);
        const noNum = s.showNumbers === false;
        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        const lines = noNum ? ['跟你最熟的人，按关系从近到远排：'] : [`好感度排行榜（前 ${shown} 名 / 共 ${list.length} 人）`];

        list.slice(0, n).forEach(([userId, rec], i) => {
          if (!isOwner(userId, s)) applyDecay(rec, now, s);
          const own = isOwner(userId, s);
          if (noNum) {
            const d = own ? { short: titleOf(rec.score, s) } : describeLevel(rec.score, s);
            lines.push(`${cnOrdinal(i)}. ${displayName(rec.name, userId, s)} —「${d.short}」${own ? ' · 主人' : ''}`);
          } else {
            lines.push(`${i + 1}. ${rec.name || userId} — ${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」${own ? ' · 主人' : ''}`);
          }
        });

        // 如果发问者自己没进榜，补一行告诉 TA 自己的位置
        if (req.userId && members[req.userId]) {
          const info = rankOf(members, req.userId, s);
          if (info.rank > shown) {
            const rec = members[req.userId];
            if (noNum) {
              lines.push(`（提问的 ${displayName(rec.name, req.userId, s)} 自己排在${cnOrdinal(info.rank - 1)}位，关系是「${describeLevel(rec.score, s).short}」）`);
            } else {
              lines.push(`（提问的 ${rec.name || req.userId} 排在第 ${info.rank} 名，${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」）`);
            }
          }
        }

        if (noNum) {
          lines.push('');
          lines.push('【重要】主人关闭了数字显示：不要说出任何分数或人数，只按上面的顺序和称号自然描述（例如「XX 跟你最熟，我们是挚友」）。');
        }

        markDirty();
        await flush();
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询排行榜失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'ties',
    name: '群友关系查询',
    description:
      '查群友关系亲疏（按 @、引用、接话自动算）。有人问「我和 XX 什么关系」「他俩熟不熟」时用；target 留空＝查自己，target＋other＝只查这两人。',
    category: 'query',
    icon: '🕸️',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要查的人，QQ 号或群昵称。留空表示查发问者自己。'
        },
        other: {
          type: 'string',
          description: '另一个人，QQ 号或群昵称。填了就只返回这两个人之间的关系。'
        },
        topN: {
          type: 'number',
          description: '列出最熟的几个人，1~20。不填用插件设置里的默认值。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法查询关系网。', isError: true };

        await ensureLoaded();
        await accumulate({ chatKey, store: ctx?.store, triggerEntries: ctx?.session?.triggerEntries });
        syncOwners();

        const chat = db.chats[chatKey];
        const members = chat?.members || {};
        if (!Object.keys(members).length) {
          return { content: '这个会话还没有任何记录，关系网是空的。等大家聊几句再来查。' };
        }

        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const noNum = s.showNumbers === false;
        const n = clamp(Number(args?.topN) || Number(s.topN) || 10, 1, 20);

        const pick = (raw) => {
          const q = String(raw ?? '').trim();
          if (!q) return null;
          const pure = q.replace(/[^\d]/g, '');
          if (pure && members[pure]) return { userId: pure, rec: members[pure] };
          return findMember(members, q);
        };

        let userId = '';
        const targetRaw = String(args?.target ?? '').trim();
        if (targetRaw) {
          const hit = pick(targetRaw);
          if (!hit) return { content: `没有找到「${targetRaw}」的记录。TA 可能最近没在这个群发过言。` };
          userId = hit.userId;
        } else {
          const req = await resolveRequester(ctx, chatKey, selfId, s);
          if (!req.userId) {
            return { content: '没能确认是谁在问关系网。请让对方带上 QQ 号或昵称再问一次。', isError: true };
          }
          userId = req.userId;
        }

        const nameOf = (uid) => displayName(members[uid]?.name, uid, s);
        const otherRaw = String(args?.other ?? '').trim();

        // ── 只查两个人的关系 ──
        if (otherRaw) {
          const hit2 = pick(otherRaw);
          if (!hit2) return { content: `没有找到「${otherRaw}」的记录。TA 可能最近没在这个群发过言。` };
          const otherId = hit2.userId;
          if (otherId === userId) return { content: '这两个是同一个人。' };
          const t = chat.ties?.[tieKeyOf(userId, otherId)];
          const n1 = nameOf(userId);
          const n2 = nameOf(otherId);
          let out;
          if (!t || !(Number(t.w) > 0)) {
            out = [
              `${n1} ↔ ${n2}`,
              '关系：还没有任何可统计的互动（没互相 @、没引用回复、没接话、也没在同一时段活跃过）。',
              '结论：系统认为他们基本没交集。'
            ];
          } else if (noNum) {
            const w = tieWords(t.w, s);
            out = [`${n1} ↔ ${n2}`, `关系：${w.title}`, `状态：${w.text}`];
            if (Number(t.at) > 0) out.push('依据：有过直接的 @ 或引用回复。');
            if (Number(t.adj) > 0) out.push('依据：经常一个说完另一个就接上。');
          } else {
            const lv = tieLevelOf(t.w, s);
            out = [
              `${n1}（QQ ${userId}） ↔ ${n2}（QQ ${otherId}）`,
              `关系权重：${t.w} · 第 ${lv.level} 档「${lv.title}」`,
              `构成：@或引用 ${t.at} 次、紧邻接话 ${t.adj} 次、同时段活跃 ${t.co} 次`,
              `最近互动：${fmtDate(t.last)}`
            ];
          }
          if (noNum) {
            out.push('');
            out.push('【重要】主人关闭了数字显示，回答里不要出现任何具体数字。');
          }
          return { content: out.join('\n') };
        }

        // ── 查某人的关系网 ──
        const allTies = topTies(chat, userId, s, 999);
        const ties = allTies.slice(0, n);
        const me = members[userId];
        if (!allTies.length) {
          return { content: `${displayName(me?.name, userId, s)} 还没有和任何人产生可统计的互动，关系网是空的。` };
        }

        const lines = noNum
          ? [`${displayName(me?.name, userId, s)} 的关系网，按亲疏从近到远：`]
          : [`${me?.name || userId}（QQ ${userId}）的关系网 · 最熟的前 ${ties.length} 个（共与 ${allTies.length} 人有互动）`];

        ties.forEach((t, i) => {
          const nm = nameOf(t.other);
          if (noNum) {
            lines.push(`${cnOrdinal(i)}. ${nm} —「${tieWords(t.w, s).title}」`);
          } else {
            const lv = tieLevelOf(t.w, s);
            lines.push(
              `${i + 1}. ${nm}（QQ ${t.other}）— 权重 ${t.w} ·「${lv.title}」` +
                `（@或引用 ${t.at}、接话 ${t.adj}、同时段 ${t.co}；最近互动 ${fmtDate(t.last)}）`
            );
          }
        });

        if (noNum) {
          lines.push('');
          lines.push('【重要】主人关闭了数字显示：不要说出任何权重或次数，只按顺序和档位自然描述谁跟谁熟。');
        }

        // 顺手把"这个人和机器人的关系"同步进长期记忆
        const mem = await syncMemberMemory(ctx, chatKey, userId, s);
        await flush();
        if (mem && mem.ok === false && !mem.skipped) {
          lines.push('');
          lines.push(`（系统提示，不用说给群友听：记忆同步未成功——${mem.reason || '未知原因'}）`);
        }

        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查询关系网失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'network',
    name: '全群关系网概览',
    description:
      '全群关系网：最紧密的几对＋社交中心。有人问「群里谁跟谁最熟」「谁是中心人物」时用。',
    category: 'query',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        topN: {
          type: 'number',
          description: '列出前几对关系和前几个中心人物，1~20。不填用插件设置里的默认值。'
        }
      }
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法生成关系网概览。', isError: true };

        await ensureLoaded();
        await accumulate({ chatKey, store: ctx?.store, triggerEntries: ctx?.session?.triggerEntries });
        syncOwners();

        const chat = db.chats[chatKey];
        const members = chat?.members || {};
        if (!Object.keys(chat?.ties || {}).length) {
          return { content: '这个群还没有统计到任何群友之间的互动，关系网是空的。等大家聊几句再来查。' };
        }

        const noNum = s.showNumbers === false;
        const n = clamp(Number(args?.topN) || Number(s.topN) || 10, 1, 20);
        const ov = networkOverview(chat, s, n);
        const nameOf = (uid) => displayName(members[uid]?.name, uid, s);
        const lines = [];

        if (noNum) {
          lines.push('这个群里最紧密的几对关系：');
          ov.pairs.forEach((t, i) => {
            lines.push(`${cnOrdinal(i)}. ${nameOf(t.a)} 和 ${nameOf(t.b)} —「${tieWords(t.w, s).title}」`);
          });
          lines.push('');
          lines.push('群里的社交中心（跟最多人熟络的）：');
          ov.hubs.forEach((h, i) => {
            lines.push(`${cnOrdinal(i)}. ${nameOf(h.uid)}`);
          });
          lines.push('');
          lines.push('【重要】主人关闭了数字显示：不要说出任何权重、次数或人数，只按顺序和档位自然描述。');
        } else {
          lines.push(`关系网概览 · 共统计到 ${ov.pairCount} 对有互动的关系、${ov.hubCount} 人参与`);
          lines.push('');
          lines.push(`最紧密的 ${ov.pairs.length} 对：`);
          ov.pairs.forEach((t, i) => {
            const lv = tieLevelOf(t.w, s);
            lines.push(`${i + 1}. ${nameOf(t.a)} ↔ ${nameOf(t.b)} — 权重 ${t.w} ·「${lv.title}」（@或引用 ${t.at}、接话 ${t.adj}、同时段 ${t.co}）`);
          });
          lines.push('');
          lines.push('社交中心（按关系总权重排）：');
          ov.hubs.forEach((h, i) => {
            lines.push(`${i + 1}. ${nameOf(h.uid)}（QQ ${h.uid}）— 与 ${h.links} 人有互动，总权重 ${h.weight}`);
          });
        }

        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `生成关系网概览失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'reset',
    name: '重置好感度',
    description:
      '把某人或整个会话的好感度清零，不可撤销。仅用户明确要求重置时用，必须 confirm=true；其他人需设置里开启。',
    category: 'system',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '要重置的人，QQ 号或群昵称。留空表示重置整个会话（所有人）。'
        },
        confirm: {
          type: 'boolean',
          description: '必须为 true 才执行。用于防止误清空整个会话。'
        }
      },
      required: ['confirm']
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法重置。', isError: true };

        await ensureLoaded();

        if (args?.confirm !== true) {
          return { content: '重置不可撤销。请先向用户确认，再带 confirm=true 调用一次。', isError: true };
        }

        // 权限：主人永远可以；其他人要看 allowReset 开关
        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        const byOwner = Boolean(req.userId) && ownerList(s).includes(String(req.userId));
        if (!byOwner && !s.allowReset) {
          return {
            content: '重置功能对普通群友是关闭的（设置里 allowReset=false），只有主人 QQ 号能重置。请礼貌拒绝，并说明可以让主人来操作。',
            isError: true
          };
        }

        const chat = db.chats[chatKey];
        if (!chat) return { content: '这个会话还没有好感度数据，不需要重置。' };

        const target = String(args?.target ?? '').trim();
        if (!target) {
          const n = Object.keys(chat.members || {}).length;
          chat.members = {};
          chat.seen = [];
          markDirty();
          await flush();
          syncOwners();
          markDirty();
          await flush();
          return { content: `已清空本会话全部好感度记录（共 ${n} 人）。此操作不可撤销。主人的满级记录会在 TA 下次发言时重新建立。` };
        }

        const hit = findMember(chat.members || {}, target);
        if (!hit) return { content: `没有找到「${target}」的好感度记录，无需重置。` };
        const name = hit.rec.name || hit.userId;
        delete chat.members[hit.userId];
        markDirty();
        await flush();
        return { content: `已清空 ${name}（QQ ${hit.userId}）的好感度记录。此操作不可撤销。` };
      } catch (error) {
        return { content: `重置好感度失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  api.registerTool({
    id: 'tip',
    name: '打赏记账',
    description:
      '主人记账：某群友给机器人打赏/送礼后，主人报出「谁、多少钱」，按金额档位给该群友加好感度。只有口令授权的主人能用；普通群友要求记账要拒绝。',
    category: 'system',
    icon: '🎁',
    parameters: {
      type: 'object',
      properties: {
        target: {
          type: 'string',
          description: '被打赏的人，QQ 号或群昵称。'
        },
        amount: {
          type: 'number',
          description: '打赏金额（元），正数。按设置里的档位换算成好感分。'
        }
      },
      required: ['target', 'amount']
    },
    async execute(ctx, args) {
      try {
        const s = currentSettings();
        const chatKey = chatKeyOf(ctx);
        if (!chatKey) return { content: '拿不到当前会话标识，无法记账。', isError: true };

        await ensureLoaded();

        const selfId = String(ctx?.selfId || s.botQq || db.meta?.selfId || '');
        const req = await resolveRequester(ctx, chatKey, selfId, s);
        const byOwner = Boolean(req.userId) && tipOwnerList(s).includes(String(req.userId));
        if (!byOwner) {
          return {
            content: '打赏记账只有主人能操作。请礼貌拒绝，并说明可以让主人来报。',
            isError: true
          };
        }

        const amount = Number(args?.amount);
        if (!Number.isFinite(amount) || amount <= 0) {
          return { content: '打赏金额必须是正数（元），请让主人报清楚多少钱。', isError: true };
        }

        const chat = db.chats[chatKey] || (db.chats[chatKey] = { members: {}, seen: [] });
        const members = chat.members || (chat.members = {});
        const target = String(args?.target ?? '').trim();
        const hit = findMember(members, target);

        const now = Date.now();
        let userId;
        let rec;
        if (hit) {
          userId = hit.userId;
          rec = hit.rec;
        } else {
          userId = target.replace(/[^\d]/g, '');
          if (!userId) {
            return {
              content: `名单里没找到「${target}」，也无法从称呼里识别 QQ 号。请让主人报 QQ 号，或先让 TA 在群里说句话。`,
              isError: true
            };
          }
          rec = newRecord(now);
          rec.name = target;
          members[userId] = rec;
        }

        if (isOwner(userId, s)) {
          return { content: '主人是满级，打赏不再额外加分。' };
        }

        const before = Number(rec.score) || 0;
        rollDay(rec, now);
        const want = tipScoreOf(amount, s);
        const cap = Math.max(1, Math.round(Number(s.tipDailyCap) || 30));
        const room = Math.max(0, cap - (Number(rec.dayTip) || 0));
        const applied = Math.min(want, room);

        if (!(applied > 0)) {
          return { content: `${rec.name || userId} 今天的打赏额度已用完（上限 ${cap} 分），本次不再加分。` };
        }

        const floor = scoreFloorOf(s);
        rec.score = Math.max(floor, before + applied);
        rec.dayTip = (Number(rec.dayTip) || 0) + applied;
        rec.tipCount = (Number(rec.tipCount) || 0) + 1;
        rec.tipAmount = Math.round(((Number(rec.tipAmount) || 0) + amount) * 100) / 100;
        rec.lastSeen = now;
        noteLevelChange(rec, s, before, now, userId);

        markDirty();
        await flush();

        const lv = levelOf(rec.score, s);
        return {
          content: `已记打赏：${rec.name || userId} 收到 ${amount} 元，按档位 +${applied} 分（本档 ${want} 分），当前 ${rec.score} 分 · Lv.${lv.level}「${lv.title}」。累计打赏 ${rec.tipCount} 次 / ${rec.tipAmount} 元。`
        };
      } catch (error) {
        return { content: `打赏记账失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  log('群友好感度已加载');
}

/** 可用性自检：必须同步返回，绝不返回 Promise */
export function available() {
  return true;
}

export async function activate(ctx) {
  activeCtx = ctx || null;
  await ensureLoaded();
  syncOwners();
  // ⚠️ 必须在导出覆盖之前先检查名单表格有没有被手动改过，
  // 否则重启/热重载时用户在 Excel 里改的分数会被我们的导出冲掉。
  lastCsvCheckAt = 0;
  await maybeImportCsv(currentSettings());
  markDirty();
  await flush();
  if (flushTimer) clearInterval(flushTimer);
  // 定时把"升级播报"发到群里。钩子里禁止发消息，所以只能在这里补。
  // 如果运行时没给 sender，这个定时器就是空转，不影响其他功能。
  flushTimer = setInterval(() => {
    flushPendingAnnouncements().catch(() => {});
  }, 120000);
  if (typeof flushTimer?.unref === 'function') flushTimer.unref();
  log(`群友好感度已启用（主人：${ownerList(currentSettings()).join('、') || '未设置'}）`);
}

export async function deactivate() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  activeCtx = null;
  await flush();
}

export function dispose() {
  if (flushTimer) {
    clearInterval(flushTimer);
    flushTimer = null;
  }
  activeCtx = null;
  db = null;
  loaded = false;
  dirty = false;
  lastCsvCheckAt = 0; // 热重载后应重新检查一次名单表格有没有被手动改过
  dbFile = '';
}

// ───────────────────────────── 钩子 ─────────────────────────────

export const hooks = {
  /**
   * 组装提示词之前触发。这里做确定性的"记账"：
   * 补扫最近的聊天记录，给发过言的人加分。
   * 注意：不发消息、不发网络请求、不重试（plugin-development.md §3.2 硬约束）。
   */
  'before-context': async (payload) => {
    try {
      const r = await accumulate(payload || {});
      if (r.counted > 0) log(`好感度记账：${r.chatKey} 新增 ${r.counted} 条发言`);
    } catch (error) {
      warn(`好感度记账失败：${error?.message ?? error}`);
    }
    // 不返回任何值（返回 undefined 才不会被收集）
  },

  /**
   * 拿到模型响应之后触发。这里做两件事：
   *   1) 把回复末尾的情绪标记 [aff:xxx] **就地删掉**，不让它出现在群里
   *   2) 按档位给"最后说话的那个人"加/减好感度
   * 同样遵守钩子硬约束：不发消息、不发网络请求、不重试（只改传入对象 + 本地落盘）。
   */
  'after-response': async (payload) => {
    try {
      const r = await handleSentiment(payload || {});
      if (r && r.applied !== 0) {
        log(`情绪「${r.mood}」→ ${r.who} ${r.applied > 0 ? '+' : ''}${r.applied} 分（现 ${r.score}）`);
      } else if (r && r.reason) {
        log(`情绪「${r.mood}」未生效：${r.reason}`);
      }
    } catch (error) {
      warn(`情绪标记处理失败：${error?.message ?? error}`);
    }
    // 不返回任何值
  }
};

// ───────────────────────────── 核心逻辑 ─────────────────────────────

/**
 * 补扫 + 记分。钩子和工具都走这一个入口。
 * @returns {Promise<{chatKey:string, counted:number}>}
 */
async function accumulate(payload = {}) {
  await ensureLoaded();
  const s = currentSettings();
  await maybeImportCsv(s);
  const chatKey = String(
    payload.chatKey || (payload.kind && payload.chatId ? `${payload.kind}:${payload.chatId}` : '') || ''
  );
  if (!chatKey) return { chatKey: '', counted: 0 };

  const chat = getChat(chatKey);
  let selfId = String(s.botQq || '').trim() || String(db.meta?.selfId || '');

  const raws = [];

  // 1) 聊天记录（store 里存着全部入群消息，包括没触发机器人的那些）
  const store = payload.store;
  if (store && typeof store.recent === 'function') {
    const limit = clamp(Number(s.scanLimit) || 200, 20, 1000);
    try {
      const got = await store.recent(chatKey, { limit });
      raws.push(...unwrapList(got));
    } catch (error) {
      warn(`读取聊天记录失败（不影响本次对话）：${error?.message ?? error}`);
    }
  }

  // 2) 本轮触发消息（可能 store 还没落盘）
  raws.push(...unwrapList(payload.triggerEntries));

  const seen = new Set(Array.isArray(chat.seen) ? chat.seen : []);
  const ents = [];
  for (const raw of raws) {
    const ent = normalizeEntry(raw, selfId);
    if (!ent) continue;
    // 顺手学习"机器人自己的 QQ 号"，用于识别谁 @ 了机器人
    if (ent.isSelf && ent.userId && !selfId) {
      selfId = ent.userId;
      db.meta.selfId = ent.userId;
    }
    ents.push(ent);
  }

  ents.sort((a, b) => (a.ts || 0) - (b.ts || 0));

  // 消息 id → 发言人：用来把"引用回复了某条消息"解析成"回复了谁"
  const midToUser = new Map();
  for (const ent of ents) {
    if (ent.mid && ent.userId) midToUser.set(String(ent.mid), ent.userId);
  }

  const now = Date.now();
  let counted = 0;
  let prevWasSelf = false;
  const fresh = [];

  for (const ent of ents) {
    const key = ent.mid ? `m:${ent.mid}` : `k:${ent.userId}:${ent.ts}:${(ent.text || '').slice(0, 16)}`;
    const already = seen.has(key);
    if (!already) seen.add(key);

    if (ent.isSelf) {
      prevWasSelf = true;
      continue;
    }
    if (!ent.userId || already) {
      prevWasSelf = false;
      continue;
    }
    // 首次安装时不要把整个群历史灌进来：只记最近 24 小时内的消息
    if (ent.ts && now - ent.ts > DAY) {
      prevWasSelf = false;
      continue;
    }

    const atBot = selfId ? ent.ats.includes(String(selfId)) : false;
    const replyToBot = Boolean(ent.hasReply) && prevWasSelf;
    touchMember(chat, ent, ent.ts || now, s, { atBot, replyToBot });
    counted += 1;
    fresh.push(ent);
    prevWasSelf = false;
  }

  // 群友 ↔ 群友 关系网：只用本轮新计入的消息，避免重复累加
  const tieGain = buildTies(chat, fresh, midToUser, selfId, s, now);

  // 记住"最后说话的人"：after-response 钩子拿不到 store，只能靠这里留下的线索
  // 定位情绪标记该算在谁头上。取本轮扫到的最后一条非机器人消息。
  for (let i = ents.length - 1; i >= 0; i -= 1) {
    const e = ents[i];
    if (e && !e.isSelf && e.userId) {
      chat.lastSpeaker = { userId: e.userId, name: e.name || '', at: e.ts || now };
      break;
    }
  }

  chat.seen = [...seen].slice(-SEEN_KEEP);
  chat.lastScanAt = now;
  syncOwners();

  if (counted > 0 || tieGain > 0 || db.meta?.selfId) {
    markDirty();
    await flush();
  }
  return { chatKey, counted, tieGain };
}

/** 给一条消息记账 */
function touchMember(chat, ent, now, s, { atBot = false, replyToBot = false } = {}) {
  const rec = chat.members[ent.userId] || (chat.members[ent.userId] = newRecord(now));
  if (!rec.firstSeen) rec.firstSeen = now;
  if (ent.name) rec.name = ent.name;
  rec.msgs = (Number(rec.msgs) || 0) + 1;
  rec.lastSeen = now;

  // 主人：分数恒定满级，不加分、不衰减、不播报
  if (isOwner(ent.userId, s)) {
    pinOwner(rec, s);
    return 0;
  }

  applyDecay(rec, now, s);
  rollDay(rec, now);

  // 自动加分可以整个关掉（关掉后好感度只由模型用 favor / dock 主动调整）
  if (s.autoGain === false) {
    rec.level = levelOf(rec.score, s).level;
    return 0;
  }

  let gain;
  if (s.randomGain !== false) {
    // 随机基础分：闭区间 [gainMin, gainMax]，让每条消息的涨幅不可预测
    const lo = Math.max(0, Math.round(Number(s.gainMin) || 0));
    const hi = Math.max(lo, Math.round(Number(s.gainMax) || 0));
    gain = lo + Math.floor(Math.random() * (hi - lo + 1));
  } else {
    gain = Number(s.perMessage) || 0;
  }
  if (atBot) gain += Number(s.atBotBonus) || 0;
  if (replyToBot) gain += Number(s.replyBonus) || 0;
  gain = Math.max(0, Math.round(gain));

  const room = Math.max(0, (Number(s.dailyCap) || 0) - (Number(rec.dayGain) || 0));
  const applied = Math.min(gain, room);

  const before = Number(rec.score) || 0;
  rec.score = Math.max(scoreFloorOf(s), before + applied);
  rec.dayGain = (Number(rec.dayGain) || 0) + applied;
  noteLevelChange(rec, s, before, now, ent.userId);
  return applied;
}

/** 抗性表：5 个 0~100 的百分比，对应 Lv.1~Lv.5。格式不对静默回退默认。 */
export function resistTableOf(s) {
  const raw = String(s?.resistTable ?? '').trim();
  if (!raw) return DEFAULT_RESIST.slice();
  const parts = raw.split(/[,，\s]+/).map((x) => Number(String(x).trim()));
  const ok = parts.length === 5 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 100);
  return ok ? parts.map((n) => Math.round(n)) : DEFAULT_RESIST.slice();
}

/**
 * 当前分数对应的"掉落抗性"系数（0~1）。等级越高系数越小 = 越难掉。
 * 默认 100/80/60/40/20，即挚友只承受两成的衰减和扣分。
 */
export function resistFactor(score, s) {
  const table = resistTableOf(s);
  const lv = levelOf(score, s).level;
  const pct = table[Math.min(table.length, Math.max(1, lv)) - 1];
  const n = Number(pct);
  return Math.min(1, Math.max(0, (Number.isFinite(n) ? n : 100) / 100));
}

/**
 * 按"多少天没发言"惰性调整分数，用 decayAnchor 保证同一段时间不会被重复计算。
 *  - 正分：往下衰减，**受等级抗性打折**，最低到 0（衰减不会把人扣成负分）
 *  - 负分：若开启 negativeRecover 则往上回升，最高回到 0（回升不打折——缓和关系不该被抗性拖慢）
 *  - 主人（pinned）不参与
 * 抗性打折后每天可能不足 1 分，用 decayAcc 累积小数，攒够 1 分才真正扣。
 * @returns {number} 本次变化量（正数=回升，负数=衰减，0=没变）
 */
export function applyDecay(rec, now, s) {
  if (!rec || typeof rec !== 'object') return 0;
  if (rec.pinned === true) return 0; // 主人恒定满级

  let delta = 0;
  const perDay = Number(s?.decayPerDay) || 0;
  if (perDay > 0) {
    const afterDays = Math.max(0, Number(s?.decayAfterDays) || 0);
    const anchor = Math.max(Number(rec.lastSeen) || 0, Number(rec.decayAnchor) || 0);
    if (anchor) {
      const days = Math.floor((now - anchor) / DAY);
      const over = days - afterDays;
      rec.decayAnchor = now;
      if (over > 0) {
        const cur = Number(rec.score) || 0;
        if (cur > 0) {
          const factor = resistFactor(cur, s);
          const raw = over * perDay * factor;
          const acc = (Number(rec.decayAcc) || 0) + raw;
          const loss = Math.min(cur, Math.floor(acc)); // 衰减最低到 0
          rec.decayAcc = acc - Math.floor(acc);
          if (loss > 0) {
            rec.score = cur - loss;
            rec.decayed = (Number(rec.decayed) || 0) + loss;
            rec.resisted = (Number(rec.resisted) || 0) + Math.round(raw - loss);
            delta = -loss;
          }
        } else if (cur < 0 && s?.negativeRecover !== false) {
          const back = Math.min(-cur, over * perDay); // 回升最高到 0，不打折
          if (back > 0) {
            rec.score = cur + back;
            rec.recovered = (Number(rec.recovered) || 0) + back;
            delta = back;
          }
        }
        // 兜底：不让任何历史脏数据穿透下限
        rec.score = Math.max(scoreFloorOf(s), Number(rec.score) || 0);
      }
    }
  }

  // 无论有没有变化，都把 level 校正到"当前分数 + 当前门槛"
  // （门槛或抗性表可能被主人在聊天里改过，存的旧 level 会失效）
  rec.level = levelOf(rec.score, s).level;
  return delta;
}

// ───────────────────────────── 主人 ─────────────────────────────

/** 主人 QQ 号列表（支持逗号分隔多个） */
export function ownerList(s) {
  const raw = String(s?.ownerQq ?? '');
  return raw
    .split(/[,，\s]+/)
    .map((x) => x.replace(/[^\d]/g, ''))
    .filter(Boolean);
}

function isOwner(userId, s) {
  const uid = String(userId ?? '').trim();
  if (!uid) return false;
  return ownerList(s).includes(uid);
}

/** 打赏口令授权名单：tipOwners 优先，留空回退主人名单（独立于 ownerQq 的满级钉人） */
export function tipOwnerList(s) {
  const raw = String(s?.tipOwners ?? '').trim();
  if (raw) {
    return raw.split(/[,，\s]+/).map((x) => x.replace(/[^\d]/g, '')).filter(Boolean);
  }
  return ownerList(s);
}

/** 解析打赏档位配置："0:6,10:12,50:25" → [{min,score}]，按金额下限升序；格式错回退默认 */
export function tipTiersOf(s) {
  const def = DEFAULT_TIP_TIERS.slice();
  const raw = String(s?.tipTiers ?? '').trim();
  if (!raw) return def;
  const parts = raw.split(/[,，\s]+/).filter(Boolean);
  const tiers = [];
  for (const p of parts) {
    const m = String(p).match(/^(\d+(?:\.\d+)?)\s*[:：]\s*(\d+)$/);
    if (!m) return def;
    tiers.push({ min: Number(m[1]), score: Math.max(0, Math.round(Number(m[2]))) });
  }
  tiers.sort((a, b) => a.min - b.min);
  return tiers.length ? tiers : def;
}

/** 按打赏金额（元）落档返回好感分；金额非法返回 0 */
export function tipScoreOf(amount, s) {
  const tiers = tipTiersOf(s);
  const amt = Number(amount);
  if (!Number.isFinite(amt) || amt <= 0) return 0;
  let score = tiers[0].score;
  for (const t of tiers) {
    if (amt >= t.min) score = t.score;
  }
  return score;
}

/** 把一条记录钉成满级 */
function pinOwner(rec, s) {
  const max = Math.max(0, Math.round(Number(s?.ownerScore) || 0));
  rec.pinned = true;
  rec.score = max;
  rec.level = levelOf(max, s).level;
  rec.dayGain = 0;
  if (Array.isArray(rec.pending)) rec.pending = [];
}

/** 遍历所有会话，把主人的记录钉成满级、把不再是主人的记录解除钉住 */
function syncOwners() {
  if (!db) return;
  const s = currentSettings();
  const owners = ownerList(s);
  const max = Math.max(0, Math.round(Number(s.ownerScore) || 0));
  const maxLevel = levelOf(max, s).level;
  for (const chat of Object.values(db.chats || {})) {
    for (const [uid, rec] of Object.entries(chat?.members || {})) {
      if (owners.includes(String(uid))) {
        rec.pinned = true;
        rec.score = max;
        rec.level = maxLevel;
        rec.dayGain = 0;
        if (Array.isArray(rec.pending)) rec.pending = [];
      } else if (rec.pinned === true) {
        rec.pinned = false; // 被移出主人名单，分数保持当前值，恢复普通规则
      }
    }
  }
}

/** 主人从没发过言时的查询结果 */
function ownerReport(userId, name, s, isSelfQuery) {
  const max = Math.max(0, Math.round(Number(s.ownerScore) || 0));
  const lv = levelOf(max, s);
  if (s.showNumbers === false) {
    return [
      `对象：${displayName(name, userId, s)}${isSelfQuery ? '（正在提问的这个人）' : ''}`,
      `关系：${lv.title} · 身份：主人`,
      '状态：满级，最铁的那一档，怎么对待都不为过。',
      '进度：已经是最高档，没有更高的了。',
      '备注：TA 在这个会话里还没有发言记录。',
      '',
      '【重要】主人关闭了数字显示，回答里不要出现任何具体数字。'
    ].join('\n');
  }
  return [
    `对象：${name || userId}（QQ ${userId}）${isSelfQuery ? '，也就是正在提问的这个人' : ''}`,
    `好感度：${max} 分（满级，主人固定值，不参与加分、扣分和衰减）`,
    `等级：Lv.${lv.level}「${lv.title}」 · 身份：主人`,
    '升级进度：已经是最高等级，无需再攒',
    '备注：TA 在这个会话里还没有发言记录，所以没有发言数和认识时间可显示。'
  ].join('\n');
}

// ───────────────────────────── 扣好感 ─────────────────────────────

/** 按好感等级取护盾上限：「0,1,1,2,2」对应 Lv.1~Lv.5 */
export function shieldMaxOf(score, s) {
  const fallback = [0, 1, 1, 2, 2];
  const raw = String(s?.shieldTable ?? '').trim();
  const parts = raw ? raw.split(/[,，\s]+/).map((x) => Number(String(x).trim())) : [];
  const table = parts.length === 5 && parts.every((n) => Number.isFinite(n) && n >= 0 && n <= 50)
    ? parts.map((n) => Math.round(n))
    : fallback.slice();
  const lv = levelOf(Number(score) || 0, s).level;
  const idx = Math.min(5, Math.max(1, lv)) - 1;
  return Math.max(0, table[idx]);
}

/** 护盾抵扣：有格就挡下并消耗一格，每格按 shieldRefillMin 分钟恢复 */
function takeShield(rec, score, s, now) {
  const max = shieldMaxOf(score, s);
  if (max <= 0) {
    rec.shield = 0;
    return { blocked: false, left: 0 };
  }
  const refillMs = Math.max(1, Math.round(Number(s.shieldRefillMin ?? 20) || 20)) * 60000;
  let left = Number.isFinite(Number(rec.shield)) ? Math.max(0, Math.round(Number(rec.shield))) : max;
  const at = Number(rec.shieldAt) || 0;
  if (at && now > at) {
    const gained = Math.floor((now - at) / refillMs);
    if (gained > 0) {
      left = Math.min(max, left + gained);
      rec.shieldAt = at + gained * refillMs;
    }
  }
  if (!at) rec.shieldAt = now;
  if (left <= 0) {
    rec.shield = 0;
    return { blocked: false, left: 0 };
  }
  rec.shield = left - 1;
  rec.shieldAt = now; // 下一格从消耗这一刻重新计时
  return { blocked: true, left: left - 1 };
}

/** 好感度下限（默认 -100，永远是 0 或负数） */
function scoreFloorOf(s) {
  const n = Number(s?.scoreFloor);
  if (!Number.isFinite(n)) return -100;
  return Math.min(0, Math.round(n));
}

/** 跨天时把当日计数器归零 */
function rollDay(rec, now) {
  const dayKey = dayString(now);
  if (rec.dayKey !== dayKey) {
    rec.dayKey = dayKey;
    rec.dayGain = 0;
    rec.daySentiment = 0;
    rec.dayTip = 0;
  }
}

/** 分数变化后校正等级；升级则记一条待播报 */
function noteLevelChange(rec, s, beforeScore, now, userId) {
  const before = levelOf(beforeScore, s).level;
  const lv = levelOf(rec.score, s);
  rec.level = lv.level;
  if (lv.level > before && rec.pinned !== true && s.announceLevelUp !== false) {
    if (!Array.isArray(rec.pending)) rec.pending = [];
    rec.pending.push({ name: rec.name || userId || '', title: lv.title, level: lv.level, at: now });
    if (rec.pending.length > PENDING_KEEP) rec.pending = rec.pending.slice(-PENDING_KEEP);
  }
  return lv;
}

/** 解析情绪分值配置："8,3,0,-3,-8" → [8,3,0,-3,-8]，格式不对回退默认 */
export function sentimentGainsOf(s) {
  const raw = String(s?.sentimentGains ?? '').trim();
  if (!raw) return DEFAULT_SENTIMENT_GAINS.slice();
  const parts = raw.split(/[,，\s]+/).map((x) => Number(String(x).trim()));
  const ok = parts.length === SENTIMENT_LEVELS.length && parts.every((n) => Number.isFinite(n) && Math.abs(n) <= 1000);
  return ok ? parts.map((n) => Math.round(n)) : DEFAULT_SENTIMENT_GAINS.slice();
}

/** 情绪档位 → 分值。未知档位返回 null。 */
export function sentimentDelta(mood, s) {
  const idx = SENTIMENT_LEVELS.indexOf(String(mood ?? '').trim());
  if (idx < 0) return null;
  return Math.round(Number(sentimentGainsOf(s)[idx]) || 0);
}

/**
 * 按机器人的情绪档位调整好感度（取代旧的 favor / dock 两个工具）。
 *  - 负面档位受等级抗性打折：关系越深越不容易掉
 *  - 正负面共用"每人每天情绪额度"，并受总下限约束
 *  - 主人（pinned）不参与
 */
export function applySentiment(rec, s, { mood, now }) {
  const score0 = Number(rec?.score) || 0;
  const base = { applied: 0, want: 0, mood: String(mood || ''), score: score0, reason: '' };
  if (!rec || rec.pinned === true) return { ...base, reason: '主人免疫' };

  const want0 = sentimentDelta(mood, s);
  if (want0 === null) return { ...base, reason: `未知情绪档位「${mood}」` };
  if (want0 === 0) return { ...base, reason: '平淡，不加不扣' };
  if (want0 < 0 && s.allowNegative === false) return { ...base, want: want0, reason: '负面情绪扣分已关闭' };

  // 护盾：好感等级越高，能挡下的难听话越多；每格按固定时间恢复
  if (want0 < 0) {
    const shield = takeShield(rec, score0, s, now);
    if (shield.blocked) {
      return { ...base, want: want0, reason: `护盾挡下这一下（还剩 ${shield.left} 格）` };
    }
  }

  rollDay(rec, now);
  const floor = scoreFloorOf(s);
  const cap = Math.max(1, Math.round(Number(s.dailySentimentCap) || 30));
  const dayRoom = Math.max(0, cap - (Number(rec.daySentiment) || 0));

  const want = want0; // 负面不再按抗性打折，改由护盾抵扣

  const roomDown = Math.max(0, score0 - floor);
  const magnitude = Math.min(Math.abs(want), dayRoom, want < 0 ? roomDown : Infinity);
  if (!(magnitude > 0)) {
    return { ...base, want, reason: dayRoom <= 0 ? '今天的情绪额度已用完' : '已到分数下限' };
  }
  const applied = want < 0 ? -magnitude : magnitude;

  rec.score = Math.max(floor, score0 + applied);
  rec.daySentiment = (Number(rec.daySentiment) || 0) + Math.abs(applied);
  if (applied < 0) rec.lastNegAt = now; // 留个时间戳，方便排查
  noteLevelChange(rec, s, score0, now, rec.name);
  if (!Array.isArray(rec.moodLog)) rec.moodLog = [];
  rec.moodLog.push({ at: now, delta: applied, mood: String(mood) });
  if (rec.moodLog.length > MOOD_LOG_KEEP) rec.moodLog = rec.moodLog.slice(-MOOD_LOG_KEEP);
  return { applied, want, mood: String(mood), score: rec.score, reason: '' };
}

/**
 * 从模型响应里找出情绪标记并**就地删掉**它。
 * 返回 { mood, found, stripped, unwritable }：
 *  - stripped=false 且 found=true 表示"找到了标记但没能删掉"，标记可能会泄漏到群里，必须告警
 */
export function stripSentiment(response) {
  let mood = '';
  let moodTarget = null; // 标记所在的可写节点，用于在正文末尾补一句好感度提示
  const cleanStr = (str) => {
    if (typeof str !== 'string' || !str) return str;
    if (!mood) {
      SENTIMENT_RE.lastIndex = 0;
      const m = SENTIMENT_RE.exec(str);
      if (m) mood = m[1];
    }
    let out = str.replace(SENTIMENT_RE, '').replace(SENTIMENT_MALFORMED_RE, '');
    // 只清尾部多余空白，避免改动正文排版
    return out.replace(/[\s\u3000]+$/, '');
  };

  if (typeof response === 'string') {
    SENTIMENT_RE.lastIndex = 0;
    const m = SENTIMENT_RE.exec(response);
    return { mood: m ? m[1] : '', found: Boolean(m), stripped: false, unwritable: Boolean(m) };
  }
  if (!response || typeof response !== 'object') return { mood: '', found: false, stripped: false, unwritable: false };

  let found = false;
  const visit = (node, depth) => {
    if (!node || depth > 4) return;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i += 1) {
        const item = node[i];
        if (typeof item === 'string') {
          if (SENTIMENT_PROBE.test(item)) {
            found = true;
            node[i] = cleanStr(item);
            moodTarget = { parent: node, key: i };
          }
        } else if (item && typeof item === 'object') {
          visit(item, depth + 1);
        }
      }
      return;
    }
    if (typeof node !== 'object') return;
    for (const k of Object.keys(node)) {
      let v;
      try {
        v = node[k];
      } catch {
        continue; // 有些字段是 getter，读它会抛错
      }
      if (typeof v === 'string') {
        if (SENTIMENT_PROBE.test(v)) {
          found = true;
          try {
            node[k] = cleanStr(v);
            moodTarget = { parent: node, key: k };
          } catch {
            // 只读属性：删不掉，标记可能泄漏
          }
        }
      } else if (v && typeof v === 'object') {
        visit(v, depth + 1);
      }
    }
  };

  visit(response, 0);
  const stillThere = (() => {
    let leak = false;
    const probe = (node, depth) => {
      if (!node || depth > 4 || leak) return;
      if (Array.isArray(node)) {
        for (const it of node) {
          if (typeof it === 'string') { if (SENTIMENT_PROBE.test(it)) leak = true; }
          else if (it && typeof it === 'object') probe(it, depth + 1);
        }
        return;
      }
      if (typeof node !== 'object') return;
      for (const k of Object.keys(node)) {
        let v;
        try { v = node[k]; } catch { continue; }
        if (typeof v === 'string') { if (SENTIMENT_PROBE.test(v)) leak = true; }
        else if (v && typeof v === 'object') probe(v, depth + 1);
      }
    };
    probe(response, 0);
    return leak;
  })();

  return { mood, found, stripped: found && !stillThere, unwritable: found && stillThere, target: moodTarget };
}

/** 好感度真的动了，就在标记所在的那段正文末尾补一句人设化提示（不带数字，按冷却节流） */
function appendDeltaHint(res, r, rec, s, now) {
  if (s.deltaHint === false) return;
  if (!res || !res.target) return;
  const cdMin = Math.max(0, Math.round(Number(s.hintCooldownMin ?? 15) || 0));
  const side = r.applied > 0 ? 'up' : 'down';
  if (!rec.hintAt || typeof rec.hintAt !== 'object') rec.hintAt = {};
  const last = Number(rec.hintAt[side]) || 0;
  if (cdMin > 0 && last && now - last < cdMin * 60000) return;

  const mood = String(r.mood || '');
  const hint = r.applied > 0
    ? (mood === '特别喜欢' ? '（……哼，勉强算你懂事）' : '（哼，还行吧）')
    : (mood === '特别讨厌' ? '（别再来烦我）' : '（这话我记着了）');

  const t = res.target;
  const cur = t.parent ? t.parent[t.key] : undefined;
  if (typeof cur !== 'string') return;
  try {
    t.parent[t.key] = cur.replace(/[\s\u3000]+$/, '') + ' ' + hint;
    rec.hintAt[side] = now;
  } catch {
    // 只读节点，这次就不提示了
  }
}

/** after-response 钩子的主体：解析情绪标记 → 落地到"最后说话的那个人" */
async function handleSentiment(payload = {}) {
  const res = stripSentiment(payload?.response);
  if (res.unwritable) {
    warn('情绪标记没能从响应里删掉，可能会显示到群里（response 是只读或字符串形态）');
  }
  if (!res.mood) return null;

  const s = currentSettings();
  const chatKey = String(
    payload.chatKey || (payload.kind && payload.chatId ? `${payload.kind}:${payload.chatId}` : '') || ''
  );
  if (!chatKey) return { mood: res.mood, applied: 0, reason: '拿不到会话标识', stripped: res.stripped };

  await ensureLoaded();
  const chat = getChat(chatKey);
  const sp = chat.lastSpeaker;
  if (!sp || !sp.userId) {
    return { mood: res.mood, applied: 0, reason: '不知道这句话是谁说的（本轮没扫到发言人）', stripped: res.stripped };
  }
  if (isOwner(sp.userId, s)) {
    return { mood: res.mood, applied: 0, who: sp.name || sp.userId, reason: '主人免疫', stripped: res.stripped };
  }
  const rec = chat.members[sp.userId];
  if (!rec) {
    return { mood: res.mood, applied: 0, who: sp.name || sp.userId, reason: '这个人还没有好感度记录', stripped: res.stripped };
  }

  const now = Date.now();
  const r = applySentiment(rec, s, { mood: res.mood, now });
  if (r.applied !== 0) {
    appendDeltaHint(res, r, rec, s, now);
    markDirty();
    await flush();
  }
  return { ...r, who: rec.name || sp.userId, stripped: res.stripped };
}

/** 关掉「报出具体数字」时用的定性描述。绝不包含任何数值。 */
export function describeLevel(score, s) {
  const v = Number(score) || 0;
  const lv = levelOf(v, s);
  if (v < 0) {
    return {
      title: lv.title,
      short: '冰点',
      text: 'TA 把你惹毛过，现在关系在冰点上。你可以冷淡一点，不想搭理就不用搭理，但别主动去骂人。'
    };
  }
  const table = {
    1: '基本没什么交集，就是个还没混熟的群友，说话保持基本礼貌就行。',
    2: '有点面熟了，能叫上名字，但还谈不上多亲近。',
    3: '已经熟了，可以随便开玩笑、互相调侃。',
    4: '老朋友了，说话不用客气，可以带点私人化的默契和关心。',
    5: '挚友，关系最铁的那一档，可以完全放开、当自己人对待。'
  };
  return { title: lv.title, short: lv.title, text: table[lv.level] || table[1] };
}

/** 关掉数字时，进度也用定性说法 */
function progressWords(score, s) {
  const v = Number(score) || 0;
  if (v < 0) return '关系还没缓过来，得靠 TA 好好表现一阵子。';
  const next = levelTable(s).filter((L) => L.min > v).sort((a, b) => a.min - b.min)[0];
  if (!next) return '已经到顶了，没有更高的了。';
  const gap = next.min - v;
  const span = next.min;
  if (span > 0 && gap / span > 0.7) return `离「${next.title}」还差得远，得慢慢处。`;
  return `再处处就到「${next.title}」了，就差临门一脚。`;
}

// ───────────────────────────── 关系网（群友 ↔ 群友）─────────────────────────────

function tieKeyOf(a, b) {
  const x = String(a);
  const y = String(b);
  return x < y ? `${x}|${y}` : `${y}|${x}`;
}

function getTie(chat, a, b) {
  if (!chat.ties || typeof chat.ties !== 'object') chat.ties = {};
  const k = tieKeyOf(a, b);
  const [lo, hi] = k.split('|');
  return chat.ties[k] || (chat.ties[k] = { a: lo, b: hi, w: 0, at: 0, adj: 0, co: 0, dayCo: 0, dayKey: '', last: 0 });
}

/**
 * 从本轮新计入的消息里提取群友之间的关系信号。三种信号：
 *   1) @ 或引用回复 —— 强信号，+3
 *   2) 紧邻接话（相邻两条、5 分钟内、不是同一人）—— 弱信号，+1
 *   3) 同一个 10 分钟窗口里都活跃 —— 弱信号，+1，每对每天最多 3 次
 * 只有双方都已经在 members 里记过账才会建立关系，机器人自己不进群友关系网。
 * @returns {number} 本轮累计增加的关系权重
 */
export function buildTies(chat, fresh, midToUser, selfId, s, now) {
  if (!Array.isArray(fresh) || !fresh.length) return 0;
  const members = chat.members || {};
  const dayKey = dayString(now);
  let added = 0;

  const bump = (u1, u2, field, amount) => {
    const a = String(u1 || '');
    const b = String(u2 || '');
    if (!a || !b || a === b) return;
    if (selfId && (a === String(selfId) || b === String(selfId))) return;
    if (!members[a] || !members[b]) return;
    const t = getTie(chat, a, b);
    if (t.dayKey !== dayKey) {
      t.dayKey = dayKey;
      t.dayCo = 0;
    }
    if (field === 'co' && (Number(t.dayCo) || 0) >= TIE_CO_DAILY_CAP) return;
    t[field] = (Number(t[field]) || 0) + 1;
    t.w = (Number(t.w) || 0) + amount;
    t.last = now;
    if (field === 'co') t.dayCo = (Number(t.dayCo) || 0) + 1;
    added += amount;
  };

  // 1) @ 与引用回复
  for (const ent of fresh) {
    for (const at of ent.ats || []) bump(ent.userId, at, 'at', TIE_AT_WEIGHT);
    if (ent.replyMid) {
      const target = midToUser && typeof midToUser.get === 'function' ? midToUser.get(String(ent.replyMid)) : '';
      if (target) bump(ent.userId, target, 'at', TIE_AT_WEIGHT);
    }
  }

  // 2) 紧邻接话
  for (let i = 1; i < fresh.length; i += 1) {
    const prev = fresh[i - 1];
    const cur = fresh[i];
    if (!prev?.userId || !cur?.userId || prev.userId === cur.userId) continue;
    if (cur.ts && prev.ts && cur.ts - prev.ts <= TIE_ADJ_MS) {
      bump(prev.userId, cur.userId, 'adj', TIE_ADJ_WEIGHT);
    }
  }

  // 3) 同一个时间窗里都活跃（人数太多就跳过，避免两两配对组合爆炸）
  const buckets = new Map();
  for (const ent of fresh) {
    if (!ent.ts || !ent.userId) continue;
    const k = Math.floor(ent.ts / TIE_WINDOW_MS);
    if (!buckets.has(k)) buckets.set(k, new Set());
    buckets.get(k).add(ent.userId);
  }
  for (const set of buckets.values()) {
    const users = [...set];
    if (users.length < 2 || users.length > TIE_WINDOW_MAX_USERS) continue;
    for (let i = 0; i < users.length; i += 1) {
      for (let j = i + 1; j < users.length; j += 1) bump(users[i], users[j], 'co', TIE_CO_WEIGHT);
    }
  }

  return added;
}

/** 关系档位表（从高到低）。门槛写错会静默回退到默认值，不抛错。 */
export function tieTable(s) {
  let th = DEFAULT_TIE_THRESHOLDS.slice();
  const raw = String(s?.tieThresholds ?? '').trim();
  if (raw) {
    const parts = raw.split(/[,，\s]+/).map((x) => Number(String(x).trim()));
    const ok =
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n) && n > 0) &&
      parts.every((n, i) => i === 0 || n > parts[i - 1]);
    if (ok) th = parts.map((n) => Math.round(n));
  }
  return [
    { min: th[3], level: 5, title: TIE_TITLES[4] },
    { min: th[2], level: 4, title: TIE_TITLES[3] },
    { min: th[1], level: 3, title: TIE_TITLES[2] },
    { min: th[0], level: 2, title: TIE_TITLES[1] },
    { min: 0, level: 1, title: TIE_TITLES[0] }
  ];
}

export function tieLevelOf(w, s) {
  const v = Math.max(0, Math.floor(Number(w) || 0));
  const table = tieTable(s);
  for (const L of table) if (v >= L.min) return L;
  return table[table.length - 1];
}

/** 某人关系最紧密的若干人 */
export function topTies(chat, userId, s, n) {
  const uid = String(userId);
  const out = [];
  for (const t of Object.values(chat?.ties || {})) {
    if (String(t.a) !== uid && String(t.b) !== uid) continue;
    const other = String(t.a) === uid ? String(t.b) : String(t.a);
    out.push({
      other,
      w: Number(t.w) || 0,
      at: Number(t.at) || 0,
      adj: Number(t.adj) || 0,
      co: Number(t.co) || 0,
      last: Number(t.last) || 0
    });
  }
  out.sort((a, b) => b.w - a.w);
  return out.slice(0, Math.max(1, Number(n) || 5));
}

/** 全群概览：最紧密的若干对 + 连接度最高的几个人（社交中心） */
export function networkOverview(chat, s, n) {
  const limit = Math.max(1, Number(n) || 5);
  const ties = Object.values(chat?.ties || {}).sort((a, b) => (Number(b.w) || 0) - (Number(a.w) || 0));
  const degree = new Map();
  for (const t of ties) {
    for (const uid of [String(t.a), String(t.b)]) {
      const cur = degree.get(uid) || { links: 0, weight: 0 };
      cur.links += 1;
      cur.weight += Number(t.w) || 0;
      degree.set(uid, cur);
    }
  }
  const hubs = [...degree.entries()]
    .map(([uid, v]) => ({ uid, links: v.links, weight: v.weight }))
    .sort((a, b) => b.weight - a.weight || b.links - a.links)
    .slice(0, limit);
  return { pairs: ties.slice(0, limit), hubs, pairCount: ties.length, hubCount: degree.size };
}

/** 关系权重的定性说法（关掉数字时用） */
function tieWords(w, s) {
  const lv = tieLevelOf(w, s);
  const table = {
    1: '基本没怎么说过话，点头之交。',
    2: '互相认识，偶尔搭得上话。',
    3: '挺熟络，经常能聊到一块儿。',
    4: '关系要好，明显是小圈子。',
    5: '死党，几乎形影不离。'
  };
  return { title: lv.title, text: table[lv.level] || table[1] };
}

// ───────────────────────────── 记忆同步 ─────────────────────────────

/**
 * 把"这个群友和机器人的关系"写进长期记忆（ctx.memory）。
 * ⚠️ 四份文档都只给了 memory 的方法名（editMemberImpression(...) 这种省略号签名），
 *    没给参数表，所以这里按几种最可能的签名依次尝试，**写完立刻用读取接口回查**
 *    MEMORY_MARKER 是否真的进去了；成功的签名会被缓存到 meta.memoryShape，
 *    全部失败则返回明确的失败原因并写日志，绝不静默。
 */
async function syncMemberMemory(ctx, chatKey, userId, s) {
  if (s.syncMemory === false) return { ok: false, skipped: true };
  const memory = ctx?.memory;
  if (!memory || typeof memory !== 'object') return { ok: false, reason: '运行时没有提供 ctx.memory' };

  const chat = db?.chats?.[chatKey];
  const rec = chat?.members?.[userId];
  if (!rec) return { ok: false, reason: '没有这个人的好感度记录' };

  const now = Date.now();
  if (Number(rec.memSyncAt) && now - Number(rec.memSyncAt) < MEMORY_SYNC_INTERVAL) {
    return { ok: true, throttled: true };
  }

  const text = buildMemoryText(chat, userId, rec, s);
  if (!db.meta) db.meta = {};

  const shapes = [
    ['editMemberImpression', [chatKey, userId, { impression: text }]],
    ['editMemberImpression', [chatKey, userId, text]],
    ['editMemberImpression', [{ chatKey, userId, impression: text }]],
    ['editMemberImpression', [chatKey, userId, { text }]],
    ['editMemberImpression', [chatKey, userId, { impression: text, text }]],
    ['replaceMember', [chatKey, userId, { impression: text }]],
    ['replaceMember', [chatKey, userId, text]],
    ['append', [chatKey, userId, text]],
    ['append', [chatKey, text]]
  ];

  const cached = Number.isInteger(db.meta.memoryShape) ? db.meta.memoryShape : -1;
  const order = [];
  if (cached >= 0 && cached < shapes.length) order.push(cached);
  for (let i = 0; i < shapes.length; i += 1) if (i !== cached) order.push(i);

  const tried = [];
  for (const idx of order) {
    const [method, args] = shapes[idx];
    if (typeof memory[method] !== 'function') continue;
    try {
      await memory[method](...args);
    } catch (error) {
      tried.push(`${method}#${idx} 抛错`);
      warn(`记忆同步尝试 ${method} 失败：${error?.message ?? error}`);
      continue;
    }
    if (await verifyMemory(memory, chatKey, userId)) {
      db.meta.memoryShape = idx;
      rec.memSyncAt = now;
      markDirty();
      return { ok: true, method, shapeIndex: idx };
    }
    tried.push(`${method}#${idx} 回查未命中`);
  }

  warn(`记忆同步失败：候选签名都没通过回查校验（${tried.join('；') || '没有可用的写入方法'}）`);
  return { ok: false, reason: '候选签名均未通过回查校验', tried };
}

/** 回查：读回来的内容里有没有我们的标记文本 */
async function verifyMemory(memory, chatKey, userId) {
  const readers = [
    ['getMember', [chatKey, userId]],
    ['query', [chatKey, { userId }]],
    ['query', [chatKey]],
    ['members', [chatKey]]
  ];
  for (const [method, args] of readers) {
    if (typeof memory[method] !== 'function') continue;
    try {
      const got = await memory[method](...args);
      if (got === null || got === undefined) continue;
      const text = typeof got === 'string' ? got : safeStringify(got);
      if (text && text.includes(MEMORY_MARKER)) return true;
    } catch {
      // 换下一个读取方式
    }
  }
  return false;
}

function safeStringify(v) {
  try {
    return JSON.stringify(v) || '';
  } catch {
    return '';
  }
}

/** 写进记忆的正文。关掉数字显示时，记忆里也不出现任何好感度数值。 */
function buildMemoryText(chat, userId, rec, s) {
  const who = displayName(rec.name, userId, s);
  const noNum = s.showNumbers === false;
  const parts = [noNum ? `[${MEMORY_MARKER}] ${who}` : `[${MEMORY_MARKER}] ${who}（QQ ${userId}）`];

  if (noNum) {
    if (isOwner(userId, s)) {
      parts.push(`与机器人的关系：${titleOf(rec.score, s)}（主人，满级，最铁的一档）。`);
    } else {
      const d = describeLevel(rec.score, s);
      parts.push(`与机器人的关系：${d.short}——${d.text}`);
    }
  } else {
    parts.push(
      `与机器人的关系：${rec.score} 分 · Lv.${levelOf(rec.score, s).level}「${titleOf(rec.score, s)}」` +
        `${isOwner(userId, s) ? '（主人，恒为满级）' : ''}，累计发言 ${rec.msgs} 条，` +
        `认识于 ${fmtDate(rec.firstSeen)}，最近互动 ${fmtDate(rec.lastSeen)}。`
    );
  }

  const ties = topTies(chat, userId, s, 3);
  if (ties.length) {
    const names = ties.map((t) => {
      const nm = chat?.members?.[t.other]?.name || t.other;
      const lv = tieLevelOf(t.w, s);
      return noNum ? `${nm}（${lv.title}）` : `${nm}（${lv.title}，权重 ${t.w}）`;
    });
    parts.push(`群里和 TA 最熟的人：${names.join('、')}。`);
  }
  return parts.join('');
}

// ───────────────────────────── 播报 ─────────────────────────────

/** 把待播报的升级消息发到群里（只在 activate 拿到 sender 时生效） */
async function flushPendingAnnouncements() {
  const sender = activeCtx?.sender;
  if (!sender || typeof sender.sendTextBatch !== 'function') return;
  const s = currentSettings();
  if (s.announceLevelUp === false) return;
  await ensureLoaded();

  const now = Date.now();
  let changed = false;

  for (const [chatKey, chat] of Object.entries(db.chats || {})) {
    const lines = [];
    for (const [uid, rec] of Object.entries(chat?.members || {})) {
      if (isOwner(uid, s)) continue; // 主人不播报
      if (!Array.isArray(rec.pending) || !rec.pending.length) continue;
      const fresh = rec.pending.filter((p) => now - (Number(p.at) || 0) < PENDING_TTL);
      rec.pending = [];
      changed = true;
      for (const p of fresh.slice(-2)) {
        lines.push(`${p.name || '有群友'} 的好感度升到了 Lv.${p.level}「${p.title}」`);
      }
    }
    if (!lines.length) continue;
    try {
      await sender.sendTextBatch(chatKey, [`好感度更新：${lines.join('；')}`]);
    } catch (error) {
      warn(`升级播报发送失败（${chatKey}）：${error?.message ?? error}`);
    }
  }

  if (changed) {
    markDirty();
    await flush();
  }
}

/** 查询时取走某人积压的升级播报（避免和定时器重复播报） */
function takePending(chatKey, userId) {
  const rec = db.chats?.[chatKey]?.members?.[userId];
  if (!rec || !Array.isArray(rec.pending) || !rec.pending.length) return [];
  const now = Date.now();
  const out = rec.pending
    .filter((p) => now - (Number(p.at) || 0) < PENDING_TTL)
    .map((p) => `${p.name || userId} 的好感度升到了 Lv.${p.level}「${p.title}」`);
  rec.pending = [];
  markDirty();
  return out;
}

// ───────────────────────────── 消息条目解析 ─────────────────────────────

/**
 * 把 store / triggerEntries 里的消息条目统一成一种结构。
 * 不同来源字段名不一致，这里做宽松兼容（拿不到就留空，不猜）。
 */
export function normalizeEntry(raw, selfId = '') {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw.entry && typeof raw.entry === 'object' ? Object.assign({}, raw, raw.entry) : raw;
  const sender = e.sender && typeof e.sender === 'object' ? e.sender : null;

  const userId = String(
    firstVal([
      e.userId, e.user_id, e.senderId, e.senderUserId, e.fromUserId, e.qq,
      sender?.user_id, sender?.userId, sender?.id
    ]) ?? ''
  ).trim();

  const name = String(
    firstVal([e.groupCard, e.card, sender?.card, sender?.nickname, e.nickname, e.senderName, e.name, e.remark]) ?? ''
  ).trim();

  const ts = toMs(firstVal([e.timestamp, e.ts, e.time, e.at, e.createdAt, e.date, e.sendTime]));
  const mid = String(firstVal([e.messageId, e.message_id, e.mid, e.localId, e.id]) ?? '').trim();

  const { text, ats, hasReply, hasMedia, replyMid } = extractContent(e);

  const selfRole = String(sender?.role ?? '');
  const isSelf =
    e.self === true || e.fromSelf === true || e.isSelf === true || e.outgoing === true || e.fromMe === true ||
    selfRole === 'self' || selfRole === 'owner_self' ||
    Boolean(selfId && userId && userId === String(selfId));

  if (!userId && !text && !hasMedia) return null;
  return { userId, name, ts, mid, text, ats, hasReply, hasMedia, replyMid, isSelf };
}

function extractContent(e) {
  let text = '';
  let hasReply = false;
  let hasMedia = false;
  let replyMid = '';
  const ats = [];

  const pushSeg = (seg) => {
    if (!seg || typeof seg !== 'object') return;
    const t = String(seg.type ?? '').toLowerCase();
    const d = seg.data && typeof seg.data === 'object' ? seg.data : {};
    if (t === 'text') {
      text += String(d.text ?? '');
    } else if (t === 'at') {
      const q = String(d.qq ?? d.id ?? d.userId ?? d.user_id ?? '').trim();
      if (q && q !== 'all') ats.push(q);
    } else if (t === 'reply') {
      hasReply = true;
      const rid = String(d.id ?? d.messageId ?? d.message_id ?? '').trim();
      if (rid && !replyMid) replyMid = rid;
    } else if (t) {
      hasMedia = true;
    }
  };

  const msg = firstVal([e.message, e.segments, e.content, e.text, e.raw_message]);
  if (Array.isArray(msg)) {
    for (const seg of msg) pushSeg(seg);
  } else if (typeof msg === 'string') {
    text += msg;
  } else {
    const t = firstVal([e.text, e.raw_message, e.content]);
    if (typeof t === 'string') text += t;
  }

  if (e.hasReply === true) hasReply = true;
  if (Array.isArray(e.media) && e.media.length) hasMedia = true;
  const replyField = firstVal([e.replyTo, e.reply_to, e.replyMessageId, e.replyMsgId]);
  if (replyField && !replyMid) replyMid = String(replyField).trim();

  // CQ 码形式的 at / reply / 媒体
  for (const m of text.matchAll(/\[CQ:at,qq=(\d+)[^\]]*\]/g)) ats.push(m[1]);
  const cqReply = text.match(/\[CQ:reply,id=([^\],\]]+)/);
  if (cqReply) {
    hasReply = true;
    if (!replyMid) replyMid = cqReply[1].trim();
  } else if (/\[CQ:reply/.test(text)) {
    hasReply = true;
  }
  if (/\[CQ:(image|record|video|file)/.test(text)) hasMedia = true;

  text = text.replace(/\[CQ:[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  return { text, ats, hasReply, hasMedia, replyMid };
}

/** store.recent 可能返回数组，也可能返回包了一层的对象 */
function unwrapList(x) {
  if (!x) return [];
  if (Array.isArray(x)) return x.flat(1).filter(Boolean);
  if (typeof x === 'object') {
    for (const k of ['messages', 'entries', 'items', 'list', 'data', 'records']) {
      if (Array.isArray(x[k])) return x[k].filter(Boolean);
    }
  }
  return [];
}

function firstVal(list) {
  for (const v of list) {
    if (v === null || v === undefined) continue;
    if (typeof v === 'string' && !v.trim()) continue;
    return v;
  }
  return undefined;
}

function toMs(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

// ───────────────────────────── 查询辅助 ─────────────────────────────

/**
 * 确认"是谁在问"。私聊场景 chatId 就是对方 QQ 号，直接用；
 * 群聊场景取聊天记录里最近一条、且内容和本次触发文本对得上的非机器人消息。
 */
async function resolveRequester(ctx, chatKey, selfId, s) {
  if (ctx?.kind === 'private' && ctx?.chatId) {
    return { userId: String(ctx.chatId), name: '' };
  }
  const store = ctx?.store;
  if (!store || typeof store.recent !== 'function') return { userId: '', name: '' };
  let list = [];
  try {
    list = unwrapList(await store.recent(chatKey, { limit: 20 }));
  } catch {
    return { userId: '', name: '' };
  }
  const ents = list
    .map((raw) => normalizeEntry(raw, selfId))
    .filter((x) => x && !x.isSelf && x.userId)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (!ents.length) return { userId: '', name: '' };

  const trigger = String(ctx?.session?.triggerText || '').replace(/\s+/g, '').trim();
  if (trigger) {
    for (const ent of ents) {
      const t = String(ent.text || '').replace(/\s+/g, '');
      if (!t) continue;
      const a = t.slice(0, 30);
      const b = trigger.slice(0, 30);
      if (trigger.includes(a) || t.includes(b)) return { userId: ent.userId, name: ent.name };
    }
  }
  // 兜底：最近发言的人。仅用于查询类场景；改写类操作会再校验是否主人
  return { userId: ents[0].userId, name: ents[0].name };
}

/** 按 QQ 号 / 昵称找人 */
export function findMember(members, target) {
  const q = String(target ?? '').trim();
  if (!q) return null;
  const pure = q.replace(/[^\d]/g, '');
  if (pure && members[pure]) return { userId: pure, rec: members[pure] };

  const list = Object.entries(members || {});
  const norm = (x) => String(x || '').trim().toLowerCase();
  const key = norm(q);

  const exact = list.find(([, r]) => norm(r.name) === key);
  if (exact) return { userId: exact[0], rec: exact[1] };

  const fuzzy = list.filter(([, r]) => norm(r.name) && (norm(r.name).includes(key) || key.includes(norm(r.name))));
  if (fuzzy.length === 1) return { userId: fuzzy[0][0], rec: fuzzy[0][1] };
  if (fuzzy.length > 1) {
    // 多个同名时取分数最高的那个，并在结果里说明有歧义
    fuzzy.sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
    return { userId: fuzzy[0][0], rec: fuzzy[0][1], ambiguous: fuzzy.length };
  }
  return null;
}

function sortedMembers(members) {
  return Object.entries(members || {}).sort((a, b) => (Number(b[1].score) || 0) - (Number(a[1].score) || 0));
}

function rankOf(members, userId, s) {
  const list = sortedMembers(members);
  const idx = list.findIndex(([id]) => id === String(userId));
  return { rank: idx >= 0 ? idx + 1 : 0, total: list.length };
}

/** 昵称缺失时，用 OneBot 封装方法补一次（失败就算了，不影响主流程） */
async function fillName(ctx, rec, userId) {
  if (!rec || rec.name || ctx?.kind !== 'group' || !ctx?.onebot) return;
  if (typeof ctx.onebot.getGroupMemberInfo !== 'function') return;
  const gid = Number(ctx.chatId);
  const uid = Number(userId);
  if (!Number.isInteger(gid) || gid <= 0 || !Number.isInteger(uid) || uid <= 0) return;
  try {
    const info = await ctx.onebot.getGroupMemberInfo(gid, uid);
    const nm = String(firstVal([info?.card, info?.nickname, info?.name]) ?? '').trim();
    if (nm) {
      rec.name = nm;
      markDirty();
    }
  } catch (error) {
    warn(`补全群昵称失败（QQ ${userId}）：${error?.message ?? error}`);
  }
}

// ───────────────────────────── 纯函数 ─────────────────────────────

/** 按设置里的门槛拼出等级表（从高到低） */
export function levelTable(s) {
  let th = DEFAULT_THRESHOLDS.slice();
  const raw = String(s?.levelThresholds ?? '').trim();
  if (raw) {
    const parts = raw.split(/[,，\s]+/).map((x) => Number(String(x).trim()));
    const ok =
      parts.length === 4 &&
      parts.every((n) => Number.isFinite(n) && n > 0) &&
      parts.every((n, i) => i === 0 || n > parts[i - 1]);
    if (ok) th = parts.map((n) => Math.round(n));
    else if (raw) th = DEFAULT_THRESHOLDS.slice(); // 格式不对就回退默认，不抛错
  }
  return [
    { min: th[3], level: 5, title: LEVEL_TITLES[4] },
    { min: th[2], level: 4, title: LEVEL_TITLES[3] },
    { min: th[1], level: 3, title: LEVEL_TITLES[2] },
    { min: th[0], level: 2, title: LEVEL_TITLES[1] },
    { min: 0, level: 1, title: LEVEL_TITLES[0] }
  ];
}

export function levelOf(score, s) {
  const v = Math.max(0, Math.floor(Number(score) || 0));
  const table = levelTable(s);
  for (const L of table) if (v >= L.min) return L;
  return table[table.length - 1];
}

export function titleOf(score, s) {
  return levelOf(score, s).title;
}

export function progressText(score, s) {
  const v = Math.floor(Number(score) || 0);
  const table = levelTable(s);
  const top = table[0];
  if (v < 0) {
    // 负分：先说回 0 要多少，再说 0 以上的下一档
    const nxt = table.filter((L) => L.min > 0).sort((a, b) => a.min - b.min)[0];
    const tail = nxt ? `；回到 0 之后再攒 ${nxt.min} 分才到 Lv.${nxt.level}「${nxt.title}」` : '';
    return `好感度还是负的，先攒回 0（差 ${-v} 分）${tail}`;
  }
  const next = table.filter((L) => L.min > v).sort((a, b) => a.min - b.min)[0];
  if (!next) return `已经是最高等级「${top.title}」了`;
  return `再攒 ${next.min - v} 分升到 Lv.${next.level}「${next.title}」`;
}

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/** 0 基下标 → 中文序数（第一、第二……第十、第二十）。关掉数字显示时用它，避免出现阿拉伯数字 */
function cnOrdinal(i) {
  const n = Math.max(1, Math.round(Number(i) || 0) + 1);
  if (n < 10) return `第${CN_NUM[n]}`;
  if (n === 10) return '第十';
  if (n < 20) return `第十${CN_NUM[n - 10]}`;
  if (n < 100) {
    const t = Math.floor(n / 10);
    const o = n % 10;
    return `第${CN_NUM[t]}十${o ? CN_NUM[o] : ''}`;
  }
  return `第${n}`; // 超过 99 就退回阿拉伯数字（榜单不可能这么长）
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, Math.round(v)));
}

function dayString(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function fmtDate(ts) {
  if (!ts) return '未知';
  return dayString(ts);
}

/**
 * 显示名。关掉「报出具体数字」时不能回退成 QQ 号——QQ 号本身就是一串阿拉伯数字，
 * 会把数字带进模型的上下文，所以这种情况改用中性称呼。
 */
function displayName(name, uid, s) {
  const nm = String(name ?? '').trim();
  if (nm) return nm;
  return s?.showNumbers === false ? '某位群友' : String(uid ?? '');
}

function chatKeyOf(ctx) {
  if (!ctx) return '';
  if (ctx.chatKey) return String(ctx.chatKey);
  if (ctx.kind && ctx.chatId) return `${ctx.kind}:${ctx.chatId}`;
  return '';
}

/** 生效设定 = 内置默认 < 控制台面板设置（面板是唯一来源） */
function currentSettings() {
  const out = { ...DEFAULTS };
  let c = {};
  try {
    c = cfg() || {};
  } catch {
    c = {};
  }
  for (const [k, v] of Object.entries(c)) {
    if (v === undefined || v === null) continue;
    out[k] = v;
  }
  // v1.5.0 起设定只认控制台面板（configSchema 渲染的表单）。
  // 旧版在聊天里改过的 meta.overrides 不再参与计算，避免"面板改了却没生效"的困惑。
  return out;
}

// ───────────────────────────── 可编辑名单（CSV）─────────────────────────────
// 每次落盘时顺手导出一份表格，可以用 Excel/WPS 直接打开改分数，
// 改完让主人说一句「重新读取好感度名单」即可回写进插件。

function csvPath() {
  return path.join(path.dirname(dataFilePath()), CSV_NAME);
}

function csvEscape(v) {
  const s = String(v ?? '');
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 生成 CSV 文本（不含 BOM，BOM 在写文件时加） */
export function buildCsv() {
  const s = currentSettings();
  const rows = [CSV_HEADER.join(',')];
  for (const [chatKey, chat] of Object.entries(db?.chats || {})) {
    for (const [uid, rec] of sortedMembers(chat?.members || {})) {
      rows.push([
        csvEscape(chatKey),
        csvEscape(uid),
        csvEscape(rec.name || ''),
        Number(rec.score) || 0,
        levelOf(rec.score, s).level,
        csvEscape(titleOf(rec.score, s)),
        Math.round(resistFactor(rec.score, s) * 100),
        Number(rec.msgs) || 0,
        csvEscape(fmtDate(rec.firstSeen)),
        csvEscape(fmtDate(rec.lastSeen)),
        Number(rec.dayGain) || 0,
        Number(rec.daySentiment) || 0,
        rec.pinned === true ? '是' : ''
      ].join(','));
    }
  }
  return `${rows.join('\r\n')}\r\n`;
}

/** 轻量内容指纹（djb2）。用来判断名单表格是不是被人在外面改过，不依赖文件时间戳。 */
function csvHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i += 1) {
    h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

async function writeCsvFile() {
  try {
    if (currentSettings().exportCsv === false) return;
    if (!db) return;
    const body = buildCsv();
    // 带 BOM：Windows 上双击用 Excel 打开中文不乱码
    await fs.writeFile(csvPath(), `\uFEFF${body}`, 'utf8');
    if (!db.meta) db.meta = {};
    db.meta.csvWrittenAt = Date.now();
    db.meta.csvHash = csvHash(body); // 记住"这份内容是我们自己写的"
  } catch (error) {
    warn(`导出名单表格失败（不影响好感度功能）：${error?.message ?? error}`);
  }
}

let lastCsvCheckAt = 0;

/**
 * 自动回读名单表格。判据是**内容指纹**而不是修改时间：
 * 表格内容和我们上次导出的不一样 → 说明有人在 Excel 里改过 → 读回来。
 * 用时间戳会有个丢数据的坑：用户若在导出后一两秒内保存，会被误判成"我们自己写的"，
 * 紧接着的导出就把他的修改永久覆盖掉。指纹比对没有这个问题。
 * 节流 5 秒，避免每次触发都读盘。
 */
async function maybeImportCsv(s) {
  if (s?.autoImportCsv === false) return null;
  const nowTs = Date.now();
  if (nowTs - lastCsvCheckAt < CSV_CHECK_INTERVAL) return null;
  lastCsvCheckAt = nowTs;
  try {
    const raw = await fs.readFile(csvPath(), 'utf8');
    const body = raw.replace(/^\uFEFF/, '');
    const known = db?.meta?.csvHash;
    if (known && csvHash(body) === known) return null; // 就是我们自己导出的那份，没人动过
    const r = await importCsv();
    if (r.ok) {
      log(`检测到名单表格被手动修改，已自动回读（改动 ${r.updated} 人${r.pinned ? `，跳过主人 ${r.pinned} 行` : ''}${r.skipped ? `，跳过 ${r.skipped} 行` : ''}）`);
    } else {
      warn(`名单表格自动回读失败：${r.reason}`);
    }
    return r;
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`检查名单表格时出错：${error?.message ?? error}`);
    return null; // 文件不存在就跳过
  }
}

/** 极简 CSV 行解析：支持双引号包裹与 "" 转义 */
export function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQ = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQ = true;
    } else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((x) => x.trim());
}

/**
 * 从 CSV 名单回读修改。只改「好感度」和「昵称」两列，其余列是给人看的、改了不生效。
 * 主人（pinned）的分数恒定，不接受表格修改；表里没有的人不会被删除。
 */
export async function importCsv() {
  let text = '';
  try {
    text = await fs.readFile(csvPath(), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { ok: false, reason: `找不到名单文件：${csvPath()}` };
    return { ok: false, reason: `读取名单失败：${error?.message ?? error}` };
  }
  text = text.replace(/^\uFEFF/, '');
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < 2) return { ok: false, reason: '名单是空的（只有表头，没有数据行）' };

  const head = parseCsvLine(lines[0]);
  const iChat = head.indexOf('会话');
  const iUid = head.indexOf('QQ号');
  const iName = head.indexOf('昵称');
  const iScore = head.indexOf('好感度');
  if (iChat < 0 || iUid < 0 || iScore < 0) {
    return { ok: false, reason: '表头不对：必须保留「会话」「QQ号」「好感度」三列的列名，别改表头文字。' };
  }

  await ensureLoaded();
  const s = currentSettings();
  const now = Date.now();
  let updated = 0;
  let skipped = 0;
  let pinned = 0;
  const missing = [];

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    const chatKey = cells[iChat];
    const uidRaw = String(cells[iUid] || '').trim();
    if (!chatKey || !uidRaw) {
      skipped += 1;
      continue;
    }
    const chat = db.chats?.[chatKey];
    // QQ 号可能被 Excel 改成科学计数法或加了空格，所以三种方式依次找：
    // 原样 → 抽成纯数字 → 按昵称唯一匹配（兜底，避免整行作废）
    let uid = '';
    let rec = null;
    if (chat?.members?.[uidRaw]) {
      uid = uidRaw;
      rec = chat.members[uidRaw];
    } else {
      const digits = uidRaw.replace(/[^\d]/g, '');
      if (digits && chat?.members?.[digits]) {
        uid = digits;
        rec = chat.members[digits];
      } else if (iName >= 0 && cells[iName]) {
        const nm = String(cells[iName]).trim().toLowerCase();
        const hits = Object.entries(chat?.members || {}).filter(([, m]) => String(m.name || '').trim().toLowerCase() === nm);
        if (hits.length === 1) {
          uid = hits[0][0];
          rec = hits[0][1];
        }
      }
    }
    if (!rec) {
      if (missing.length < 10) missing.push(`${chatKey} / ${uidRaw}`);
      skipped += 1;
      continue;
    }
    if (rec.pinned === true || isOwner(uid, s)) {
      pinned += 1;
      continue;
    }
    const n = Number(String(cells[iScore]).replace(/[^\d.-]/g, ''));
    if (!Number.isFinite(n)) {
      skipped += 1;
      continue;
    }
    const before = Number(rec.score) || 0;
    const next = Math.max(scoreFloorOf(s), Math.round(n));
    if (iName >= 0 && cells[iName]) rec.name = cells[iName];
    if (next !== before) {
      rec.score = next;
      noteLevelChange(rec, s, before, now, uid);
      rec.importedAt = now;
      updated += 1;
    }
  }

  markDirty();
  await flush();
  return { ok: true, updated, skipped, pinned, missing, file: csvPath(), total: lines.length - 1 };
}

// ───────────────────────────── 持久化 ─────────────────────────────

function dataFilePath() {
  if (dbFile) return dbFile;
  const dir = process.env.QQ_AGENT_DATA_DIR || path.resolve(process.cwd(), 'data');
  dbFile = path.join(dir, 'affinity.json');
  return dbFile;
}

async function ensureLoaded() {
  if (loaded && db) return db;
  loaded = true;
  db = { version: 1, meta: {}, chats: {} };
  try {
    const raw = await fs.readFile(dataFilePath(), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      if (parsed.meta && typeof parsed.meta === 'object') db.meta = parsed.meta;
      if (parsed.chats && typeof parsed.chats === 'object') db.chats = parsed.chats;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') warn(`读取好感度数据失败，将从空数据开始：${error?.message ?? error}`);
  }
  syncOwners();
  return db;
}

function getChat(chatKey) {
  const c = db.chats[chatKey] || (db.chats[chatKey] = { members: {}, ties: {}, seen: [], lastSpeaker: null, lastScanAt: 0 });
  if (!c.members || typeof c.members !== 'object') c.members = {};
  if (!c.ties || typeof c.ties !== 'object') c.ties = {};
  if (!Array.isArray(c.seen)) c.seen = [];
  return c;
}

function newRecord(now) {
  return {
    name: '',
    score: 0,
    level: 1,
    msgs: 0,
    firstSeen: now,
    lastSeen: now,
    dayKey: dayString(now),
    dayGain: 0,
    daySentiment: 0,
    dayTip: 0,
    tipCount: 0,
    tipAmount: 0,
    decayAcc: 0,
    moodLog: [],
    pinned: false,
    pending: []
  };
}

function markDirty() {
  dirty = true;
}

async function flush() {
  if (!dirty || !db) return;
  dirty = false;
  try {
    const file = dataFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(db), 'utf8');
  } catch (error) {
    dirty = true; // 写失败就保留脏标记，下次再试
    warn(`写入好感度数据失败：${error?.message ?? error}`);
    return;
  }
  // 顺手导出一份可用 Excel 打开编辑的名单（失败不影响主流程）
  await writeCsvFile();
}
