// 记忆与存档优化（memory-plus）· 插件入口
//
// 这个插件接管控制台「记忆」页的展示与写入，并给机器人加上"长期 / 短期两层记忆"：
//   ▸ 确定性的一侧（钩子 + 定时器）
//       · before-context / before-llm-messages：记忆怎么进提示词、短期记忆什么时候过期、
//         排队的存档清理什么时候生效 —— 这些必须是死规则，不能指望模型自觉。
//       · activate 里的定时器：过期清理与存档定期清理到点必然发生。
//   ▸ 交给模型的一侧（8 个工具）
//       该不该记、该不该晋升、拿不准要不要问主人 —— 只有模型判得准。
//   ▸ 控制台侧（registerRoutes 动作路由）
//       面板的写操作入口（长期记忆的写仍然走核心自己的接口，见 lib/host.js 的说明）。
//
// 术语：界面上统一叫「记忆」（长期记忆 / 短期记忆 / 记忆标签），不再出现"印象"这个独立概念。
import path from 'node:path';
import fs from 'node:fs';

// ⚠️ 这里刻意用**带 ?t= 的动态 import** 加载自己的 lib/*，而不是静态 import：
//    Node 的 ESM 按 URL 缓存模块，静态子模块在热重载时不会更新（改了代码不生效，
//    表现为"明明改了文件，行为还是旧的"，比报错更难查）。同一个 BUST 保证这一次
//    加载出来的 5 个 lib 模块是同一批（lib 之间不互相 import，所以没有身份冲突）。
const BUST = `?t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const storeMod = await import(`./lib/store.js${BUST}`);
const archiveMod = await import(`./lib/archive.js${BUST}`);
const promptMod = await import(`./lib/prompt.js${BUST}`);
const llmMod = await import(`./lib/llm.js${BUST}`);
const hostMod = await import(`./lib/host.js${BUST}`);
const profileMod = await import(`./lib/profile.js${BUST}`);

const {
  KINDS, KIND_LABELS, addShort, removeShort, setShortKind, promoteShortItem, chatMembers, chatFlags,
  getMember, setLabels, addLabel, removeLabel, expireShort, stats,
  addQuestion, listQuestions, answerQuestion, resolveQuestion, lastAskAt,
  addPendingPrune, takePendingPrune, listPendingPrune, setLastConsolidated,
  setArchiveSweep, archiveSweepState, recordPurge, looksLikeAppointment,
  isDuePassed, sweepDueAppointments, backfillDueAt,
  getLongMeta, setLongMeta, bumpLongMeta, load: loadState, save: saveState,
  listChats, dataDir, chatState, longMetaMap, touchMemberSeen, membersWithoutMemory,
  getLabelQueue, setLabelQueue, shiftLabelQueue, clearLabelQueue, chatsWithLabelQueue,
  chatDirOf, writeLongSnapshot, setStoreDir, coreMemoryRoot, sameImpression
} = storeMod;

const {
  searchLocalArchive, pruneRangeLocal, sweepOldMessages, archiveOverview, parseTime, stampOf,
  readRecentFromDisk, listBackups, restoreBackup, archivedChats, messagesDir
} = archiveMod;
const {
  buildMemoryBlock, applyToMessages, buildPendingAnswerBlock, buildAskReminderBlock, daysLeft,
  trimHistorySection, trimSystemSections, measurePrompt
} = promptMod;
const { askModel, extractJson, cleanTags, pickTags } = llmMod;
const { installHost, removeHost, hostStatus, writeSnapshot, reloadConsole } = hostMod;
const { resolveMember, applyRename, applyFact } = await import(`./lib/member-edit.js${BUST}`);
const {
  buildProfileBlock, ingestObservation, addLongTerm, setTags: setProfileTags, addTrait,
  promoteLongToTrait, updateTrait, removeTrait, demoteTraitToLong, demoteLongToCandidate, demoteStale,
  profileDir: profileDirOf, readProfile, writeProfile, listProfiles, profileSummary, sim: profileSim
} = profileMod;

// ── 模块级状态 ──────────────────────────────────────────────────────────
let apiRef = null;
let readBodyFn = null;
let jsonFn = null;
let cfg = () => ({});
/** 面板返回体统一带的时效/门槛参数。 */
function ttlOf(c) {
  return {
    long: Number(c.longTtlDays) || 0,
    short: Math.max(1, Number(c.shortTtlDays) || 2),
    minHits: Math.max(2, Number(c.promoteMinHits) || 3),
    demoteLong: Number(c.demoteLongDays) || 0,
    demoteTrait: Number(c.demoteTraitDays) || 0
  };
}

/** 档案目录：显式配置 > storeDir/profiles > 插件默认。 */
function profileDirResolved(c) {
  const explicit = String(c?.profileDir || '').trim();
  if (explicit) return explicit;
  const store = String(c?.storeDir || '').trim();
  if (store) return path.join(store, 'profiles');
  return profileDirOf('');
};
const blockCache = new Map();       // sessionId -> { text, at }
const timers = [];
let lastExpireAt = 0;
let lastSnapshotAt = 0;
/** 当前整理任务（同一时刻只允许一个，面板靠轮询看进度）。 */
let job = null;
/** 最近一次操作的结论 —— 界面常驻状态区一直显示它，不用等报错才提醒。 */
let lastOperation = { at: 0, ok: true, text: '' };
/** 最近一次提示词裁剪的情况（面板显示用）。 */
let lastTrim = { at: 0, history: 0, sections: [] };
/** sessionId -> 本轮"真正发出去"的提示词（after-response 写回会话记录，让控制台显示真实内容）。 */
const finalPromptCache = new Map();
/** 最近一次实发提示词的摘要（面板状态区显示用）。 */
let lastSentPrompt = { at: 0, total: 0, memory: null, historyKept: 0, historyCut: 0, sections: [] };
/** 标签压缩队列的定时器（一次一个人、间隔 30 秒）。 */
let labelQueueTimer = null;
let labelQueueChat = '';

function noteOperation(ok, text) {
  lastOperation = { at: Date.now(), ok: ok !== false, text: String(text || '').slice(0, 400) };
  return lastOperation;
}

/** 取一条消息的纯文本（content 可能是字符串，也可能是 [{type:'text',text}] 数组）。 */
function contentText(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) {
    return msg.content.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('\n');
  }
  return '';
}

// 日志：setup 之前（钩子先于 setup 触发、或测试里直接调钩子）没有 api，退回 console，
// 绝不让一条诊断信息凭空消失。
function log(...args) {
  try { if (apiRef?.log) apiRef.log(...args); else console.log('[memory-plus]', ...args); } catch { /* ignore */ }
}
function warn(...args) {
  try { if (apiRef?.warn) apiRef.warn(...args); else console.warn('[memory-plus]', ...args); } catch { /* ignore */ }
}
function verbose(...args) { if (cfg().verbose) log(...args); }

function ownerId() { return String(cfg().ownerQq || '').replace(/\D/g, ''); }
function isOwnerPrivateKey(chatKey) {
  const id = ownerId();
  return !!id && String(chatKey) === `private:${id}`;
}
/** 当前会话是不是主人私聊（决定"能不能查别的群"）。 */
function canQueryOtherChats(ctx) {
  return isOwnerPrivateKey(ctx?.chatKey);
}
function trimText(s, n) { return String(s ?? '').trim().slice(0, n); }
function kindLabel(kind) { return KIND_LABELS[kind] || kind || '一般观察'; }

// ── 功能开关 ───────────────────────────────────────────────────────────
// 每一个大功能都能单独关掉；关掉之后那部分完全回到原生行为。
// disableAll 是总闸：连钩子和工具一起停（见 available()）。
function on(key, dflt = true) {
  const v = cfg()[key];
  return v === undefined || v === null ? dflt : v !== false;
}
/** 本会话是否跳过系统提示裁剪（跑团群等）。 */
function skipTrimForChat(chatKey) {
  const list = String(cfg().trimSkipChats || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
  return list.includes(String(chatKey || ''));
}
/** 要把哪个工具挡掉（返回原因字符串 = 挡；返回空 = 放行）。 */
function blockReason(toolId) {
  const id = String(toolId || '');
  if (!id) return '';
  if (on('enableToolGuard') && cfg().blockedTools) {
    const list = String(cfg().blockedTools || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
    for (const key of list) {
      if (!key) continue;
      // 支持前缀：写成 "chat-archive__" 就整段拦掉
      if (id === key || (key.endsWith('__') ? id.startsWith(key) : id.startsWith(`${key}__`) || id === key)) {
        return `被「记忆与存档优化」的噪声工具拦截规则挡住（${key}）——它容易被反复挂着调、返回与话题无关的长内容。要放开就在插件设置里删掉这一条。`;
      }
    }
  }
  if (!on('enableMemory') && /^memory-plus__(note_impression|recall_impression|promote_impression|drop_impression|consolidate_memory)$/.test(id)) {
    return '「两层记忆」已关闭（插件设置里可以打开）';
  }
  if (!on('enableShortTerm') && /^memory-plus__(note_impression|promote_impression)$/.test(id)) {
    return '「短期记忆」已关闭（插件设置里可以打开）';
  }
  if (!on('enableArchiveTools') && id === 'memory-plus__search_archive') {
    return '「聊天记录检索」已关闭（插件设置里可以打开）';
  }
  return '';
}

// ══════════════════════════════════════════════════════════════════════
// 工具（模型看得见的那一侧）
// ══════════════════════════════════════════════════════════════════════

function registerTools(api) {
  // ── 1. 记一条短期记忆 ───────────────────────────────────────────────
  api.registerTool({
    id: 'note_impression',
    name: '记一条记忆（短期）',
    description: '把对某人的新观察记成**短期记忆**：会过期、可能不准，同一件事重复记会自动累加提及次数。'
      + '群友出现稳定特点、偏好、身份关系，或出现约定/答应/待提醒的事时用；一时话题、情绪、当天闲聊不记。'
      + '同一件事别换词重记，再调一次让它累加即可。玩梗、扮演、互称外号、跟着起哄，要么不记，要么写明「自称/扮演」。'
      + '一条一句话、事实尽量 ≤60 字；密码、Token、密钥、证件号、手机号等凭证一律不记。',
    category: 'memory',
    icon: '📝',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记下的观察，一句话说清（事实尽量 ≤60 字）。约定类必须保留原话里的时间、人名、事情，不许改写；偏好/决定/称呼保留原话措辞。' },
        userId: { type: 'string', description: '这条记忆关于谁（QQ 号）。不填 = 当前会话对方（私聊）或触发消息的发送者。' },
        name: { type: 'string', description: '对方的名字/群名片，可选，用于显示。' },
        kind: { type: 'string', enum: KINDS, description: '类型：general 一般观察 / appointment 约定或待办 / preference 偏好 / fact 事实 / relation 关系 / correction 被纠正过的雷区。约定类一定要填 appointment。' },
        tags: { type: 'array', items: { type: 'string' }, description: '可选，1~3 个短标签（2~6 个字），如"嘴硬""夜猫子"。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      try {
        let content = trimText(args?.content, 400);
        if (!content) return { content: '缺少 content：要记什么？', isError: true };
        const userId = String(args?.userId || (ctx?.kind === 'private' ? ctx?.chatId : '') || '').replace(/\D/g, '');
        if (!userId) return { content: '缺少 userId：这条记忆是关于谁的？请填对方的 QQ 号。', isError: true };
        const kind = KINDS.includes(args?.kind) ? args.kind : (looksLikeAppointment(content) ? 'appointment' : 'general');
        // 模型写记忆时常漏主语，入库前统一补成"某人+内容"，免得以后看不出说的是谁
        content = ensureSubject(content, String(args?.name || '').trim() || `QQ${userId}`);
        const r = addShort(ctx.chatKey, userId, args?.name || '', {
          content,
          kind,
          tags: args?.tags,
          source: 'tool'
        });
        const item = r.item;
        const ttl = Math.max(1, Number(cfg().shortTtlDays) || 14);
        const minHits = Math.max(1, Number(cfg().promoteMinHits) || 3);
        const head = r.merged
          ? `已累加：这件事你之前记过，现在提及次数到 ${item.hits} 次`
          : '已记成短期记忆';
        const hint = item.hits >= minHits
          ? `\n它已经出现 ${item.hits} 次（≥ 阈值 ${minHits}）。如果它确实是稳定特征/真实约定，调 promote_impression 晋升成长期记忆（要写理由）；只是一时的事就放着，${ttl} 天后会自动过期。`
          : `\n再遇到同一件事时重复调用本工具即可累加次数（当前 ${item.hits} 次，到 ${minHits} 次会被标成"建议晋升"）。${ttl} 天内没晋升就会自动删除。`;
        return { content: `${head}（类型 ${kindLabel(item.kind)}，提及×${item.hits}）。${hint}` };
      } catch (error) {
        return { content: `记记忆失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 2. 查/展开记忆 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'recall_impression',
    name: '查记忆（标签速览 / 原文展开）',
    description: '查某人或本会话的记忆：mode=tag 只给压缩标签（省 token）；mode=full 给长期与短期原文全文。'
      + '提示词【记忆】段只给了一部分；要引用原话、判断一个人到底怎么回事、或标签看不懂时，用 mode=full，别靠标签猜。'
      + '只管「人」：性格、偏好、习惯、对谁什么态度。翻很久以前的对话原话用 memory_recall；查约定、未决事项、事情进展用 ledger_search。',
    category: 'memory',
    icon: '🔍',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '要看谁的记忆（QQ 号）。不填 = 本会话所有人的概览。' },
        mode: { type: 'string', enum: ['tag', 'full'], description: 'tag = 只给标签；full = 给原文全文。默认 tag。' }
      }
    },
    async execute(ctx, args) {
      try {
        const mode = args?.mode === 'full' ? 'full' : 'tag';
        const wantId = String(args?.userId || '').replace(/\D/g, '');
        const shortMap = chatMembers(ctx.chatKey);
        const longMembers = safeMembers(ctx);
        const lines = [];

        const pushOne = (userId, longName, longItems, shortEntry) => {
          const name = longName || shortEntry?.name || userId || '某人';
          const labels = (shortEntry?.labels || []).map((l) => `${l.tag}${l.pinned ? '(钉)' : ''}`);
          lines.push(`【${name}（${userId || '无QQ号'}）】`);
          if (mode === 'tag') {
            lines.push(`  标签：${labels.length ? labels.join(' · ') : '（还没有标签，可以用整理记忆生成）'}`);
            lines.push(`  长期记忆 ${longItems.length} 条、短期记忆 ${(shortEntry?.short || []).length} 条（要看原文用 mode=full）`);
            return;
          }
          if (longItems.length) {
            lines.push('  —— 长期（稳定）——');
            for (const it of longItems) {
              const meta = getLongMeta(ctx.chatKey, it.content) || {};
              const marks = [
                (meta.kind === 'appointment' || looksLikeAppointment(it.content)) ? '约定·用原文' : '',
                meta.pinned ? '红线·勿删' : '',
                Number(meta.hits) > 0 ? `提及×${meta.hits}` : '',
                it.createdAt ? stampOf(it.createdAt) : ''
              ].filter(Boolean).join('，');
              lines.push(`  · ${it.content}${marks ? `（${marks}）` : ''}`);
            }
          }
          const shorts = shortEntry?.short || [];
          if (shorts.length) {
            lines.push('  —— 短期（可能不准，会自动过期）——');
            const ttl = Math.max(1, Number(cfg().shortTtlDays) || 14);
            for (const s of shorts) {
              const hits = Math.max(0, Number(s.hits) || 0);
              lines.push(`  · ${s.content}（${kindLabel(s.kind)}${hits > 0 ? `，提及×${hits}` : ''}，${daysLeft(s.createdAt, ttl)} 天后过期）id=${s.id}`);
            }
          }
          if (!longItems.length && !shorts.length) lines.push('  （还没有任何记忆）');
        };

        if (wantId) {
          const long = longMembers.find((m) => String(m.userId) === wantId);
          pushOne(wantId, long?.name, long?.impressions || [], shortMap[wantId]);
        } else {
          const ids = new Set([...longMembers.map((m) => String(m.userId)), ...Object.keys(shortMap)]);
          if (!ids.size) return { content: '这个会话还没有任何记忆。' };
          for (const id of ids) {
            const long = longMembers.find((m) => String(m.userId) === String(id));
            pushOne(id, long?.name, long?.impressions || [], shortMap[id]);
          }
        }
        return { content: lines.join('\n') };
      } catch (error) {
        return { content: `查记忆失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 3. 晋升成长期记忆 ───────────────────────────────────────────────
  api.registerTool({
    id: 'promote_impression',
    name: '把短期记忆晋升为长期记忆',
    description: '把反复出现、你判断足够稳定的**短期记忆**晋升为**长期记忆**（写进群友档案，不再自动过期）。'
      + '先看提及次数：达到阈值才可信；只有一两次或只是今天的话题，别晋升。必须写理由。晋升后只能删，不能退回短期。',
    category: 'memory',
    icon: '⬆️',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: '关于谁的 QQ 号（必填）。' },
        shortId: { type: 'string', description: '要晋升的那条短期记忆的 id（recall_impression 的 mode=full 会给出）。与 content 二选一。' },
        content: { type: 'string', description: '直接给要写进长期记忆的正文（当你不是从短期列表里挑、而是要写一条新长期记忆时用）。' },
        reason: { type: 'string', description: '为什么它够稳（一句话）。会记在档案旁注里，供以后复查。' },
        force: { type: 'boolean', description: '提及次数还没到阈值但你仍然确定要晋升时，填 true。' },
        redline: { type: 'boolean', description: '红线/雷区类记忆填 true：标记为豁免，不参与过期下沉和 stale 清理。只用于不能再碰的明确禁忌，别滥用。' }
      },
      required: ['userId', 'reason']
    },
    async execute(ctx, args) {
      try {
        const userId = String(args?.userId || '').replace(/\D/g, '');
        if (!userId) return { content: '缺少 userId（QQ 号）', isError: true };
        const reason = trimText(args?.reason, 200);
        if (!reason) return { content: '缺少 reason：为什么它够稳？', isError: true };
        const minHits = Math.max(1, Number(cfg().promoteMinHits) || 3);
        const entry = getMember(ctx.chatKey, userId);
        let item = null;
        if (args?.shortId) item = (entry?.short || []).find((s) => s.id === String(args.shortId)) || null;
        if (!item && args?.content) {
          const want = trimText(args.content, 400);
          item = (entry?.short || []).find((s) => s.content === want) || null;
        }
        if (!item && !args?.content) {
          return { content: '没找到要晋升的短期记忆：请用 recall_impression（mode=full）拿到 id，或直接用 content 给出正文。', isError: true };
        }
        const hits = Math.max(0, Number(item?.hits) || 0);
        // 手工记的（提及为 0 也是人工确认过的）不卡阈值；模型记的才看提及次数
        const manual = item?.source === 'manual';
        if (item && !manual && hits < minHits && args?.force !== true) {
          return {
            content: `这条只被提到 ${hits} 次（阈值 ${minHits}），还不到该晋升的程度。`
              + '要么再观察一阵（重复调用 note_impression 累加次数），要么确认无误后带 force=true 重试。',
            isError: true
          };
        }
        const body = trimText(item?.content || args?.content, 300);
        if (!body) return { content: '要晋升的正文是空的', isError: true };
        if (typeof ctx?.memory?.append !== 'function') {
          return { content: '核心记忆不可写（拿不到 ctx.memory），这次晋升没做。', isError: true };
        }
        ctx.memory.append(ctx.chatKey, 'memberImpression', body, { userId, target: '' });
        let carried = hits;
        if (item) {
          const r = promoteShortItem(ctx.chatKey, userId, item.id, { reason, by: 'model' });
          if (r) carried = r.hits;
        } else {
          setLongMeta(ctx.chatKey, body, {
            kind: looksLikeAppointment(body) ? 'appointment' : 'general',
            reason,
            hits: 0
          });
        }
        if (args?.redline === true) setLongMeta(ctx.chatKey, body, { pinned: true });
        return {
          content: `已晋升为长期记忆：「${body}」（${carried > 0 ? `提及×${carried}` : '手工确认'}，理由：${reason}）。`
            + '这条不再会过期；以后引用它不需要加"最近""好像"。'
        };
      } catch (error) {
        return { content: `晋升失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 4. 删/降级记忆 ──────────────────────────────────────────────────
  api.registerTool({
    id: 'drop_impression',
    name: '删掉一条记忆（短期 / 长期）',
    description: '删掉不准确、已过时、或不该记的记忆。scope=short 只删短期（本插件管的），'
      + 'scope=long 从核心长期档案里删，scope=both 两边都删。'
      + '当本人纠正了你、或你发现自己记错了/把玩笑当真了时使用。',
    category: 'memory',
    icon: '🗑️',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要删掉的那条记忆的正文（可以只写其中一段，模糊匹配）。必填。' },
        userId: { type: 'string', description: '关于谁的 QQ 号，可选（填了更准）。' },
        scope: { type: 'string', enum: ['short', 'long', 'both'], description: '删哪一层：short 短期 / long 长期 / both 两边。默认 both。' }
      },
      required: ['content']
    },
    async execute(ctx, args) {
      try {
        const want = trimText(args?.content, 200);
        if (!want) return { content: '缺少 content：要删哪条？', isError: true };
        const scope = ['short', 'long', 'both'].includes(args?.scope) ? args.scope : 'both';
        const userId = String(args?.userId || '').replace(/\D/g, '');
        const notes = [];
        if (scope !== 'long') {
          const shortMap = chatMembers(ctx.chatKey);
          for (const [uid, entry] of Object.entries(shortMap)) {
            if (userId && uid !== userId) continue;
            for (const s of entry.short || []) {
              if (s.content.includes(want) || want.includes(s.content)) {
                if (removeShort(ctx.chatKey, uid, s.id)) notes.push(`短期：${s.content}`);
              }
            }
          }
        }
        if (scope !== 'short' && typeof ctx?.memory?.remove === 'function') {
          // 工具说明里承诺的是"可以只写其中一段"（模糊匹配），所以先自己把命中的原文
          // 找出来，再用**精确正文**去调核心的 remove —— 核心只认完全相等的 content。
          const map = chatMembers(ctx.chatKey) || {};
          const targets = userId ? [userId] : [...new Set(Object.keys(map))];
          if (!targets.length) targets.push('');
          for (const uid of targets) {
            let impressions = [];
            try {
              if (uid && typeof ctx.memory.getMember === 'function') {
                impressions = ctx.memory.getMember(ctx.chatKey, uid)?.impressions || [];
              }
              if (!impressions.length) {
                // 没有 getMember（或那个人读不到）就退回全量 members() 里找
                const all = safeMembers(ctx);
                impressions = uid
                  ? (all.find((m) => String(m.userId) === String(uid))?.impressions || [])
                  : all.flatMap((m) => m.impressions || []);
              }
            } catch (error) {
              verbose(`读取长期记忆失败（${uid}）：${error?.message ?? error}`);
            }
            for (const it of impressions) {
              const text = String(it?.content || '');
              if (!text) continue;
              if (!(text.includes(want) || want.includes(text))) continue;
              try {
                if (ctx.memory.remove(ctx.chatKey, 'memberImpression', { userId: uid, content: text })) {
                  notes.push(`长期：${uid || '某人'} 的「${text}」`);
                }
              } catch { /* 单条失败继续 */ }
            }
          }
        }
        if (!notes.length) return { content: `没找到包含「${want}」的记忆（可能本来就没有）。` };
        return { content: `已删除 ${notes.length} 条：\n${notes.map((n) => `- ${n}`).join('\n')}` };
      } catch (error) {
        return { content: `删除失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 5. 聊天记录检索 ─────────────────────────────────────────────────
  api.registerTool({
    id: 'search_archive',
    name: '检索聊天记录（时间 + 发送人 + 关键词）',
    description: '像聊天软件的「查找聊天记录」：按**时间范围＋发送人 QQ＋关键词**一次找相关消息，不用一页页翻。'
      + '群友问「上次说的那个」「前几天谁提过××」、要核实谁在什么时候说过、或写记忆记不清细节时用。三个条件都可选，全给是 AND。'
      + '本地没有的可 source=qq 问 QQ（只能翻页、只拿到最近几条）。',
    category: 'query',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: '关键词（原文子串匹配）。可选。' },
        sender: { type: 'string', description: '发送人 QQ 号，或填 self 表示机器人自己发的。可选。' },
        from: { type: 'string', description: '起始时间，如 "2026-10-01" 或 "2026-10-01 14:30"。可选。' },
        to: { type: 'string', description: '结束时间，同格式（只写日期表示当天 23:59）。可选。' },
        limit: { type: 'number', description: '最多返回几条命中（默认 30，最大 200）。' },
        context: { type: 'number', description: '每条命中额外带回前后几条上下文（0~5，默认 0）。' },
        source: { type: 'string', enum: ['local', 'qq', 'auto'], description: 'local 只查本地存档（快、全）；qq 直接问 QQ；auto 本地不够时再问 QQ。默认 local。' },
        chatKey: { type: 'string', description: '要查哪个会话，如 group:123456。只有主人私聊里能查别的会话；默认查当前会话。' }
      }
    },
    async execute(ctx, args) {
      try {
        const targetKey = String(args?.chatKey || '').trim() || String(ctx.chatKey || '');
        if (targetKey !== String(ctx.chatKey) && !canQueryOtherChats(ctx)) {
          return { content: '只能查当前会话的聊天记录（跨会话检索请在主人的私聊里用）。', isError: true };
        }
        if (!/^(group|private):\d+$/.test(targetKey)) {
          return { content: `会话标识不对：${targetKey}（应该形如 group:123 或 private:456）`, isError: true };
        }
        const opts = {
          keyword: args?.keyword,
          sender: args?.sender,
          from: args?.from,
          to: args?.to,
          limit: args?.limit,
          context: args?.context
        };
        const source = ['local', 'qq', 'auto'].includes(args?.source) ? args.source : 'local';
        let local = null;
        if (source !== 'qq') local = searchLocalArchive(targetKey, opts);

        const needQq = source === 'qq' || (source === 'auto' && (!local?.ok || (local.matched || 0) < Math.min(3, Number(opts.limit) || 3)));
        let qq = null;
        if (needQq) qq = await queryQqHistory(ctx, targetKey, opts);

        const parts = [];
        if (local?.ok && local.matched) {
          parts.push(`本地存档命中 ${local.matched} 条（存档共 ${local.scanned} 条，范围 ${local.range.firstAt} ~ ${local.range.lastAt}），列出最近 ${local.returned} 条：`);
          if (local.range.from || local.range.to) parts.push(`（筛选范围：${local.range.from || '不限'} ~ ${local.range.to || '不限'}）`);
          for (const m of local.messages) {
            parts.push(`[${m.time}] ${m.senderName}(${m.senderId})#${m.mid ?? '-'}：${m.text}${m.recalled ? '（已撤回）' : ''}`);
            if (m.context?.length) {
              parts.push(`    · 上下文：${m.context.map((c) => `${c.senderName}：${c.text}`).join(' | ')}`);
            }
          }
        } else if (local && !local.ok) {
          parts.push(`本地存档：${local.error}`);
        } else if (local) {
          parts.push(`本地存档里没有符合条件的消息（存档共 ${local.scanned} 条，范围 ${local.range.firstAt} ~ ${local.range.lastAt}）。`);
        }
        if (qq) {
          if (qq.ok) {
            parts.push(`QQ 侧记录命中 ${qq.matched} 条（共取回 ${qq.fetched} 条，只能按条数往前翻，不含时间筛选）：`);
            for (const m of qq.messages) parts.push(`[${m.time}] ${m.senderName}(${m.senderId})：${m.text}`);
          } else {
            parts.push(`QQ 侧记录取回失败：${qq.error}`);
          }
        }
        const text = parts.join('\n') || '没有找到相关聊天记录。';
        return { content: `${text}\n\n（引用时请照实说"记录里是这么写的"，不要改写成自己的记忆。）` };
      } catch (error) {
        return { content: `检索失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 6. 拿不准 → 主动问主人 ──────────────────────────────────────────
  api.registerTool({
    id: 'ask_owner',
    name: '拿不准就问主人（私聊）',
    description: '当你对某条记忆的判定实在拿不准（该不该记、是不是玩笑、该不该晋升、记错了会不会冒犯），'
      + '可以直接私聊问主人，而不是自己硬猜。问题要具体、给出选项，方便主人一句话回答。'
      + '别拿鸡毛蒜皮的小事问；主人没配 QQ 号时这个工具会告诉你改用保守做法。',
    category: 'memory',
    icon: '📮',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: '要问主人的问题，一句话说清上下文。例如"张三说他下周要考研，这条该记成长期记忆吗？"' },
        userId: { type: 'string', description: '这条判定是关于谁的 QQ 号，可选。' },
        shortId: { type: 'string', description: '牵涉到的短期记忆 id，可选（主人回答后便于自动落定）。' }
      },
      required: ['question']
    },
    async execute(ctx, args) {
      try {
        const question = trimText(args?.question, 300);
        if (!question) return { content: '缺少 question', isError: true };
        const owner = ownerId();
        if (!owner || cfg().ownerAskEnabled === false) {
          return {
            content: '现在问不了主人（主人的 QQ 号没配，或主动询问被关掉了）。请按保守规则处理：'
              + '拿不准的记忆先记成短期记忆、不要晋升；有冒犯风险的就先不要记。'
          };
        }
        if (isOwnerPrivateKey(ctx.chatKey)) {
          return { content: '你正在主人的私聊里 —— 直接问他本人就行，不用再发一条私聊。' };
        }
        const cooldownMin = Math.max(1, Number(cfg().askCooldownMinutes) || 120);
        const ownerChat = `private:${owner}`;
        const asks = listQuestions(ownerChat);
        const last = asks.reduce((n, q) => Math.max(n, Number(q.askedAt) || 0), 0);
        if (Date.now() - last < cooldownMin * 60000) {
          const wait = Math.ceil((cooldownMin * 60000 - (Date.now() - last)) / 60000);
          return {
            content: `刚才已经问过主人一次了（${wait} 分钟后才能再问）。这次请自己按保守规则处理：`
              + '记成短期记忆、不要晋升，等下次再说。'
          };
        }
        if (typeof ctx?.sender?.sendTextBatch !== 'function') {
          return { content: '发送通道不可用，这次没问成。请自行保守处理。', isError: true };
        }
        const userId = String(args?.userId || '').replace(/\D/g, '');
        const q = addQuestion(ownerChat, {
          userId,
          name: '',
          shortId: String(args?.shortId || ''),
          question: `${question}（来自 ${ctx.chatKey}）`
        });
        await ctx.sender.sendTextBatch(ownerChat, [
          `【记忆判定求助】${question}`,
          `（你不方便一句话答的话，直接回我就行，我会按你的意思落定。编号 ${q.id}）`
        ]);
        return {
          content: `已经把问题私聊发给主人了（编号 ${q.id}）。这一条先按保守做法处理：记成短期记忆、不晋升；`
            + '主人回复后你再据他的意思落定，并调 resolve_owner_answer 汇报结论。不要在这个群里提"我去问主人了"。'
        };
      } catch (error) {
        return { content: `问主人失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 7. 落定主人的答复 ───────────────────────────────────────────────
  api.registerTool({
    id: 'resolve_owner_answer',
    name: '落定主人的答复',
    description: '主人回答了你之前的记忆判定问题后，用这个工具把结论登记下来（并顺手把该记的记上、该删的删掉）。'
      + '当【记忆判定 · 主人已经回答你了】里出现问题时，处理完必须调它汇报，否则那条问题会一直挂在"待裁决"里。',
    category: 'memory',
    icon: '✅',
    parameters: {
      type: 'object',
      properties: {
        questionId: { type: 'string', description: '问题编号（形如 q...），在提示词里给出。' },
        decision: { type: 'string', description: '结论一句话：主人是怎么定的。' },
        action: { type: 'string', enum: ['none', 'promote', 'keep-short', 'drop'], description: '你实际做的处理：none 只登记 / promote 已晋升 / keep-short 保持短期 / drop 已删除。' }
      },
      required: ['questionId', 'decision']
    },
    async execute(ctx, args) {
      try {
        const id = trimText(args?.questionId, 60);
        if (!id) return { content: '缺少 questionId', isError: true };
        const owner = ownerId();
        const candidates = [];
        if (owner) candidates.push(`private:${owner}`);
        if (ctx?.kind === 'private' && /^\d+$/.test(String(ctx?.chatId || ''))) candidates.push(`private:${ctx.chatId}`);
        candidates.push(String(ctx?.chatKey || ''));
        let q = null;
        for (const key of [...new Set(candidates)].filter(Boolean)) {
          q = resolveQuestion(key, id, args?.decision, { action: args?.action || 'none' });
          if (q) break;
        }
        if (!q) return { content: `没找到编号 ${id} 的问题（可能已经被处理过了）。`, isError: true };
        return { content: `已登记结论：「${q.decision}」（处理方式：${args?.action || 'none'}）。这条问题不再挂在待裁决里。` };
      } catch (error) {
        return { content: `登记失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 8. 整理记忆 ─────────────────────────────────────────────────────
  api.registerTool({
    id: 'consolidate_memory',
    name: '整理记忆（压缩标签 / 判定晋升 / 从聊天记录提取）',
    description: '对本会话做一次完整的记忆整理，四件事一起做：'
      + '① 删掉过期且没晋升的短期记忆；'
      + '② 把每个人现有的长期+短期记忆压缩成几个短标签（原文不删，随时可展开）；'
      + '③ 判定哪些短期记忆够稳、可以晋升成长期；'
      + '④ 回看最近的聊天记录，挑出值得记住的内容转成短期记忆。'
      + '当用户说"整理一下记忆"、或提示词里出现多条"⚑建议晋升"、或短期记忆堆得比较多时调用。'
      + '整理会花一次模型调用的钱，别频繁调。',
    category: 'memory',
    icon: '🧹',
    parameters: {
      type: 'object',
      properties: {
        extract: { type: 'boolean', description: '是否顺便从聊天记录里提取新记忆（默认按插件设置）。' },
        judge: { type: 'boolean', description: '是否让模型判定晋升候选（默认 true）。' }
      }
    },
    async execute(ctx, args) {
      try {
        const r = await consolidateChat(ctx, {
          extract: args?.extract,
          judge: args?.judge !== false,
          apply: true
        });
        return { content: r.summary, isError: r.ok === false };
      } catch (error) {
        return { content: `整理失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 9. 面板动作通道 ────────────────────────────────────────────────
  // 0.5 没有 0.4 的 registerPluginRoutes，自带面板拿不到 HTTP 动作。
  // 面板只能经 /api/panels/<id>/call 调本插件的工具，所以把 handleAction
  // 原样包一层暴露出来：面板读快照、触发整理、改标签都走这里。
  // 模型侧不要调用（描述里已写明），即便调也只是同样的记忆操作，无害。
  api.registerTool({
    id: 'panel_api',
    name: '面板动作通道（仅供控制台面板）',
    description: '把「记忆与存档优化」自带控制台面板的动作暴露给面板。仅面板调用，模型不要使用；参数 action 取 snapshot/overview/status/consolidate/prune-preview/sweep-now/export-snapshot 等，body 传该动作的参数。',
    category: 'memory',
    icon: '🖥',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', description: '动作名，例如 snapshot、consolidate、sweep-now。' },
        body: { type: 'object', description: '传给动作的参数对象，例如 { chatKey, userId }。', additionalProperties: true }
      },
      required: ['action']
    },
    async execute(ctx, args) {
      const key = String((args && args.action) || '').trim();
      if (!key) return { content: JSON.stringify({ ok: false, error: '缺少 action' }), isError: true };
      try {
        const out = await handleAction(key, (args && args.body) || {}, ctx);
        return { content: JSON.stringify(out && out.body ? out.body : out) };
      } catch (error) {
        return { content: JSON.stringify({ ok: false, error: String(error?.message ?? error) }), isError: true };
      }
    }
  });

  // ── 10. 主人一句话改称呼 ────────────────────────────────────────────
  api.registerTool({
    id: 'rename_member',
    name: '改对某人的称呼',
    description: '主人明确指定称呼时用：把这个人档案里的名字换成新称呼（旧名自动进别名），画像里加一条「称呼：xx」，'
      + '之后所有会话都按新称呼叫他。主人怎么说都行（"叫1825382281为蜥蜴哥哥""把某用户叫老木""他外号是阿明"），'
      + '你只负责填 who 和 name。群友自己说"叫我大哥"、互相起外号、玩梗、角色扮演，一律不调。',
    category: 'memory',
    icon: '✏️',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '改谁：QQ 号最稳；也可以填档案里的名字或别名（如"某用户"）。' },
        name: { type: 'string', description: '新称呼（2~8 个字最好，不超过 20 字）。' }
      },
      required: ['who', 'name']
    },
    async execute(ctx, args) {
      try {
        const pdir = profileDirResolved(cfg());
        const who = resolveMember(pdir, args?.who);
        if (!who.ok) return { content: who.error, isError: true };
        const out = applyRename(pdir, { uid: who.uid, name: args?.name, chatKey: ctx?.chatKey || '' });
        if (!out.ok) return { content: `没改成：${out.error}`, isError: true };
        return { content: out.text };
      } catch (error) {
        return { content: `改称呼失败：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 11. 主人交代的一条确定事实 ──────────────────────────────────────
  api.registerTool({
    id: 'remember_fact',
    name: '记下主人交代的事实',
    description: '主人明确交代要记住某人的某件事时用（"记住1825382281喜欢半夜打游戏""记一下某用户生日是5月1日"）：'
      + '直接写进长期结论层，置信度 95，提示词里排在所有普通结论前面，不吃时效、不会被自动降级。'
      + '猜测、听说、玩笑、群友自己说的，一律不用这个——那些走 note_impression 攒次数。',
    category: 'memory',
    icon: '📌',
    parameters: {
      type: 'object',
      properties: {
        who: { type: 'string', description: '关于谁：QQ 号最稳，也可以填档案里的名字或别名。' },
        fact: { type: 'string', description: '要记住的那件事，一句话，主语写清楚（"他喜欢半夜打游戏"）。' },
        kind: { type: 'string', enum: ['fact', 'appointment', 'relation', 'preference', 'correction'], description: '事实 / 约定 / 关系 / 偏好 / 纠正雷区，默认 fact。约定类要带时间。' }
      },
      required: ['who', 'fact']
    },
    async execute(ctx, args) {
      try {
        const pdir = profileDirResolved(cfg());
        const who = resolveMember(pdir, args?.who);
        if (!who.ok) return { content: who.error, isError: true };
        const out = applyFact(pdir, { uid: who.uid, text: args?.fact, kind: args?.kind, chatKey: ctx?.chatKey || '' });
        if (!out.ok) return { content: `没记上：${out.error}`, isError: true };
        return { content: out.text };
      } catch (error) {
        return { content: `记事实失败：${error?.message ?? error}`, isError: true };
      }
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
// 工具内部用到的辅助
// ══════════════════════════════════════════════════════════════════════

/**
 * 拿核心的长期记忆。
 *   工具路径：ctx.memory 是**活的核心实例**，直接问它（最准）。
 *   面板路径（整理任务）：没有 ctx，就从磁盘读 —— 只读，不碰核心的内存缓存，
 *   所以不存在"写了被复活"的问题。少了这一条，面板点整理会看到"压缩标签 0 人"
 *   （因为它根本看不到长期记忆）。
 */
function safeMembers(ctx) {
  try {
    if (typeof ctx?.memory?.members === 'function') return ctx.memory.members(ctx.chatKey) || [];
  } catch (error) {
    verbose(`读核心记忆失败：${error?.message ?? error}`);
  }
  return readLongMembersFromDisk(ctx?.chatKey);
}

/** 只读磁盘上的长期记忆（data/memory/<会话>/<QQ>.json）。 */
function readLongMembersFromDisk(chatKey) {
  const key = String(chatKey || '');
  if (!key) return [];
  const dir = path.join(dataDirRoot(), 'memory', key.replace(/[^a-z0-9_]/gi, '_'));
  const out = [];
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_meta.json');
  } catch {
    return [];
  }
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (!raw) continue;
      const impressions = Array.isArray(raw.impressions)
        ? raw.impressions.map((e) => ({ content: String(e?.content || ''), createdAt: Number(e?.createdAt) || 0 })).filter((e) => e.content)
        : [];
      if (!impressions.length) continue;
      out.push({
        userId: String(raw.userId || f.replace(/\.json$/, '')),
        name: String(raw.name || ''),
        impressions,
        updatedAt: Number(raw.updatedAt) || 0
      });
    } catch { /* 坏文件跳过 */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 直接问 QQ 要最近的聊天记录（OneBot 的 history 接口没有时间/发送人筛选，只能取回后自己筛）。 */
async function queryQqHistory(ctx, chatKey, opts = {}) {
  try {
    if (typeof ctx?.onebot?.call !== 'function') return { ok: false, error: 'OneBot 通道不可用' };
    const [kind, id] = chatKey.split(':');
    const count = Math.min(200, Math.max(10, Number(opts.limit) || 30) * 3);
    const params = kind === 'group'
      ? { group_id: Number(id), count, reverse_order: true }
      : { user_id: Number(id), count, reverse_order: true };
    const action = kind === 'group' ? 'get_group_msg_history' : 'get_friend_msg_history';
    const data = await ctx.onebot.call(action, params);
    const list = Array.isArray(data) ? data : (data?.messages || []);
    const from = parseTime(opts.from, { endOfDay: false });
    const to = parseTime(opts.to, { endOfDay: true });
    const sender = String(opts.sender || '').trim();
    const keyword = String(opts.keyword || '').trim();
    const messages = [];
    for (const m of list) {
      const ts = Number(m?.time) * 1000 || Number(m?.timestamp) * 1000 || 0;
      const uid = String(m?.sender?.user_id ?? m?.user_id ?? '');
      const name = String(m?.sender?.card || m?.sender?.nickname || m?.sender?.name || uid);
      const text = typeof m?.message === 'string' ? m.message : String(m?.raw_message ?? m?.message ?? '');
      if (from !== null && ts && ts < from) continue;
      if (to !== null && ts && ts > to) continue;
      if (sender && sender !== 'self' && uid !== sender) continue;
      if (keyword && !text.includes(keyword)) continue;
      messages.push({ time: stampOf(ts || Date.now()), senderId: uid, senderName: name, text: trimText(text, 300) });
      if (messages.length >= Math.min(60, Number(opts.limit) || 30)) break;
    }
    return { ok: true, fetched: list.length, matched: messages.length, messages };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 整理一个会话。两个调用方：
 *   · 工具 consolidate_memory（有 ctx：能读存档、能写核心长期记忆）
 *   · 控制台面板的整理任务（没有 ctx：只做短期侧与标签，晋升结果交给面板写回核心）
 * @param {object} ctx 至少要有 chatKey
 * @param {{extract?:boolean|null, judge?:boolean, apply?:boolean, onProgress?:Function}} opts
 */
async function consolidateChat(ctx, { extract = null, judge = true, apply = true, days = null, userIds = null, onProgress = null } = {}) {
  const chatKey = ctx.chatKey;
  // 只整理指定的人（面板「整理他」）：其余成员既不压标签、也不吃提取结果
  const onlyIds = Array.isArray(userIds)
    ? new Set(userIds.map((u) => String(u ?? '').replace(/\D/g, '')).filter(Boolean))
    : null;
  const onlyOn = onlyIds && onlyIds.size ? onlyIds : null;
  const c = cfg();
  // 档案层目录：整理出来的长期结论/标签同步写这里（一人一份、跨会话合并）
  const pdir = profileDirResolved(c);
  const now = Date.now();
  const result = {
    ok: true,
    summary: '',
    promotions: [],
    labels: [],
    traits: [],
    expired: { removed: 0 },
    extracted: 0,
    extractSkipped: false,
    diagnostics: []
  };
  const step = (label, i, total) => {
    try { onProgress?.({ label, step: i, total }); } catch { /* 进度回调失败不影响整理 */ }
  };
  let rateLimited = 0;

  // ① 过期清理
  step('清理过期短期记忆', 0, 1);
  const ex = expireShort(c.shortTtlDays, now);
  result.expired = ex;

  const longMembers = safeMembers(ctx);
  const ids = new Set([...longMembers.map((m) => String(m.userId)), ...Object.keys(chatMembers(chatKey))]
    .filter((uid) => !onlyOn || onlyOn.has(String(uid))));

  // ④ 从聊天记录里提取（先做，提取出来的会被后面的标签/晋升一起考虑）
  const doExtract = extract === null ? c.consolidateExtractFromArchive !== false : extract === true;
  if (doExtract) {
    const lookDays = Math.min(30, Math.max(1, Number(days != null && days !== '' ? days : c.consolidateDays) || 3));
    step(`回看聊天记录（${lookDays === 1 ? '今天' : '最近 ' + lookDays + ' 天'}）`, 0, 1);
    const scan = Math.min(2000, Math.max(20, Number(c.consolidateArchiveScanCount) || 120));
    const ex2 = await extractFromArchive(ctx, { scan, days: lookDays, settings: c });
    if (ex2.error) result.diagnostics.push(`从聊天记录提取失败：${ex2.error}`);
    if (ex2.skipped) result.extractSkipped = true;
    for (const it of ex2.items) {
      if (!it.userId || !it.content) continue;
      if (onlyOn && !onlyOn.has(String(it.userId))) continue;
      try {
        const kind = KINDS.includes(it.kind) ? it.kind : (looksLikeAppointment(it.content) ? 'appointment' : 'general');
        addShort(chatKey, it.userId, it.name || '', {
          content: it.content,
          kind,
          source: 'archive'
        });
        // 档案层：先进候选（第二次出现或模型高置信才晋升），避免一次提取就写死画像
        try {
          ingestObservation(pdir, it.userId, chatKey, {
            content: it.content, kind, confidence: Number(it.confidence) || (kind === 'appointment' ? 85 : 65),
            name: it.name || '', minHits: Number(c.promoteMinHits) || 3, evidence: it.evidence || ''
          });
        } catch (error2) { verbose(`档案候选写入失败：${error2?.message ?? error2}`); }
        result.extracted += 1;
        ids.add(String(it.userId));
      } catch (error) {
        verbose(`提取的记忆没记上：${error?.message ?? error}`);
      }
    }
    if (!ex2.items.length && ex2.note) result.diagnostics.push(ex2.note);
  }

  // ② ③ 逐人压缩标签 + 判定晋升
  const pending = [...ids].filter((uid) => {
    const long = longMembers.find((m) => String(m.userId) === String(uid));
    const entry = chatMembers(chatKey)[uid];
    return (long?.impressions?.length || 0) + ((entry?.short || []).length) > 0;
  });
  let tagCount = 0;
  let i = 0;
  let queued = 0;
  for (const uid of pending) {
    i += 1;
    step(`整理第 ${i}/${pending.length} 个人`, i, pending.length);
    try {
      const long = longMembers.find((m) => String(m.userId) === String(uid));
      const entry = chatMembers(chatKey)[uid] || { short: [], labels: [] };
      const shorts = entry.short || [];
      const labels = entry.labels || [];
      let tags = labels.filter((l) => l.pinned).map((l) => l.tag);
      let promotes = [];
      let traits = [];
      let judgeFailed = false;
      if (judge) {
        const judged = await judgeMember({
          name: entry.name || long?.name || uid,
          long: long?.impressions || [],
          shorts,
          maxTags: Math.max(1, Number(c.labelsPerMember) || 6),
          settings: c
        });
        judgeFailed = !!judged.error;
        if (judged.error) {
          result.diagnostics.push(`${entry.name || uid}：${judged.error}`);
          if (judged.rateLimited) rateLimited += 1;
        }
        // ── 限流：剩下的**不在这里硬顶**，转成"30 秒一个人"的排队任务 ──
        if (judged.rateLimited && i < pending.length) {
          const rest = pending.slice(i - 1);      // 含当前这个人（它的标签这次没拿到）
          setLabelQueue(chatKey, rest, {
            done: [...result.labels.filter((l) => l.tags.length).map((l) => l.userId)],
            failed: [],
            delayMs: 30000                            // 刚被限流过，先歇 30 秒再开工
          });
          queued = rest.length;
          startLabelQueueTimer(chatKey);
          break;
        }
        if (judged.tags.length) {
          tags = [...new Set([...tags, ...judged.tags])].slice(0, Math.max(1, Number(c.labelsPerMember) || 6));
        }
        promotes = judged.promote || [];
        traits = judged.traits || [];
        // 逐个人串行调模型时稍微让一下，别把网关的 rps 打爆（打爆了整批标签都是空的）
        if (i < pending.length) await sleep(350);
      }
      if (apply) {
        // ⚠️ 只有模型**真的给出结果**时才重写标签。失败时一个字都不动 ——
        //    否则一次限流就会把用户已有的标签洗掉（pinned 之外的会被覆盖）。
        if (tags.length && !judgeFailed) {
          setLabels(chatKey, uid, tags, { sourceIds: shorts.map((s) => s.id) });
          // 档案层同步标签（同义合并、上限 12，跨会话累加）
          try { setProfileTags(pdir, uid, chatKey, tags, { name: entry.name || long?.name || '' }); }
          catch (error2) { verbose(`档案标签写入失败：${error2?.message ?? error2}`); }
          tagCount += tags.length;
        }
        // 性格总结：整理流程接手原情绪画像的职责，把多条记忆支撑的稳定性格写进人物画像
        if (!judgeFailed && traits.length) {
          for (const tr of traits) {
            try {
              addTrait(pdir, uid, chatKey, {
                text: tr.text,
                dim: tr.dim || '性格',
                confidence: Number(tr.confidence) || 80,
                name: entry.name || long?.name || ''
              });
              result.traits.push({ userId: uid, name: entry.name || long?.name || uid, text: tr.text, confidence: tr.confidence });
            } catch (error2) { verbose(`性格画像写入失败：${error2?.message ?? error2}`); }
          }
        }
        result.labels.push({ userId: uid, name: entry.name || long?.name || uid, tags: judgeFailed ? [] : tags });
      }
      for (const p of promotes) {
        const s = shorts.find((x) => x.id === String(p.shortId));
        if (!s) continue;
        const hits = Math.max(0, Number(s.hits) || 0);
        const minHits = Math.max(1, Number(c.promoteMinHits) || 3);
        const manual = s.source === 'manual';
        // 手工记的（人工确认过）可以直接晋升；模型记的要看次数或模型自己的把握
        if (!manual && hits < minHits && Number(p.confidence) < 75) continue;
        const body = trimText(s.content, 300);
        // 档案层先记：面板任务没有 ctx（也拿不到 memory.append），但档案层不依赖宿主
        if (apply) {
          try {
            addLongTerm(pdir, uid, chatKey, {
              content: body,
              kind: s.kind === 'appointment' ? 'appointment' : (KINDS.includes(s.kind) ? s.kind : 'general'),
              confidence: Math.max(70, Number(p.confidence) || 0),
              source: 'consolidate',
              name: entry.name || long?.name || ''
            });
          } catch (error2) { verbose(`档案长期写入失败：${error2?.message ?? error2}`); }
        }
        if (apply && typeof ctx?.memory?.append === 'function') {
          try {
            ctx.memory.append(chatKey, 'memberImpression', body, { userId: uid, target: '' });
            promoteShortItem(chatKey, uid, s.id, { reason: p.reason || '整理时判定稳定', by: 'consolidate' });
          } catch (error) {
            result.diagnostics.push(`晋升写回失败（${uid}）：${error?.message ?? error}`);
          }
        }
        result.promotions.push({
          userId: uid,
          name: entry.name || long?.name || uid,
          shortId: s.id,
          content: body,
          hits,
          reason: String(p.reason || '整理时判定稳定'),
          confidence: Number(p.confidence) || 0
        });
      }
    } catch (error) {
      result.diagnostics.push(`整理 ${uid} 时出错：${error?.message ?? error}`);
    }
  }

  // ⑤ 交叉验证：把本会话多个人的记忆放在一起核对（矛盾 / 归属错 / 重复 / 单向关系）。
  //    只出报告写到 <会话>/_交叉验证.json，绝不自动改记忆 —— 误判一次就会删掉真记忆。
  let cross = { issues: [] };
  if (apply && c.crossCheckEnabled !== false) {
    step('交叉验证多人记忆', 0, 1);
    cross = await crossCheck(chatKey, { settings: c, longMembers: safeMembers(ctx), apply });
    if (cross.error) result.diagnostics.push(`交叉验证失败：${cross.error}`);
  }
  result.crossCheck = { issues: cross.issues || [], note: cross.note || '', error: cross.error || '' };

  if (apply) {
    step('补全记忆条目的主语', 0, 0);
    result.subjectFixed = fixShortSubjects(chatKey);
    setLastConsolidated(chatKey, now);
    chatFlags(chatKey, { pendingConsolidateAt: 0 });
  }

  // 记忆降级（遗忘曲线）：按设置里的天数把久未复核的长期回候选、画像回长期；0 = 不动
  try {
    const dl = Number(c.demoteLongDays) || 0;
    const dt = Number(c.demoteTraitDays) || 0;
    if (dl || dt) result.demoted = demoteStale(pdir, { longDays: dl, traitDays: dt });
  } catch (error) {
    verbose(`自动降级失败：${error && error.message ? error.message : error}`);
  }

  const lines = [
    `整理完成（${chatKey}）：`,
    `· 过期删除短期记忆 ${ex.removed} 条`,
    `· 压缩标签 ${result.labels.filter((l) => l.tags.length).length} 人 / ${tagCount} 个标签`,
    `· 更新人物性格 ${result.traits.length} 条${result.traits.length ? `：${result.traits.map((t) => `${t.name}—${t.text}`).join('；')}` : ''}`,
    `· 晋升为长期记忆 ${result.promotions.length} 条${result.promotions.length ? `：${result.promotions.map((p) => p.content).join('；')}` : ''}`,
    `· 从聊天记录新增短期记忆 ${result.extracted} 条${result.extractSkipped ? '（这段没筛到关键句，提取这一步跳过、不花调用）' : ''}`,
    `· 补全主语 ${result.subjectFixed || 0} 条（"喜欢打游戏"这类没主语的句子，改成"某人喜欢打游戏"）`,
    ...(result.demoted && (result.demoted.long || result.demoted.trait)
      ? [`· 按设置降级：长期 ${result.demoted.long} 条 → 候选，画像 ${result.demoted.trait} 条 → 长期（扫了 ${result.demoted.scanned} 人）`]
      : []),
    `· 交叉验证 ${(result.crossCheck.issues || []).length} 处疑点${(result.crossCheck.issues || []).length ? '（明细见该会话文件夹的 _交叉验证.json）' : ''}`
  ];
  if (queued) {
    lines.push(`· 模型通道限流（429）：剩下 ${queued} 个人已转入排队模式，**每 30 秒处理一个**，进度和失败名单就在右上角状态区里（不用守着，可以切走）。`);
  } else if (rateLimited) {
    lines.push(`· 模型通道在限流（429）：有 ${rateLimited} 个人的标签这次没生成，等一分钟再点一次「整理本记忆」即可（其余部分已经做完）。`);
  }
  if (result.diagnostics.length) {
    lines.push(`· 需要留意：${result.diagnostics.slice(0, 3).join('；')}`);
  }
  result.summary = lines.join('\n');
  result.queued = queued;
  return result;
}

// ── 标签压缩队列：限流后 30 秒一个人，直到做完 ──────────────────────────
//
// 为什么要有它：批量压缩是"一个人一次模型调用"，网关限流时整批都会空。
// 队列写进了 state.json，所以热重载/重启后 activate 会接着跑完。
function startLabelQueueTimer(chatKey) {
  labelQueueChat = String(chatKey || labelQueueChat || '');
  if (labelQueueTimer) return;
  const tick = async () => {
    labelQueueTimer = null;
    try {
      await runLabelQueueOnce();
    } catch (error) {
      warn(`标签队列执行失败：${error?.message ?? error}`);
    }
    // 还有人就排下一次
    const still = labelQueueChat ? getLabelQueue(labelQueueChat) : { uids: [] };
    if (still.uids.length) {
      const wait = Math.max(1000, (still.nextAt || 0) - Date.now());
      labelQueueTimer = setTimeout(tick, wait);
      labelQueueTimer.unref?.();
    } else {
      labelQueueChat = '';
      refreshSnapshotSoon();
    }
  };
  // 第一次也等一下（刚被限流过，立刻再打还是会被拒）
  const q0 = getLabelQueue(labelQueueChat);
  const wait0 = Math.max(1000, (q0.nextAt || 0) - Date.now());
  labelQueueTimer = setTimeout(tick, wait0 || 30000);
  labelQueueTimer.unref?.();
}

/** 处理队列里的第一个人（一次一个）。 */
async function runLabelQueueOnce() {
  const chatKey = labelQueueChat;
  if (!chatKey) return;
  const q = getLabelQueue(chatKey);
  const uid = q.uids[0];
  if (!uid) return;
  const c = cfg();
  const entry = getMember(chatKey, uid) || { short: [], labels: [] };
  const long = readLongFromDisk(chatKey, uid);
  const judged = await judgeMember({
    name: long.name || entry.name || uid,
    long: long.impressions,
    shorts: entry.short,
    maxTags: Math.max(1, Number(c.labelsPerMember) || 6),
    settings: c
  });
  if (judged.error) {
    const r = shiftLabelQueue(chatKey, { error: judged.error });
    noteOperation(false, `标签队列：${long.name || uid} 失败（${judged.error}）`);
    // 限流导致的失败：留在队列里下次再试，不记成"失败名单"
    if (judged.rateLimited) {
      const cur = getLabelQueue(chatKey);
      // 把它放回队首（shiftLabelQueue 已经摘掉了），并把 nextAt 推后
      setLabelQueue(chatKey, [uid, ...cur.uids], { done: cur.done, failed: cur.failed.filter((f) => f.userId !== uid) });
    }
    void r;
  } else {
    const keep = (entry.labels || []).filter((l) => l.pinned).map((l) => l.tag);
    const tags = [...new Set([...keep, ...judged.tags])].slice(0, Math.max(1, Number(c.labelsPerMember) || 6));
    if (tags.length) setLabels(chatKey, uid, tags, { sourceIds: (entry.short || []).map((s) => s.id) });
    shiftLabelQueue(chatKey, { result: tags.join('·') });
    noteOperation(true, `标签队列：${long.name || uid} 完成（${tags.join(' · ') || '模型没给标签'}）`);
  }
  refreshSnapshotSoon();
}

/** 手动把某个会话的所有人排进标签队列。 */
function enqueueAllLabels(chatKey) {
  const long = readLongMembersFromDisk(chatKey);
  const uids = [...new Set([...long.map((m) => String(m.userId)), ...Object.keys(chatMembers(chatKey))])].filter(Boolean);
  setLabelQueue(chatKey, uids, { done: [], failed: [] });
  startLabelQueueTimer(chatKey);
  return uids.length;
}

/** 让出一点时间（不阻塞进程退出）。 */
function sleep(ms) {
  return new Promise((resolve) => { const t = setTimeout(resolve, Math.max(0, Number(ms) || 0)); t.unref?.(); });
}

/**
 * 让模型把某人的记忆压成标签 + 判晋升。
 * 返回 {tags, promote, raw, error}：**永远不抛错**，失败也把原因带回去（否则界面只会"点了没反应"）。
 */
async function judgeMember({ name, long = [], shorts = [], maxTags = 6, settings = {} }) {
  const longLines = long.slice(0, 20).map((e) => `- ${trimText(e.content, 300)}`).join('\n');
  const shortLines = shorts.slice(0, 20)
    .map((s) => `- [id=${s.id} 提及×${Math.max(0, Number(s.hits) || 0)} ${kindLabel(s.kind)}] ${trimText(s.content, 300)}`)
    .join('\n');
  if (!longLines && !shortLines) return { tags: [], promote: [], traits: [], raw: '', error: '' };
  const messages = [
    {
      role: 'system',
      content: '你是聊天机器人的记忆整理模块。只做"压缩"和"判断"，绝不发明新事实、不许推测没写的内容。'
        + '输出必须是严格的 JSON 对象，不要任何解释文字、不要 markdown 代码块。格式：'
        + '{"tags":["短词1","短词2"],"promote":[{"shortId":"s1","reason":"为什么够稳","confidence":0-100}],'
        + '"traits":[{"text":"…","dim":"性格","confidence":0-100}]}'
    },
    {
      role: 'user',
      content: `关于「${name}」现有记忆：\n`
        + `【长期（已确认、稳定）】\n${longLines || '（暂无）'}\n`
        + `【短期（临时观察，带提及次数）】\n${shortLines || '（暂无）'}\n\n`
        + `请输出 JSON：\n`
        + `1) tags：不超过 ${maxTags} 个"刻板印象"式短标签（每个 2~6 个汉字，如"嘴硬""夜猫子""爱发图"），用于让人一眼抓住这个人；不要整句、不要标点。\n`
        + `2) promote：从上面的短期记忆里挑出**确实已经稳定**的（提及次数高、与长期记忆一致、是稳定特征/真实约定，而不是一时的话题或情绪），`
        + `最多 3 条。confidence 是你对"它就是稳定特征"的把握（0~100）。拿不准就不要放进 promote。\n`
        + `3) traits：总结这个人的性格，最多 2 条，每条 15~40 字，写稳定的性格/说话风格/处事方式，不写具体事件、不写评价性辱骂、不写"可能/也许"。`
        + `必须有多条长期或短期记忆互相支撑，只有一条一次性观察就留空数组；dim 取 人格/性格/偏好/关系/身份 之一，confidence 低于 80 的不要输出。\n`
        + `4) tags 只写中性描述，不要写成评价性判断（"和事佬""很可爱"这类不要）。\n`
        + `5) promote 只收客观、可复现的特征；带推测、动机猜测、评价色彩的一律不晋升。\n`
        + `注意：短期记忆里带〔约定〕性质的（说好/答应/待提醒）如果次数够、内容具体，优先考虑晋升。`
    }
  ];
  const r = await askModel({ messages, temperature: 0.1, maxTokens: 1200, chatKey: '', settings });
  if (!r.ok) {
    const limited = !!r.rateLimited || /429|rate.?limit|rps|tpm|rpm/i.test(String(r.error || ''));
    return { tags: [], promote: [], traits: [], raw: '', error: `模型调用失败：${r.error}`, rateLimited: limited, configError: !!r.configError };
  }
  const parsed = extractJson(r.text);
  if (!parsed) {
    return { tags: [], promote: [], traits: [], raw: trimText(r.text, 300), error: `模型输出不是合法 JSON（原文：${trimText(r.text, 120) || '(空)'}）` };
  }
  const tags = cleanTags(pickTags(parsed), maxTags);
  const promote = (Array.isArray(parsed.promote) ? parsed.promote : [])
    .map((p) => ({ shortId: String(p?.shortId || ''), reason: trimText(p?.reason, 120), confidence: Number(p?.confidence) || 0 }))
    .filter((p) => p.shortId);
  const DIMS = ['人格', '性格', '偏好', '关系', '身份'];
  const traits = (Array.isArray(parsed.traits) ? parsed.traits : [])
    .map((t) => ({
      text: trimText(t?.text, 80),
      dim: DIMS.includes(String(t?.dim || '')) ? String(t.dim) : '性格',
      confidence: Math.max(0, Math.min(100, Number(t?.confidence) || 0))
    }))
    .filter((t) => t.text.length >= 8 && t.confidence >= 80)
    .slice(0, 2);
  const error = tags.length ? '' : `模型没给出可用标签（原始返回：${trimText(JSON.stringify(parsed), 160)}）`;
  return { tags, promote, traits, raw: trimText(r.text, 300), error };
}


// ── 关键点预筛（零 token）────────────────────────────────────────────
// 群里绝大部分是玩梗、复读、互相起哄，真正有信息量的往往是一句没人接的孤句。
// 先按生活事实信号词把这种句子挑出来，连前后各一句上下文一起交给模型判定：
// 既省 token，也不会让角落里那句话被上千条刷屏淹掉。
const KEY_SIGNALS = [
  ['health', /(住院|手术|开刀|化疗|透析|移植|吃药|复查|挂号|输液|发烧|失眠|血压|血糖|疼得|疼死|生病|不舒服|忌口|过敏|怀孕|孕检|体检|骨折|伤了)/],
  ['money', /(工资|加班费|奖金|辞退|辞职|面试|发工资|欠|借钱|还钱|房租|学费|报销|罚款|尾款|押金|赔钱|没钱|攒钱|转账)/],
  ['family', /((我|俺)(爸|妈|爹|娘|哥|姐|弟|妹|儿子|女儿|老婆|老公|媳妇|对象)|结婚|离婚|分手|生日|去世|走了|葬礼)/],
  ['work', /(上班|下班|值班|轮班|排班|老板|试用期|开课|上课|学生|调岗|入职|离职|工位|车间|开会)/],
  ['plan', /(搬家|回老家|出差|订票|车票|机票|开学|放假|考试|几号|月底|下周|明天要|后天要|周末要)/],
  ['confide', /(其实|说实话|不瞒|我跟你讲|悄悄|别跟人说|没跟人说过|第一次说)/]
];
const KEY_DROP = /^(哈+|笑死|草+|6+|？+|\?+|啊+|嗯+|哦+|好+|顶+|复读|\+1)/;
// 群里最常见的是互怼与扮演：「你妈也没钱」「母后，孤几号生日」字面上都带生活词，其实是扯淡。
// 只有"本人自述"才可能是真事实，所以这里卡第一人称与人称指向。
const KEY_SELF = /(我(?!的)|俺|咱|自己|家里|我家|我这|我这儿|我爸|我妈|我爹|我娘|我哥|我姐|我弟|我妹|我儿子|我女儿|我老婆|我老公|我媳妇|我对象|我刚|我准备|我打算|我昨天|我今天|我这几天|我下周|我明天|我在)/;
const KEY_OTHER = /((你|您|你们|他|她|人家)(妈|爸|爹|娘|家|家那|们家)|他(说|讲)|她说|转述)/;
const KEY_ROLEPLAY = /(孤|朕|本宫|父皇|母后|儿臣|臣妾|殿下|娘娘|本座|哀家|寡人)/;
const KEY_HARD = /(住院|手术|开刀|化疗|透析|移植|吃药|复查|挂号|输液|发烧|疼|病|怀孕|孕检|去世|走了|葬礼|离职|辞职|离婚)/;
// 问句不是事实：「你生日几号」「大学生扎马尾辫吗」这类只配当噪声。
const KEY_QUESTION = /(?:[?？]|(?:几号|几点|哪个|谁|什么|怎么|为什么|多少|吗|呢)\s*(?:@|$))/u;

/** 从最近记录里挑"可能有信息量"的句子，带前后各一句上下文。纯规则，不花 token。 */
function keyPointScan(chatKey, { days = 3, max = 40 } = {}) {
  let rows = [];
  try {
    rows = readRecentFromDisk(chatKey, 1500) || [];
  } catch {
    return [];
  }
    if (!rows.length) return [];
  const dayN = Math.max(1, Number(days) || 3);
  const since = Date.now() - dayN * 86400000;
  rows = rows.filter((m) => m && Number(m.ts) >= since && !m.self && !m.isPoke && !m.recalled);
  const repeat = new Map();
  for (const m of rows) {
    const t = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (t) repeat.set(t, (repeat.get(t) || 0) + 1);
  }
  const hits = [];
  for (let i = 0; i < rows.length; i += 1) {
    const m = rows[i];
    const t = String(m.text || '').replace(/\s+/g, ' ').trim();
    if (t.length < 5 || t.length > 140) continue;
    if (KEY_DROP.test(t)) continue;
    if (KEY_QUESTION.test(t)) continue;                   // 问句只配当噪声，不当事实
    if ((repeat.get(t) || 0) > 2) continue;               // 复读的梗不是信息
    if (/^\[[^\]]{1,12}\]$/u.test(t)) continue;            // 纯表情占位
    const selfRef = KEY_SELF.test(t);
    const otherRef = KEY_OTHER.test(t);
    if (KEY_ROLEPLAY.test(t) && !KEY_HARD.test(t)) continue;   // 宫廷腔里的话，除非带真病真事
    if (otherRef && !selfRef) continue;                        // 「你妈」「他说」不是本人自述
    let aspect = ''; let score = 0; let strong = 0;
    for (const [k, re] of KEY_SIGNALS) {
      if (!re.test(t)) continue;
      if (k === 'confide') { score += 1; continue; }            // 「其实/说实话」只是加分，单独不算信息
      strong += 1;
      score += 1;
      if (!aspect) aspect = k;
    }
    if (!strong) continue;
    if (/\d/u.test(t)) score += 1;                              // 带数字更像具体事实（几号 / 多少钱 / 几岁）
    hits.push({
      at: Number(m.ts) || 0, uid: String(m.senderId || '').replace(/\D/g, ''),
      name: String(m.senderName || ''), text: t, aspect, score, self: selfRef,
      prev: i > 0 ? trimText(rows[i - 1] && rows[i - 1].text, 60) : '',
      next: i + 1 < rows.length ? trimText(rows[i + 1] && rows[i + 1].text, 60) : ''
    });
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at);
  const per = new Map();
  const out = [];
  for (const h of hits) {
    const k = `${h.uid}:${h.aspect}`;
    const n = per.get(k) || 0;
    if (n >= 4) continue;                                   // 同一个人同一个方面最多 4 条，别让一个人占满
    per.set(k, n + 1);
    out.push(h);
    if (out.length >= Math.max(6, Number(max) || 40)) break;
  }
  return out;
}

/** 已记过什么（按人）：让模型把注意力留给空白，而不是把性格再说一遍。 */
function knownProfileLines(chatKey, budget = 2000) {
  try {
    const pdir = profileDirResolved(cfg());
    const rows = readRecentFromDisk(chatKey, 400) || [];
    const uids = new Set();
    for (const m of rows) {
      const u = String((m && m.senderId) || '').replace(/\D/g, '');
      if (u && !(m && m.self)) uids.add(u);
    }
    const parts = [];
    let chars = 0;
    for (const uid of uids) {
      if (chars >= budget) break;
      const p = readProfile(pdir, uid);
      if (!p || p.self) continue;
      const nm = p.name && p.name !== uid ? `${uid}（${p.name}）` : uid;
      const tr = (p.persona && p.persona.traits || []).filter((t) => t.status !== '废弃').slice(0, 2).map((t) => trimText(t.text, 60));
      const tg = (p.persona && p.persona.tags || []).slice(0, 4).map((t) => t.tag);
      const fc = (p.longTerm || []).filter((it) => it.kind !== 'event' && it.kind !== 'appointment' && !it.promoted).slice(0, 3).map((it) => trimText(it.text, 60));
      if (!tr.length && !tg.length && !fc.length) continue;
      const line = `- ${nm}：${[...tr, ...fc].join('；')}${tg.length ? `（标签：${tg.join('·')}）` : ''}`;
      if (chars + line.length > budget) continue;
      chars += line.length;
      parts.push(line);
    }
    return parts.join('\n');
  } catch {
    return '';
  }
}

/** 预筛模式的消息体：候选句 + 已知档案 + 名额分配。 */
function keyPointMessages(points, known, focus = [], label = '') {
  const list = points.map((p, i) => {
    const ctx = `${p.prev ? `\n     ↑前：${p.prev}` : ''}${p.next ? `\n     ↓后：${p.next}` : ''}`;
    return `${i + 1}. ${stampOf(p.at)} ${p.name || ''}(${p.uid})【${p.aspect}】${p.text}${ctx}`;
  }).join('\n');
  const system = '你是聊天机器人的记忆整理模块。下面是从聊天记录里先用规则筛出来的"可能有信息量"的句子（每句带前后各一条上下文）。'
    + '群里绝大多数是玩梗、复读、互相起哄，这些句子是被挑出来的候选。任务：判断哪几条是真的关键事实，绝不联想补全。\n'
    + '判定规则：\n'
    + '- 只收「本人自述」（第一人称说自己的事），或上下文能明确佐证的事；转述、玩笑、反讽、角色扮演、引用别人的话，一律不收。\n'
    + '- 候选句里混着两类假信号：一是互怼（「你妈也没钱」「他说他下周…」），二是角色扮演腔（「孤」「朕」「本宫」「母后」）。只要不是在讲自己的真实处境，都不收。\n'
    + '- 关键事实包括：身体与就医、家里的人和事、工作与钱、日程与变动（搬家/出差/考试/放假）、答应别人的具体事。这些是重点，别当成"一时的话题"丢掉。\n'
    + '- 不要写评价和推测，只写能核实的事实；不写具体金额、卡号、住址门牌、联系方式，密码、Token、密钥、证件号等凭证一律不输出。\n'
    + '- 每条 content 必须是「主语＋谓语」完整句，主语用昵称或 QQ 号，禁止用"他/她/对方/该用户"。同一件事只一条。\n'
    + '- 已经记过的不再重复输出（下面给了已记过的内容）。\n'
    + '- 约定类必须带具体时间（哪天/几号/几点/周几），没有时间的不要输出。\n'
    + '- 输出严格 JSON，不要解释、不要 markdown：\n'
    + '{"items":[{"userId":"123","name":"张三","content":"…","kind":"fact|appointment|preference|relation|general|correction","aspect":"health|money|family|work|plan|other","evidence":"原话不超过40字"}]}\n'
    + '- 拿不准就不输出，宁缺勿错。';
  const user = `候选句（共 ${points.length} 条${label ? '，' + label : ''}）：\n${list}\n\n`
    + (known ? `**已经记过的（不要重复）**：\n${known}\n\n` : '')
    + (focus.length ? `**优先看这几个人**：${focus.map((f) => `${f.name || f.userId}(${f.userId})`).join('、')}\n` : '')
    + '输出要求：事实类（fact / appointment）最多 8 条，性格类（preference / relation / general）最多 1 条；宁可少写。';
  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 名额按类分配：事实类多留、性格类只留一条 —— 角落里的关键点不该被"性格"挤掉。 */
function pickByQuota(raw, total = 10) {
  const factKinds = new Set(['fact', 'appointment', 'correction']);
  const facts = [];
  const others = [];
  for (const it of raw) {
    if (!it || !it.content) continue;
    if (factKinds.has(String(it.kind || 'general'))) {
      if (facts.length < 8) facts.push(it);
    } else if (others.length < 2) {
      others.push(it);
    }
  }
  return facts.concat(others).slice(0, Math.max(3, Number(total) || 10));
}

/** 回看聊天记录，让模型挑出值得记住的稳定信息。返回 {items, error, note}。 */
/** 模型偶尔漏主语（"喜欢打游戏"）：用昵称补上；代词开头的直接换成昵称。 */
function ensureSubject(content, who) {
  const c = String(content || '').trim();
  if (!c || !who) return c;
  if (c.startsWith(who) || c.startsWith('我')) return c;
  const m = c.match(/^(他|她|对方|该用户|这个人|此人|其)(?=[\u4e00-\u9fa5])/);
  if (m) return who + c.slice(m[0].length);
  return who + c;
}

/** 约定类必须能从话里读出具体时刻，"说好了"这种没时间的事记下来也没法用。 */
function hasClockTime(text) {
  return /(\d{1,2}\s*月\s*\d{1,2}\s*[日号]|\d{1,2}\s*[-\/]\s*\d{1,2}|\d{1,2}\s*[点:：]\s*(\d{1,2}|半)?|今天|今晚|今早|明天|明晚|明早|后天|大后天|昨天|周[一二三四五六日天]|星期[一二三四五六日天]|礼拜[一二三四五六日天]|\d+\s*(天|日|小时|分钟|周|个?月)(后|内|之后|以内|以后)|下(周|个月|月))/.test(String(text || ''));
}

/**
 * 把已有短期记忆里漏主语的句子补上主语（"喜欢打游戏" → "张三喜欢打游戏"）。
 * 只动插件自己的短期记忆，长期记忆正文归核心模块独占，这里不碰。
 */
function fixShortSubjects(chatKey) {
  try {
    const chat = chatState(chatKey, { create: false });
    if (!chat) return 0;
    let fixed = 0;
    for (const [uid, m] of Object.entries(chat.members || {})) {
      const who = String(m?.name || '').trim() || `QQ${uid}`;
      for (const s of (m?.short || [])) {
        if (!s || !s.content) continue;
        const next = ensureSubject(s.content, who);
        if (next && next !== s.content) {
          s.content = next;
          fixed += 1;
        }
      }
    }
    if (fixed) saveState();
    return fixed;
  } catch (error) {
    verbose(`补主语失败：${error?.message ?? error}`);
    return 0;
  }
}

async function extractFromArchive(ctx, { scan = 120, days = 0, settings = {}, focus = [] } = {}) {
  try {
    // 回看范围：0 = 不限时间（按条数，自动提取用的旧行为）；1/3/7 = 只回看最近这么多个自然日
    const rangeDays = Math.min(30, Math.max(0, Number(days) || 0));
    const pullLimit = rangeDays > 0 ? 1500 : Math.min(2000, scan);
    let list = null;
    if (typeof ctx?.store?.recent === 'function') {
      list = ctx.store.recent(ctx.chatKey, { limit: pullLimit }) || [];
    } else {
      list = readRecentFromDisk(ctx.chatKey, pullLimit);
    }

    let rangeText = '';
    if (rangeDays > 0) {
      const now = new Date();
      // 凌晨（0~5 点）点整理时，今天才过了几个小时，只看今天等于没东西可看，整天窗口整体往前挪一天
      const shift = now.getHours() < 6 ? 1 : 0;
      const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      const since = midnight - ((rangeDays - 1 + shift) * 86400000);
      const from = new Date(since);
      const pad = (n) => String(n).padStart(2, '0');
      rangeText = `${from.getFullYear()}-${pad(from.getMonth() + 1)}-${pad(from.getDate())} 起`;
      list = (list || []).filter((m) => m && Number(m.ts) >= since);
    }
    if (!list || list.length < 6) {
      return { items: [], note: `聊天记录太少（${rangeText ? rangeText + '只有 ' : '只有 '}${list?.length || 0} 条），这次不提取` };
    }

    // 从最新往回装填：字符预算满了就停，保证被丢掉的是最旧的、而不是最新的
    const lines = [];
    let chars = 0;
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const m = list[i];
      if (!m || m.isPoke || m.recalled) continue;
      const who = m.self ? '我' : `${String(m.senderName || '')}(${m.senderId})`;
      const text = trimText(m.text, 160);
      if (!text) continue;
      const line = `${stampOf(m.ts)} ${who}：${text}`;
      if (chars + line.length > 6000) break;
      chars += line.length;
      lines.unshift(line);
    }
    if (lines.length < 6) return { items: [], note: '有效聊天记录太少，这次不提取' };

    const baseMessages = [
      {
        role: 'system',
        content: '你是聊天机器人的记忆整理模块。任务：从聊天记录里挑出"以后还用得上"的稳定信息，绝不发明、不推测。'
          + '每条 content 必须是「主语＋谓语」的完整句，能脱离上下文单独读懂：'
          + '**主语只能是本人的昵称或 QQ 号**，禁止省略主语（不要写「会打游戏」「喜欢打游戏」「和某某是母子关系」这种没主语的句子），'
          + '也禁止用"该用户""对方""他""她""你"当主语。'
          + '涉及人物关系的，关系两头都要写出名字（例：「张三和人鱼是母子关系，张三自称父亲」）。'
          + '属于"约定/答应/待提醒"的，必须带上具体时间（哪天/几号/几点/周几/几天后），没有时间的约定不要输出。'
          + '同一件事只输出一条，禁止为同一个特征换几种说法重复输出。'
          + '先判断语境：玩梗、反讽、角色扮演、引用、转述里的台词都不是事实；多人复读、跟风自称、互相起哄贴标签，重复次数也不增加可信度。'
          + '扮演出来的称呼和身份（如「我是太子」「叫我母后」）不是真实关系或身份；确有回忆价值就写明「（扮演）」「（自称）」，别删掉这个限定。'
          + '本人后来澄清「刚才是开玩笑」的，按他的纠正来记，不要另猜一个身份。'
          + '输出严格 JSON，不要解释、不要 markdown 代码块。'
          + '格式：{"items":[{"userId":"123456","name":"张三","content":"一句话的观察","kind":"general|appointment|preference|fact|relation|correction"}]}'
      },
      {
        role: 'user',
        content: `以下是${rangeText ? rangeText + '的' : '最近的'}聊天记录（共 ${lines.length} 条，时间 发送者：内容）：\n${lines.join('\n')}\n\n`
          + (focus.length
            ? `**这几个人还没被记过，优先看看他们有没有值得记的稳定信息**：`
              + focus.map((f) => `${f.name || f.userId}(${f.userId})`).join('、') + '\n'
            : '')
          + `请挑出值得长期记住的**关于某个人的稳定信息**，最多 ${focus.length ? 5 : 3} 条：\n`
          + '- 适合记：稳定性格特点、说话习惯、明确偏好/雷点、身份关系、以及"约定/答应/待提醒"类的事。\n'
          + '- 每条都要写清对象：写「示例用户称某用户为姐姐、自称孤」，不要写「称对方为姐姐」；'
          + '写「某用户答应下完影之刃叫机器人」，不要写「下完要叫他」。\n'
          + '- **每条都必须带主语**：写「张三喜欢打游戏」，不要写「喜欢打游戏」；'
          + '写「李四和王五是夫妻」，不要写「和王五是夫妻」；写「张三打游戏只玩战地6」，'
          + '不要写「打游戏只玩战地6」。主语用记录里出现的那个昵称或 QQ 号。\n'
          + '- **约定类必须有时间**：写清哪天几点、几号、周几或"三天后"这类可推算的时刻，'
          + '并保留原话里的人名和事由；只有"说好了""答应了"但没有明确时间的，不要当成约定输出。\n'
          + '- 同一个人同一类特征（尤其说话习惯/称呼）最多一条；同一件事不要换说法重复输出。\n'
          + '- kind 判定：preference=稳定的喜好/口癖/雷点；fact=身份、住址、职业、设备、经历等客观信息；'
          + 'relation=称呼与人物关系；appointment=只给"说好/答应/要提醒"的具体约定，且必须带时间和事由；'
          + 'correction=本人被纠正过、明确不能再碰的说法/举动；其余拿不准用 general。\n'
          + '- 不要记：一时的话题与情绪、当天发生了什么、玩笑话、你自己说过的话、没有明确指向某人的内容、'
          + '调试/测试性质的对话（如"整理记忆出bug了""测试记忆"）、别人的隐私事件（如他人的意外、疾病、感情变故）、'
          + '以及任何涉及隐私敏感（真实姓名/住址/联系方式/账号密码/金钱往来）的内容；密码、Token、密钥、证件号等凭证一律不输出。\n'
          + '- 约定类（kind=appointment）的 content 必须保留原话里的时间、人名、事情，不许改写。\n'
          + '- 不确定就不要输出。userId 必须是记录里出现过的 QQ 号。'
      }
    ];
    // 关键点优先：先用死规则把"角落里有信息量的句子"挑出来，只在这些句子上花模型调用。
    // 一个字面候选都没有（整段都是玩梗、复读、互怼）就直接跳过，连这次调用都省掉 —— 群里绝大多数时间都属于这种。
    let messages = null;
    try {
      const points = keyPointScan(ctx.chatKey, { days: rangeDays || 3, max: 40 });
      // 有字面候选还不够：问句、互怼、泛泛而谈（"你生日几号""考公也是先交钱"）也符合信号词。
      // 只有「本人自述」或分数够高的句子才值得花一次调用；一条都没有就整段跳过。
      const usable = points.filter((p) => p.self || p.score >= 2);
      if (usable.length) {
        messages = keyPointMessages(usable, knownProfileLines(ctx.chatKey, 2000), focus, rangeText ? rangeText + '起' : '最近 3 天');
      } else if (!focus.length) {
        return {
          items: [],
          note: points.length
            ? `近 ${rangeDays || 3} 天筛出 ${points.length} 句，但都是问句/互怼/泛泛而谈，没有本人自述，这次跳过提取（没花模型调用）`
            : `近 ${rangeDays || 3} 天没筛到生活事实类的话，这次跳过提取（没花模型调用）`,
          skipped: true
        };
      }
    } catch (error) {
      verbose(`关键点预筛失败：${error && error.message ? error.message : error}`);
    }
    // 只有「只整理某个人」（focus）时才退回整段摘要：那是人工点名要看，值一次调用
    if (!messages) messages = baseMessages;
    const r = await askModel({ messages, temperature: 0.1, maxTokens: 2600, chatKey: ctx.chatKey, settings });
    if (!r.ok) return { items: [], error: r.error, rateLimited: !!r.rateLimited || /429|rate.?limit|rps|tpm|rpm/i.test(String(r.error || '')) };
    let parsed = extractJson(r.text);
    // 模型偶尔在 JSON 末尾多逗号、夹说明文字，或被长度截断 → 整批解析失败；捞出已完整的条目，别整批作废
    if (!parsed) {
      const salvaged = salvageItems(r.text);
      if (salvaged.length) parsed = { items: salvaged };
    }
    if (!parsed) return { items: [], error: `模型输出不是合法 JSON（原文：${trimText(r.text, 200) || '(空)'}）` };
    const raw = Array.isArray(parsed.items) ? parsed.items : (Array.isArray(parsed) ? parsed : []);
    const items = pickByQuota(raw, focus.length ? 5 : 10).map((it) => ({
      userId: String(it?.userId || '').replace(/\D/g, ''),
      name: trimText(it?.name, 60),
      content: trimText(it?.content, 300),
      kind: String(it?.kind || 'general'),
      aspect: trimText(it?.aspect, 20),
      evidence: trimText(it?.evidence, 80)
    })).filter((it) => it.userId && it.content)
      // 收尾校验：模型还是常常漏主语/漏时间，这里兜一层，不让"喜欢打游戏"这种没头没尾的句子进库
      .map((it) => {
        const who = it.name || `QQ${it.userId}`;
        const content = ensureSubject(it.content, who);
        if (it.kind === 'appointment' && !hasClockTime(content)) {
          // 约定没有时间就等于没约定，以后既没法提醒也没法核对，直接不记
          return null;
        }
        return { ...it, content };
      })
      .filter(Boolean);
    if (!items.length) return { items: [], note: `模型认为这次没有值得记的内容（返回 ${raw.length} 条候选）` };
    return { items };
  } catch (error) {
    return { items: [], error: String(error?.message ?? error) };
  }
}

/** 提取结果 JSON 半截、夹说明或被截断时，把已经完整的 item 对象捞出来（半截的丢掉，别整批作废）。 */
function salvageItems(text) {
  const out = [];
  const s = String(text || '').replace(/```json/gi, '').replace(/```/g, '');
  for (const m of s.matchAll(/\{[^{}]*\}/g)) {
    try {
      const o = JSON.parse(m[0].replace(/,\s*\}/g, '}'));
      if (o && String(o.userId || '').replace(/\D/g, '') && String(o.content || '').trim()) out.push(o);
    } catch {}
  }
  return out;
}

/** 模型输出被 maxTokens 截断时，用正则把已经完整的 issue 对象捞出来（半截的丢掉，别整批作废）。 */
function salvageIssues(text) {
  const out = [];
  const re = /\{[^{}]*"type"\s*:\s*"(?:conflict|attribution|duplicate|relation_mismatch)"[^{}]*\}/g;
  const s = String(text || '');
  let m;
  while ((m = re.exec(s)) !== null) {
    try {
      out.push(JSON.parse(m[0]));
    } catch { /* 半截对象，跳过 */ }
  }
  return out;
}

/**
 * 交叉验证：把同一会话里多个人的记忆放在一起核对，找三类问题。
 *   ① conflict     同一对象同一属性被记成互相排斥的两个值
 *   ② attribution  记忆的主语不是档案本人
 *   ③ duplicate    同一人名下多条讲同一件事（含长期与短期重复）
 * 不查"单向称呼"（别人怎么叫你，你的档案里本来就不会记，查了全是误报）。
 * 只产出报告（写到会话文件夹的 _交叉验证.json），不自动改数据 —— 误判一次就可能删掉真记忆。
 */
async function crossCheck(chatKey, { settings = {}, longMembers = null, apply = true, userIds = null } = {}) {
  try {
    const c = settings || cfg();
    // 交叉验证可以单独配模型：配了就用它，没配就跟随整理用的模型。
    // 好处是免费渠道留给日常整理，交叉验证这种多批次、重判断的活单独走快模型，互不抢额度。
    const xc = {
      ...c,
      modelProvider: String(c.crossCheckProvider || c.modelProvider || ''),
      modelName: String(c.crossCheckModel || c.modelName || '')
    };
    const members = longMembers || safeMembers(chatKey);
    const entries = chatMembers(chatKey) || {};
    // 面板勾了人再跑时，只取这几个人：语义才是"这几个人之间互相核对"，
    // 而不是像以前那样全群混着跑、报告里看不出到底谁在验谁。
    const want = (Array.isArray(userIds) ? userIds : []).map((x) => String(x || '').trim()).filter(Boolean);
    const allIds = [...new Set([...members.map((m) => String(m.userId)), ...Object.keys(entries)])];
    const ids = want.length ? allIds.filter((uid) => want.includes(uid)) : allIds;

    const blocks = [];
    let chars = 0;
    for (const uid of ids) {
      const lm = members.find((m) => String(m.userId) === String(uid));
      const e = entries[uid] || {};
      const name = lm?.name || e.name || uid;
      const labels = (e.labels || []).map((l) => l.tag).filter(Boolean).slice(0, 8).join('/');
      const longLines = (lm?.impressions || []).slice(0, 6).map((x) => `- ${trimText(x.content, 120)}`);
      const shortLines = (e.short || []).slice(0, 6).map((x) => `- ${trimText(x.content, 120)}`);
      if (!longLines.length && !shortLines.length) continue;
      const block = `【${name}(${uid})】标签：${labels || '无'}\n长期：\n${longLines.join('\n') || '- 无'}\n短期：\n${shortLines.join('\n') || '- 无'}`;
      // 总上限放宽到 4 万字：下面会按 10 人/批切开，不怕一次喂太多
      if (chars + block.length > 40000) break;
      chars += block.length;
      blocks.push(block);
    }
    if (blocks.length < 2) {
      return {
        ok: true,
        issues: [],
        note: want.length ? '你勾选的人里有记忆的不足 2 个，没法互相核对' : '有效记忆档案少于 2 人，跳过交叉验证'
      };
    }

    // 4-gram 重合度：用来判断两条记忆是不是在讲同一件事（比 sameImpression 宽松些）
    const grams = (s, n) => {
      const t = String(s || '').replace(/[\s，。、！？“”"'：:；;（）()·—\-]/g, '');
      const set = new Set();
      for (let i = 0; i + n <= t.length; i += 1) set.add(t.slice(i, i + n));
      return set;
    };
    const overlap = (a, b, n = 4) => {
      const A = grams(a, n);
      const B = grams(b, n);
      if (!A.size || !B.size) return 0;
      let hit = 0;
      for (const g of A) if (B.has(g)) hit += 1;
      return hit / Math.min(A.size, B.size);
    };

    // ── 重复先用本地算法查：同一人名下（含长期 vs 短期）内容近似的，直接算重复 ──
    //    不花 token，也不怕模型把类型判错。这是交叉验证里最确定的一部分。
    //    ⚠️ 判重前必须先去掉两条共有的开头。记忆大多以群友名字起头
    //    （「随缘的陈喵言在上班」/「随缘的陈喵言玩明日方舟」），
    //    名字本身就是一长串公共 4-gram，重合度天然卡在 0.5 左右，会把两条无关的事判成重复。
    //    本机实测 7 条 duplicate 里有 5 条就是这么误报出来的。
    const normText = (s) => String(s || '').replace(/[\s，。、！？“”"'：:；;（）()·—\-…]/g, '');
    const commonPrefix = (a, b) => {
      const A = normText(a);
      const B = normText(b);
      let i = 0;
      const max = Math.min(A.length, B.length);
      while (i < max && A[i] === B[i]) i += 1;
      return { rest: [A.slice(i), B.slice(i)], len: i };
    };
    const localDup = [];
    for (const uid of ids) {
      const lm = members.find((m) => String(m.userId) === String(uid));
      const e = entries[uid] || {};
      const items = [
        ...(e.short || []).map((x) => ({ src: '短期', content: x.content })),
        ...((lm?.impressions) || []).map((x) => ({ src: '长期', content: x.content }))
      ].filter((x) => x.content);
      for (let a = 0; a < items.length; a += 1) {
        for (let b = a + 1; b < items.length; b += 1) {
          const { rest, len } = commonPrefix(items[a].content, items[b].content);
          let dup = false;
          if (len >= 2) {
            // 去掉公共前缀后任一侧不足 4 个字 = 只是名字/称呼一样，内容其实不相干
            if (rest[0].length >= 4 && rest[1].length >= 4) {
              dup = sameImpression(rest[0], rest[1]) || overlap(rest[0], rest[1]) >= 0.65;
            }
          } else {
            dup = sameImpression(items[a].content, items[b].content)
              || overlap(items[a].content, items[b].content) >= 0.6;
          }
          if (!dup) continue;
          localDup.push({
            type: 'duplicate',
            userId: String(uid),
            name: lm?.name || e.name || '',
            content: trimText(items[a].content, 200),
            detail: `与同人的${items[b].src}记忆重复：${trimText(items[b].content, 120)}`,
            suggestion: '',
            confidence: 100
          });
          break; // 一条记忆只报一次
        }
      }
    }

    // 全群记忆原文池：用来校验模型报的"另一条冲突记忆"是否真的存在（防止它现编）
    const pool = [];
    const poolOf = new Map();   // userId -> 该人名下的全部记忆原文
    for (const uid of ids) {
      const lm = members.find((m) => String(m.userId) === String(uid));
      const e = entries[uid] || {};
      const arr = [];
      for (const x of (e.short || [])) if (x.content) { pool.push(x.content); arr.push(x.content); }
      for (const x of ((lm?.impressions) || [])) if (x.content) { pool.push(x.content); arr.push(x.content); }
      poolOf.set(String(uid), arr);
    }
    // 两条"互相排斥"的说法，至少要共享一个 3 字实词（否则就是模型把不相干的两条硬凑）
    const sharesWord = (a, b) => {
      const A = String(a || '').replace(/[\s\p{P}]/gu, '');
      const B = String(b || '').replace(/[\s\p{P}]/gu, '');
      for (let i = 0; i + 3 <= A.length; i += 1) {
        if (B.includes(A.slice(i, i + 3))) return true;
      }
      return false;
    };

    // 分批：一批最多 10 人、8000 字符。26 人的群会分成 3 批。
    // 一次全喂会导致模型输出被 maxTokens 截断（JSON 半截 → 整批解析失败）。
    const batches = [];
    let cur = [];
    let curChars = 0;
    for (const block of blocks) {
      if (cur.length >= 10 || (cur.length && curChars + block.length > 8000)) {
        batches.push(cur);
        cur = [];
        curChars = 0;
      }
      cur.push(block);
      curChars += block.length;
    }
    if (cur.length) batches.push(cur);

    const TYPES = ['conflict', 'attribution'];
    const TYPE_CN = { conflict: '两处说法矛盾', attribution: '记忆主语不是本人', duplicate: '同一件事重复记' };
    const allIssues = [...localDup];
    const seen = new Set(allIssues.map((x) => `${x.type}|${x.userId}|${x.content}`));
    let firstError = '';

    for (let bi = 0; bi < batches.length; bi += 1) {
      const messages = [
        {
          role: 'system',
          content: '你是记忆核对模块。下面是同一个群里多个人的记忆档案。只做核对，绝不发明新事实、不推测。'
            + '输出严格 JSON，不要解释、不要 markdown 代码块。输出越短越好，否则会被截断。格式：'
            + '{"issues":[{"type":"conflict","userId":"1000000002","content":"其中一条原句","otherContent":"另一条互相排斥的原句","confidence":90},{"type":"attribution","userId":"1000000002","content":"主语不对的那条原句","confidence":90}]}'
        },
        {
          role: 'user',
          content: `以下是同群多人的记忆档案：\n\n${batches[bi].join('\n\n')}\n\n`
            + '只找下面两类问题，**只报把握 80 分以上的，最多 4 条**：\n'
            + '1. conflict：同一个对象、同一个属性，被记成互相排斥的两个值——**两条不能同时成立**（如同一人被一处记"男"、另一处记"女"）。'
            + '如果两条信息可以同时成立（例如都记"自称小猪"，只是详略不同），就不要报（重复由程序另行检查）。\n'
            + '2. attribution：某条记忆的句子主语不是该档案本人（如"乙答应某事"写在甲名下，或"管理员交代…"挂在普通群员名下）。\n'
            + '每条 content 必须是**档案里的原句**，只能引用一条记忆，禁止把两条拼在一起。\n'
            + '不要检查"别人怎么称呼我"这类单向关系（别人叫你豆哥，你的档案里本来就不会记），一律不报。\n'
            + '判定注意：不同群的角色扮演设定互不影响；同一人在不同群用不同昵称不算冲突；玩笑话按玩笑对待。\n'
            + '没有问题时输出 {"issues":[]}。'
        }
      ];
      // 智谱通道经常 429/502。用户明确说过"慢没关系"，所以这里多重试几次再放弃。
      let r = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        r = await askModel({ messages, temperature: 0.1, maxTokens: 3000, chatKey: '', settings: xc });
        if (r.ok) break;
        if (attempt < 2) await sleep(r.rateLimited ? 20000 : 8000);
      }
      if (!r || !r.ok) {
        if (!firstError) firstError = `模型调用失败：${r?.error || '未知错误'}`;
        // 限流就歇久一点，别把后面几批也打空
        if (r?.rateLimited && bi < batches.length - 1) await sleep(30000);
        continue;
      }
      // 正常解析；如果 JSON 被截断，用正则把已经完整的对象捞出来（别整批丢掉）
      const parsed = extractJson(r.text);
      const rawList = Array.isArray(parsed?.issues) ? parsed.issues : salvageIssues(r.text);
      if (!rawList.length && !parsed) {
        if (!firstError) firstError = `输出不是合法 JSON（原文：${trimText(r.text, 120) || '(空)'}）`;
        continue;
      }
      for (const it of rawList) {
        const type = TYPES.includes(String(it?.type)) ? String(it.type) : '';
        if (!type) continue;
        const row = {
          type,
          userId: String(it?.userId || '').replace(/\D/g, ''),
          name: '',
          content: trimText(it?.content, 200),
          detail: TYPE_CN[type] || type,
          suggestion: '',
          confidence: Math.max(0, Math.min(100, Number(it?.confidence) || 0))
        };
        const lm = members.find((m) => String(m.userId) === row.userId);
        row.name = lm?.name || entries[row.userId]?.name || '';
        // 原句必须真的在这个人名下（防止模型现编一条不存在的记忆）
        const own = poolOf.get(row.userId) || [];
        if (!own.some((x) => overlap(row.content, x) >= 0.6)) continue;
        if (type === 'conflict') {
          // 冲突必须能指出"另一条互相排斥的原句"，且这句真的在档案里、且两条共享实词
          const other = trimText(it?.otherContent, 200);
          if (!other) continue;
          if (!pool.some((x) => overlap(other, x) >= 0.6)) continue;
          if (!sharesWord(row.content, other)) continue;
          row.detail = `与这条互相排斥：${other}`;
        }
        if (!row.content) continue;
        // 模型自己都没把握的就丢掉，别拿误报烦人
        if (row.confidence && row.confidence < 70) continue;
        const sig = `${row.type}|${row.userId}|${row.content}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        allIssues.push(row);
      }
      // 批之间歇 3 秒：交叉验证一次要调好几批模型，连着打很容易被网关限流（429/502）
      if (bi < batches.length - 1) await sleep(3000);
    }

    const issues = allIssues;
    if (!issues.length && firstError) return { ok: false, issues: [], error: firstError };

    if (apply) {
      try {
        const file = path.join(chatDirOf(chatKey), '_交叉验证.json');
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({
          _说明: '交叉验证报告：只记录发现的问题，不自动修改记忆。确认后再自行处理。',
          checkedAt: Date.now(),
          chatKey,
          model: `${xc.modelProvider || '(跟随主模型)'}/${xc.modelName || '(跟随主模型)'}`,
          batches: batches.length,
          issues
        }, null, 2), 'utf8');
      } catch (error) {
        return { ok: true, issues, error: `报告落盘失败：${error?.message ?? error}` };
      }
    }
    return { ok: true, issues, error: firstError };
  } catch (error) {
    return { ok: false, issues: [], error: String(error?.message ?? error) };
  }
}

// ══════════════════════════════════════════════════════════════════════
// 钩子（确定性的一侧）
// ══════════════════════════════════════════════════════════════════════

export const hooks = {
  /**
   * 组装提示词之前，做三件"到点必然发生"的事：
   *   ① 短期记忆过期清理（顺手，10 分钟最多一次）
   *   ② 执行排队的存档时间段删除（用**活的 store 实例**，不会被内存缓存复活）
   *   ③ 把本会话的记忆块算好，缓存给 before-llm-messages 用
   * 这里绝不能做网络/模型调用（钩子 5 秒超时会被跳过）。
   */
  'before-context': ({ chatKey, sessionId, triggerEntries, store, memory }) => {
    try {
      const c = cfg();
      const now = Date.now();

      // ⓪ 花名册：把"发过言的人"登记进记忆页（节流 10 分钟，不花模型调用）
      if (chatKey && on('enableMemory')) {
        try { refreshRoster(chatKey); } catch (error) { verbose(`花名册失败：${error?.message ?? error}`); }
      }

      // ① 过期清理（节流；关掉「短期记忆」就不做）
      if (on('enableShortTerm') && now - lastExpireAt > 10 * 60 * 1000) {
        lastExpireAt = now;
        const ex = expireShort(c.shortTtlDays, now);
        if (ex.removed) verbose(`短期记忆过期清理：删了 ${ex.removed} 条`);
      }

      // ② 排队的存档删除（活 store 才能不被复活）
      if (store && typeof store.removeByLocalIds === 'function') {        const pend = takePendingPrune(chatKey);
        for (const p of pend) {
          try {
            const recent = store.recent(chatKey, { limit: 100000 }) || [];
            const ids = recent.filter((m) => Number(m.ts) >= (p.from || 0) && Number(m.ts) <= (p.to || Number.MAX_SAFE_INTEGER)).map((m) => m.id);
            const removed = ids.length ? store.removeByLocalIds(chatKey, ids) : 0;
            recordPurge({ chatKey, removed, reason: 'manual-range', note: p.note });
            verbose(`按时间段清理 ${chatKey}：删了 ${removed} 条`);
          } catch (error) {
            warn(`按时间段清理失败（${chatKey}）：${error?.message ?? error}`);
          }
        }
      }

      // ③ 算记忆块（关掉「两层记忆」就完全不动提示词里的记忆段）
      if (!sessionId || !chatKey) return;
      if (!on('enableMemory')) { blockCache.delete(String(sessionId)); return; }
      const members = (() => {
        try { return typeof memory?.members === 'function' ? memory.members(chatKey) : []; } catch { return []; }
      })();
      const shortByMember = chatMembers(chatKey);

      // 相关的人 = 本轮触发批的发送者 + 最近窗口里出现过的人（核心也是这个口径）
      const relevant = new Set();
      for (const m of triggerEntries || []) {
        if (m?.senderId && !m.self) relevant.add(String(m.senderId));
      }
      try {
        // 和核心对话历史窗口对齐：模型看到几条，相关人就从几条里提取
        const histLimit = Number(c.historyLimit) || 40;
        const recent = store?.recent ? store.recent(chatKey, { limit: histLimit }) : [];
        for (const m of recent || []) {
          if (m?.senderId && !m.self) relevant.add(String(m.senderId));
        }
      } catch { /* 读不到就只按触发批 */ }

      // ③ 构建记忆块。优先用「按 QQ 号」的档案（人物画像 / 个性标签 / 长期记忆 三段）；
      //    档案目录还没内容时回退到旧的两层记忆块，保证升级过程不出现空窗。
      const pdir = profileDirResolved(c);
      const profilesReady = (() => {
        try { return fs.readdirSync(pdir).some((f) => f.endsWith('.json') && !f.startsWith('_')); } catch { return false; }
      })();
      let built = null;
      if (c.profileMode !== false && profilesReady) {
        try {
          const prof = buildProfileBlock({
            dir: pdir,
            chatKey,
            userIds: relevant.size ? [...relevant].map(String) : [],
            limits: {
              portrait: Number(c.portraitPerMember) || 3,
              tags: Number(c.labelsPerMember) || 8,
              long: Number(c.longPerMember) || 5,
              longTtlDays: Number(c.longTtlDays) || 0
            }
          });
          if (prof.text) {
            built = { text: prof.text, replaced: true, members: prof.members, longItems: prof.long, shortItems: 0, labelOnly: 0, profile: true };
          } else {
            // 档案模式已开、但这轮相关的人都没档案 → 不改提示词，别退回旧块塞短期记忆
            built = { text: '', replaced: false, members: 0, longItems: 0, shortItems: 0 };
          }
        } catch (error) {
          verbose(`档案块构建失败，回退旧逻辑：${error?.message ?? error}`);
        }
      }
      if (!built) {
        built = buildMemoryBlock({
          chatKey,
          members,
          shortByMember,
          relevantUserIds: relevant.size ? relevant : null,
          cfg: c,
          helpers: { looksLikeAppointment, getLongMeta, isDuePassed }
        });
      }
      if (built.replaced) {
        // 计数必须跟文本一起缓存：before-llm-messages 写回会话时读的是 cached.members 等，
        // 原来只存 text/at，导致面板与会话字段恒显示「0 人 / 0 条」，看起来像没注入。
        blockCache.set(String(sessionId), {
          text: built.text, at: now,
          members: built.members, labelOnly: built.labelOnly, longItems: built.longItems, shortItems: built.shortItems
        });
        verbose(`记忆块已备好（${chatKey}）：${built.members} 人 / 长期 ${built.longItems} / 短期 ${built.shortItems}`);
      } else {
        blockCache.delete(String(sessionId));
      }
      // 顺手清理过期的缓存条目
      for (const [k, v] of blockCache) if (now - v.at > 10 * 60 * 1000) blockCache.delete(k);
    } catch (error) {
      warn(`before-context 失败：${error?.message ?? error}`);
    }
  },

  /**
   * 消息即将发给模型，按顺序做四件事（每一件都能单独关掉）：
   *   ① 把【记忆】段换成本插件的两层版本（enableMemory）
   *   ② 裁剪【已读信息】的条数（enableHistoryTrim / historyLimit）
   *   ③ 裁掉系统提示里配置过的整段技能规则（enableSystemTrim / trimSectionTitles）
   *   ④ 插入"主人已回答的问题"与"排队中的整理任务"
   */
  'before-llm-messages': ({ messages, sessionId, chatKey }) => {
    try {
      if (!Array.isArray(messages) || !messages.length) return;
      const stats = { trimmedHistory: 0, trimmedSections: [], memory: null };
      // 记下核心原文的字数，好让面板能说清"省了多少"
      const coreChars = { system: 0, user: 0 };
      for (const m of messages) {
        if (!m) continue;
        if (m.role === 'system') coreChars.system += contentText(m).length;
        else if (m.role === 'user') coreChars.user += contentText(m).length;
      }

      // ① 记忆段
      if (on('enableMemory')) {
        const cached = sessionId ? blockCache.get(String(sessionId)) : null;
        if (cached?.text) {
          applyToMessages(messages, cached.text);
          blockCache.delete(String(sessionId));
          stats.memory = {
            members: Number(cached.members) || 0,
            labelOnly: Number(cached.labelOnly) || 0,
            longItems: Number(cached.longItems) || 0,
            shortItems: Number(cached.shortItems) || 0,
            chars: cached.text.length
          };
        }
      } else if (sessionId) {
        blockCache.delete(String(sessionId));
      }

      // ② 裁剪聊天记录 + ③ 裁系统提示段落
      const wantTrim = on('enableHistoryTrim') && Number(cfg().historyLimit) > 0;
      const wantSysTrim = on('enableSystemTrim') && String(cfg().trimSectionTitles || '').trim() && !skipTrimForChat(chatKey);
      let trimNote = '';
      if (wantTrim || wantSysTrim) {
        for (const msg of messages) {
          if (!msg) continue;
          const isSystem = msg.role === 'system';
          const apply = (text) => {
            let out = String(text);
            if (!isSystem && wantTrim) {
              const r = trimHistorySection(out, cfg().historyLimit);
              out = r.text;
              stats.trimmedHistory += r.trimmed;
              // ⚠️ 说明文字**不能写进【已读信息】块里**：session-memory-keeper 会逐行核验，
              //    认不出的行会被它换成"[旧历史格式无法核验，本轮停用]"。所以先攒着，
              //    最后贴到消息**末尾**（块外）。
              if (r.note) trimNote = r.note;
            }
            if (isSystem && wantSysTrim) {
              const r = trimSystemSections(out, cfg().trimSectionTitles);
              out = r.text;
              if (r.removed.length) stats.trimmedSections.push(...r.removed);
            }
            return out;
          };
          if (typeof msg.content === 'string') msg.content = apply(msg.content);
          else if (Array.isArray(msg.content)) {
            for (const part of msg.content) {
              if (part && part.type === 'text' && typeof part.text === 'string') part.text = apply(part.text);
            }
          }
          // 把裁剪说明贴成【已读信息】**前面**独立的一段（块外）。
          // 为什么不贴在消息末尾：如果【已读信息】正好是最后一段，块的范围会一直延伸到
          // 字符串结尾，说明文字又会被算进块里、被 session-memory-keeper 换成"无法核验"。
          if (trimNote && !isSystem && typeof msg.content === 'string') {
            const before = msg.content;
            msg.content = msg.content.replace(/(^|\n)(【已读信息】)/, (m, lead, head) => `${lead}（${trimNote}）\n\n${head}`);
            if (msg.content !== before) trimNote = '';
          }
        }
      }
      if (stats.trimmedHistory || stats.trimmedSections.length) {
        lastTrim = {
          at: Date.now(),
          history: stats.trimmedHistory,
          sections: [...new Set(stats.trimmedSections)]
        };
        verbose(`提示词裁剪：聊天记录少带 ${stats.trimmedHistory} 条`
          + (stats.trimmedSections.length ? `；裁掉段落 ${[...new Set(stats.trimmedSections)].join('、')}` : ''));
      }

      // ④ 追加提示
      const extras = [];
      const owner = ownerId();
      if (owner && chatKey === `private:${owner}`) {
        const answered = listQuestions(`private:${owner}`, { status: 'answered' });
        const block = buildPendingAnswerBlock(answered);
        if (block) extras.push(block);
        const pending = listQuestions(`private:${owner}`, { status: 'pending' });
        const remind = buildAskReminderBlock(pending);
        if (remind) extras.push(remind);
      }
      if (chatKey && on('enableMemory')) {
        const flags = chatFlags(chatKey);
        if (flags.pendingConsolidateAt) {
          extras.push('【记忆整理 · 已排队】主人刚在控制台点了"整理记忆"。'
            + '请立刻调用 consolidate_memory 完成这次整理（它会过期清理、压缩标签、判定晋升、并从聊天记录里提取新记忆），'
            + '然后把一句话结论告诉主人（如果这是在群里，就不要把整理细节说给群友听）。');
        }
      }
      if (extras.length) {
        const idx = Math.max(0, messages.length - 1);
        messages.splice(idx, 0, { role: 'user', content: `（系统提示，不必直接回应）${extras.join('\n\n')}` });
      }

      // ⑤ 记下"真正发出去的内容" —— 控制台的「系统提示 / 本次输入」显示的是核心拼好的
      //    原文（钩子**之前**的），用户据此以为裁剪/标签没生效。这里把实发内容缓存起来，
      //    由 after-response 写回会话记录，控制台就能显示真实内容与真实字数。
      if (sessionId) {
        const parts = { system: [], user: [] };
        for (const m of messages) {
          if (!m || (m.role !== 'system' && m.role !== 'user')) continue;
          parts[m.role].push(contentText(m));
        }
        const system = parts.system.join('\n\n');
        const user = parts.user.join('\n\n');
        const snap = {
          at: Date.now(),
          system,
          user,
          total: system.length + user.length,
          coreSystemChars: Number(coreChars.system) || 0,
          coreUserChars: Number(coreChars.user) || 0,
          memory: stats.memory || null,
          historyKept: stats.trimmedHistory ? Number(cfg().historyLimit) : 0,
          historyCut: stats.trimmedHistory,
          sections: [...new Set(stats.trimmedSections)]
        };
        finalPromptCache.set(String(sessionId), snap);
        lastSentPrompt = {
          at: snap.at,
          total: snap.total,
          memory: snap.memory,
          historyKept: snap.historyKept,
          historyCut: snap.historyCut,
          sections: snap.sections
        };
      }
    } catch (error) {
      warn(`before-llm-messages 失败：${error?.message ?? error}`);
    }
  },

  /**
   * 一轮回答结束后，把"实发提示词"写回会话记录。
   * 目的：控制台「会话」页的「系统提示 / 本次输入」不再显示核心原文，而是**真正发出去**的
   * 内容（记忆段=标签档、已读信息=裁剪后的条数），省得用户以为没生效。
   * 只改这三个纯展示字段，不动任何运行时逻辑。
   */
  'after-response': ({ session, sessionId }) => {
    try {
      const id = String(session?.id || sessionId || '');
      if (!id || !session) return;
      const snap = finalPromptCache.get(id);
      if (!snap) return;
      if (typeof session.systemPrompt === 'string') session.systemPrompt = snap.system;
      if (typeof session.userPrompt === 'string') session.userPrompt = snap.user;
      if (snap.total) session.promptChars = snap.total;
      session.memoryPlus = {
        processed: true,
        coreChars: { system: snap.coreSystemChars, user: snap.coreUserChars },
        sentChars: snap.total,
        memory: snap.memory,
        history: snap.historyCut ? { kept: snap.historyKept, cut: snap.historyCut } : null,
        sections: snap.sections
      };
    } catch (error) {
      verbose(`after-response 写回实发提示词失败：${error?.message ?? error}`);
    }
  },

  /**
   * 工具执行之后做两件事：
   *   ① 工具结果太长就截断（enableToolCap / toolResultMaxChars）—— 防止一次检索把上下文塞满、把人设带偏
   *   ② 有人直接用核心的 memory_append 记长期记忆时，给它补一条类型旁注
   *      （这样"约定类优先用原文"对核心工具写进来的内容同样生效）
   * ⚠️ 这里**不动提及次数** —— 提及次数只由"重复记录/晋升"决定，按轮次自增会让数字飞涨。
   */
  'after-tool': ({ toolName, argsRaw, chatKey, result }) => {
    try {
      // ① 结果截断（默认关闭；打开后可以用 capOnlyTools 限定只截某几个工具，
      //    避免一刀切把 list_stickers / get_recent_messages 这类"列表即信息"的结果截坏）
      if (on('enableToolCap', false) && result && !result.isError) {
        const cap = Math.max(500, Number(cfg().toolResultMaxChars) || 4000);
        const only = String(cfg().capOnlyTools || '').split(/[\s,，、;；]+/).map((s) => s.trim()).filter(Boolean);
        const name = String(toolName || '');
        const hit = !only.length || only.some((k) => name === k || name.startsWith(k.endsWith('__') ? k : `${k}__`) || name.startsWith(k));
        if (hit && typeof result.content === 'string' && result.content.length > cap) {
          const cut = result.content.length - cap;
          result.content = `${result.content.slice(0, cap)}\n…（结果太长，已省略 ${cut} 字；需要细节请换更精确的条件再查一次）`;
          noteOperation(true, `已截断 ${toolName} 的结果（省略 ${cut} 字）`);
        }
      }
      // ② memory_append 的类型旁注 + **顺带镜像成短期记忆**
      //    实测模型很爱用它自己的老接口 memory_append（它的系统提示里就是这么教的），
      //    而几乎不调我们的 note_impression（200 个会话 0 次）。为了不让"短期记忆"永远是空的，
      //    这里把 memory_append 写进来的观察**同时**记一条短期记忆（按内容去重、会合并提及次数），
      //    这样"短期 → 判定 → 晋升/过期"这套流程照常运转。可用 mirrorCoreAppend 关掉。
      if (toolName === 'memory_append' && !result?.isError) {
        const content = trimText(argsRaw?.content, 300);
        if (content && chatKey) {
          const meta = getLongMeta(chatKey, content);
          if (!meta?.kind) {
            setLongMeta(chatKey, content, {
              kind: looksLikeAppointment(content) ? 'appointment' : 'general',
              hits: 0
            });
            saveState();
          }
          if (on('mirrorCoreAppend', true)) {
            const uid = String(argsRaw?.userId || argsRaw?.target || argsRaw?.member || argsRaw?.qq || '').replace(/\D/g, '');
            if (uid) {
              try {
                const nm = String(argsRaw?.name || '').trim() || `QQ${uid}`;
                const r = addShort(chatKey, uid, String(argsRaw?.name || ''), {
                  content: ensureSubject(content, nm),
                  kind: looksLikeAppointment(content) ? 'appointment' : 'general',
                  source: 'core'
                });
                verbose(`memory_append 已镜像成短期记忆：${content.slice(0, 40)}`);
                if (r?.merged) verbose('（与已有短期记忆合并，提及次数 +1）');
              } catch (error) {
                verbose(`镜像短期记忆失败：${error?.message ?? error}`);
              }
            }
          }
        }
      }
    } catch { /* 加工失败不影响主流程 */ }
  }
};

// ── 能力：tool.guard（运行期否决工具）──────────────────────────────────
// 这是核心**会主动来消费**的标准能力（多提供者）。用它做两件事：
//   · 拦掉配置里的"噪声工具"（默认 chat-archive__stats）
//   · 某个功能被关掉时，让对应工具直接不可用（界面会显示原因）
export const providers = {
  'tool.guard': ({ toolId }) => {
    const reason = blockReason(toolId);
    return reason ? { ok: false, reason } : undefined;   // undefined = 不归我管，放行
  }
};

/** 动态提示词片段：只有当本会话真的攒了"建议晋升"时才出现一行。 */
export function promptSections(ctx) {
  try {
    if (!on('enableMemory') || !on('enableShortTerm')) return [];
    const chatKey = ctx?.chatKey;
    if (!chatKey) return [];
    const c = cfg();
    const minHits = Math.max(1, Number(c.promoteMinHits) || 3);
    const map = chatMembers(chatKey);
    let n = 0;
    for (const entry of Object.values(map)) {
      for (const s of entry.short || []) {
        if ((Number(s.hits) || 0) >= minHits) n += 1;
      }
    }
    if (!n) return [];
    return [{
      id: 'memory-plus-pending',
      title: '待晋升的记忆',
      priority: 44,
      content: `本会话有 ${n} 条短期记忆已经达到"建议晋升"的提及次数。`
        + '如果这轮聊天自然相关，顺手用 promote_impression 把它们定下来（要写理由）；不合适就别硬做。'
    }];
  } catch {
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════
// 动作路由（控制台面板的写操作入口）
// ══════════════════════════════════════════════════════════════════════

export function registerRoutes(api) {
  const { registerPluginRoutes, readBody, json } = api;
  readBodyFn = readBody;
  jsonFn = json;

  const routes = [{
    method: '*',
    pattern: /^\/api\/skills\/memory-plus\/action\/([^/]+)$/,
    handler: async (ctx) => {
      // ⚠️ 动作键必须从 pathname 末段取：核那条通配路由的 match[1] 是插件 id、
      //    match[2] 才是键（app-control 为此专门写过一段注释）。
      const pathname = String(ctx.pathname || '');
      const key = decodeURIComponent(pathname.split('/').filter(Boolean).pop() || '');
      const body = ctx.method === 'GET' ? {} : await readBody(ctx.req);
      try {
        const out = await handleAction(key, body || {}, ctx);
        // 所有动作都在这里留一条"最近一次操作"的结论：界面常驻状态区一直显示它，
        // 用户不用等报错才知道发生了什么。
        const b = out?.body || {};
        if (b.ok === false) noteOperation(false, b.error || b.hint || `「${key}」没有成功`);
        else noteOperation(true, b.note || b.summary || describeAction(key, b));
        return json(ctx.res, out.status || 200, out.body);
      } catch (error) {
        const text = `记忆与存档优化动作执行失败：${String(error?.message ?? error)}`;
        noteOperation(false, text);
        return json(ctx.res, 502, { ok: false, error: text });
      }
    }
  }];

  return registerPluginRoutes('memory-plus', routes);
}

/** 面板动作分发。返回 {status, body}。 */
async function handleAction(key, body, ctx) {
  const chatKey = String(body.chatKey || '');
  const mustChat = () => {
    if (!/^(group|private):\d+$/.test(chatKey)) throw new Error(`chatKey 不对：${chatKey || '(空)'}`);
    return chatKey;
  };

  switch (key) {
    case 'overview': {
      if (chatKey) {
        mustChat();
        refreshLongSnapshot(chatKey);
        return { body: { ok: true, chatKey, data: chatOverview(chatKey) } };
      }
      const all = listChats();
      for (const k of all) refreshLongSnapshot(k);
      return { body: { ok: true, chats: all.map((k) => ({ chatKey: k, ...chatOverview(k) })), stats: stats(), archive: archiveSweepState() } };
    }

    /** 按 QQ 号的统一档案（跨会话合并）：列表 + 单人详情。 */
    case 'profiles': {
      const pdir = profileDirResolved(cfg());
      const list = listProfiles(pdir).map((p) => profileSummary(pdir, p.userId)).filter(Boolean);
      list.sort((a, b) => (b.long + b.portrait) - (a.long + a.portrait));
      return { body: { ok: true, dir: pdir, count: list.length, items: list, ttl: { long: Number(cfg().longTtlDays) || 0, short: Math.max(1, Number(cfg().shortTtlDays) || 2), minHits: Math.max(2, Number(cfg().promoteMinHits) || 3) } } };
    }

    case 'profile-detail': {
      const uid = String(body.userId || '').replace(/\D/g, '');
      if (!uid) throw new Error('缺少 userId');
      const pdir = profileDirResolved(cfg());
      const p = readProfile(pdir, uid);
      if (!p) return { body: { ok: false, error: `没有 ${uid} 的档案` } };
      return { body: { ok: true, profile: p, ttl: ttlOf(cfg()) } };
    }

    /** 画像调试：改 / 增 / 删 / 降级。id 为空按新增处理。 */
    case 'trait-save': {
      const uid = String(body.userId || '').replace(/\D/g, '');
      if (!uid) throw new Error('缺少 userId');
      const pdir = profileDirResolved(cfg());
      const text = trimText(body.text, 300);
      const dim = trimText(body.dim, 20) || '人格';
      const conf = Number(body.confidence);
      let saved = null;
      if (!body.id) {
        if (!text) throw new Error('画像内容不能为空');
        saved = addTrait(pdir, uid, '', { text, dim, confidence: Number.isFinite(conf) ? conf : 70, name: '' });
      } else {
        saved = updateTrait(pdir, uid, {
          id: String(body.id), text: body.text, dim: body.dim,
          confidence: Number.isFinite(conf) ? conf : null, status: body.status
        });
      }
      if (!saved) throw new Error('没找到这条画像（可能已被整理覆盖）');
      return { body: { ok: true, trait: saved, profile: readProfile(pdir, uid), ttl: ttlOf(cfg()) } };
    }

    case 'trait-delete': {
      const uid = String(body.userId || '').replace(/\D/g, '');
      if (!uid || !body.id) throw new Error('缺少 userId 或 id');
      const pdir = profileDirResolved(cfg());
      const n = removeTrait(pdir, uid, String(body.id));
      return { body: { ok: true, removed: n, profile: readProfile(pdir, uid), ttl: ttlOf(cfg()) } };
    }

    /** 降级：layer=trait 画像→长期；layer=long 长期→候选。 */
    case 'demote': {
      const uid = String(body.userId || '').replace(/\D/g, '');
      if (!uid || !body.id) throw new Error('缺少 userId 或 id');
      const layer = String(body.layer || 'long');
      const pdir = profileDirResolved(cfg());
      const r = layer === 'trait'
        ? demoteTraitToLong(pdir, uid, String(body.id))
        : demoteLongToCandidate(pdir, uid, String(body.id));
      if (!r) throw new Error(layer === 'trait' ? '没找到这条画像' : '没找到这条长期记忆');
      return { body: { ok: true, layer, text: r.text, profile: readProfile(pdir, uid), ttl: ttlOf(cfg()) } };
    }

    /** 手动触发一次自动降级（按设置里的天数扫全部档案）。 */
    case 'demote-sweep': {
      const pdir = profileDirResolved(cfg());
      const r = demoteStale(pdir, {
        longDays: Number(cfg().demoteLongDays) || 0,
        traitDays: Number(cfg().demoteTraitDays) || 0
      });
      return { body: { ok: true, ...r } };
    }

    /** 诊断用：这次整理能筛出哪些"角落句"（模型还没看，纯规则）。面板上也可以点开看。 */
    case 'keypoints': {
      const ck = String(body.chatKey || chatKey || '');
      if (!ck) throw new Error('缺少 chatKey');
      const days = Math.max(1, Math.min(30, Number(body.days) || 3));
      let raw = [];
      try { raw = readRecentFromDisk(ck, 1500) || []; } catch { raw = []; }
      const since = Date.now() - days * 86400000;
      const inRange = raw.filter((m) => m && Number(m.ts) >= since).length;
      const pts = keyPointScan(ck, { days, max: Math.max(6, Number(body.max) || 60) });
      return { body: { ok: true, chatKey: ck, days, archived: raw.length, inRange, count: pts.length, items: pts } };
    }

    /** 长期结论再升一级：写进人物画像（同一人被存档的最高层），长期条目打 promoted 标记，提示词里不重复。 */
    case 'promote-trait': {
      const uid = String(body.userId || '').replace(/\D/g, '');
      if (!uid) throw new Error('缺少 userId');
      const pdir = profileDirResolved(cfg());
      const r = promoteLongToTrait(pdir, uid, {
        id: String(body.id || ''), text: String(body.text || ''), dim: trimText(body.dim, 20) || '人格'
      });
      if (!r) throw new Error('没找到这条长期记忆（可能已被整理覆盖）');
      const p = readProfile(pdir, uid);
      return {
        body: {
          ok: true, already: !!r.already, userId: uid,
          traitId: (r.trait && r.trait.id) || '', text: r.item.text,
          profile: p, ttl: ttlOf(cfg())
        }
      };
    }

    /** 手动把长期记忆导出到 data/记忆/<会话>/长期记忆.json（强制刷新，跳过节流）。 */
    case 'export-snapshot': {
      const all = listChats();
      for (const k of all) refreshLongSnapshot(k, true);
      return { body: { ok: true, dir: dataDir(), chats: all.length } };
    }

    /** 手动跑一次交叉验证（把本会话多人的记忆放在一起核对，只出报告不改数据）。 */
    case 'cross-check': {
      mustChat();
      // 面板勾了几个人就只验这几个人（不传 = 全群，保持老行为）
      const wantIds = Array.isArray(body.userIds)
        ? body.userIds.map((x) => String(x || '').replace(/\D/g, '')).filter(Boolean)
        : [];
      const r = await crossCheck(chatKey, {
        settings: cfg(),
        longMembers: readLongMembersFromDisk(chatKey),
        apply: true,
        userIds: wantIds
      });
      return {
        body: {
          ok: r.ok !== false,
          count: (r.issues || []).length,
          issues: r.issues || [],
          note: r.note || '',
          error: r.error || '',
          userIds: wantIds,
          file: path.join(chatDirOf(chatKey), '_交叉验证.json')
        }
      };
    }

    /** 读回上一次交叉验证的报告：面板刷新后仍要把有问题的条目标红，不能跑完一刷新就没了。 */
    case 'xc-report': {
      mustChat();
      const file = path.join(chatDirOf(chatKey), '_交叉验证.json');
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        return {
          body: {
            ok: true,
            exists: true,
            checkedAt: Number(j.checkedAt) || 0,
            model: String(j.model || ''),
            batches: Number(j.batches) || 0,
            issues: Array.isArray(j.issues) ? j.issues : []
          }
        };
      } catch (err) {
        if (err && err.code === 'ENOENT') return { body: { ok: true, exists: false, issues: [] } };
        return { body: { ok: false, exists: false, issues: [], error: `读交叉验证报告失败：${err?.message ?? err}` } };
      }
    }

    case 'short-save': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      if (!userId) throw new Error('缺少 userId');
      const content = trimText(body.content, 400);
      if (!content) throw new Error('缺少 content');
      const r = addShort(chatKey, userId, body.name || '', {
        content,
        kind: KINDS.includes(body.kind) ? body.kind : (looksLikeAppointment(content) ? 'appointment' : 'general'),
        tags: body.tags,
        source: 'manual'
      });
      refreshSnapshotSoon();
      return { body: { ok: true, item: r.item, merged: r.merged } };
    }

    case 'short-delete': {
      mustChat();
      const ok = removeShort(chatKey, String(body.userId || '').replace(/\D/g, ''), String(body.shortId || ''));
      refreshSnapshotSoon();
      return { body: { ok } };
    }

    case 'short-kind': {
      mustChat();
      const item = setShortKind(chatKey, String(body.userId || '').replace(/\D/g, ''), String(body.shortId || ''), body.kind);
      if (!item) throw new Error('没找到这条短期记忆');
      refreshSnapshotSoon();
      return { body: { ok: true, item } };
    }

    case 'labels-save': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(/[，,、\s]+/);
      const labels = setLabels(chatKey, userId, tags, { pinned: body.pinned === true });
      refreshSnapshotSoon();
      return { body: { ok: true, labels } };
    }

    case 'label-add': {
      mustChat();
      const labels = addLabel(chatKey, String(body.userId || '').replace(/\D/g, ''), body.tag, { pinned: body.pinned === true });
      refreshSnapshotSoon();
      return { body: { ok: true, labels } };
    }

    case 'label-delete': {
      mustChat();
      const ok = removeLabel(chatKey, String(body.userId || '').replace(/\D/g, ''), String(body.tag || ''));
      refreshSnapshotSoon();
      return { body: { ok } };
    }

    /** 只给某一个人重新生成标签（面板上的"压缩标签"按钮走这条，不再全群跑一遍）。 */
    case 'labels-suggest': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      if (!userId) throw new Error('缺少 userId');
      const c = cfg();
      const entry = getMember(chatKey, userId) || { short: [], labels: [] };
      const long = readLongFromDisk(chatKey, userId);
      const judged = await judgeMember({
        name: long.name || entry.name || userId,
        long: long.impressions,
        shorts: entry.short,
        maxTags: Math.max(1, Number(c.labelsPerMember) || 6)
      });
      const keep = (entry.labels || []).filter((l) => l.pinned).map((l) => l.tag);
      const tags = [...new Set([...keep, ...judged.tags])].slice(0, Math.max(1, Number(c.labelsPerMember) || 6));
      // 模型失败时一个字都不动（否则会把已有标签洗掉）
      if (tags.length && !judged.error) setLabels(chatKey, userId, tags, { sourceIds: entry.short.map((s) => s.id) });
      refreshSnapshotSoon();
      return {
        body: {
          ok: !!(!judged.error && tags.length),
          tags: judged.error ? [] : tags,
          raw: judged.raw || '',
          error: judged.error || '',
          hint: judged.error ? '' : (tags.length ? '' : '模型这次没给出可用标签，可以让它再试一次，或手工加标签。')
        }
      };
    }

    case 'promote': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      const shortId = String(body.shortId || '');
      const entry = getMember(chatKey, userId);
      const item = (entry?.short || []).find((s) => s.id === shortId);
      if (!item) throw new Error('没找到这条短期记忆（可能已被处理）');
      const reason = trimText(body.reason, 200) || '控制台人工晋升';
      const r = promoteShortItem(chatKey, userId, shortId, { reason, by: 'manual' });
      if (!r) throw new Error('晋升失败：这条短期记忆已经不在了');
      refreshSnapshotSoon();
      // 0.5 面板是沙箱 iframe，够不到核心的 PUT /api/memory-files，所以在这里把正文写进核心长期记忆。
      // 没 ctx（例如从别的路径调用）就跳过，交给调用方自己补 —— 但面板路径一定有 ctx。
      let longWritten = false;
      try {
        if (typeof ctx?.memory?.append === 'function') {
          const add = ctx.memory.append(chatKey, { userId, name: entry?.name || '', content: r.content });
          longWritten = add?.ok !== false;
        }
      } catch (error) {
        warn(`晋升后写核心长期记忆失败：${error?.message ?? error}`);
      }
      return { body: { ok: true, userId, name: entry?.name || '', content: r.content, kind: r.kind, hits: r.hits, reason, longWritten } };
    }

    /** 面板读核心长期印象（只读磁盘，不走核心缓存，避免把别人的缓存改动带进来）。 */
    case 'long-list': {
      mustChat();
      return { body: { ok: true, chatKey, members: readLongMembersFromDisk(chatKey) } };
    }

    /** 面板删核心长期印象：按正文精确删几条。 */
    case 'long-delete': {
      mustChat();
      const userId = String(body.userId || '').replace(/\D/g, '');
      if (!userId) throw new Error('缺少 userId');
      if (typeof ctx?.memory?.remove !== 'function') throw new Error('核心记忆写入接口不可用（插件需要 fs.outsideNamespace 权限）');
      const name = String(body.name || '');
      const contents = (Array.isArray(body.contents) ? body.contents : [String(body.content || '')])
        .map((x) => String(x || '')).filter(Boolean);
      if (!contents.length) throw new Error('没有选中要删除的印象');
      let removed = 0;
      const failed = [];
      for (const content of contents) {
        try {
          const out = ctx.memory.remove(chatKey, { userId, name, content });
          if (out?.ok === false) failed.push(out.error || content); else removed += Number(out?.removed) || 1;
        } catch (error) {
          failed.push(String(error?.message ?? error));
        }
      }
      refreshSnapshotSoon();
      if (!removed && failed.length) throw new Error(`一条也没删掉：${failed[0]}`);
      return { body: { ok: true, removed, failed } };
    }

    case 'questions': {
      return { body: { ok: true, questions: chatKey ? listQuestions(mustChat()) : [] } };
    }

    case 'question-resolve': {
      mustChat();
      const q = resolveQuestion(chatKey, String(body.questionId || ''), trimText(body.decision, 300), { action: body.action || 'manual' });
      if (!q) throw new Error('没找到这条问题');
      refreshSnapshotSoon();
      return { body: { ok: true, question: q } };
    }

    case 'question-answer': {
      mustChat();
      const q = answerQuestion(chatKey, String(body.questionId || ''), trimText(body.answer, 600));
      if (!q) throw new Error('没找到这条问题');
      refreshSnapshotSoon();
      return { body: { ok: true, question: q } };
    }

    case 'prune-preview': {
      mustChat();
      const from = parseTime(body.from, { endOfDay: false }) ?? 0;
      const to = parseTime(body.to, { endOfDay: true }) ?? Number.MAX_SAFE_INTEGER;
      const r = searchLocalArchive(chatKey, { from, to, limit: 1, includeSelf: true });
      if (!r.ok) return { body: { ok: false, error: r.error } };
      return { body: { ok: true, count: r.matched, from: stampOf(from), to: to === Number.MAX_SAFE_INTEGER ? '不限' : stampOf(to), total: r.scanned } };
    }

    case 'prune': {
      mustChat();
      const from = parseTime(body.from, { endOfDay: false }) ?? 0;
      const to = parseTime(body.to, { endOfDay: true }) ?? Number.MAX_SAFE_INTEGER;
      if (!body.confirm) throw new Error('没有确认（confirm=false）：删除存档不可撤销，请先确认');
      const disk = pruneRangeLocal(chatKey, { from, to, backup: cfg().archiveBackupBeforePurge !== false });
      // 再排一次队：如果这个会话正被核心持有（内存缓存），下一次运行时用活 store 再删一次，
      // 否则内存里的旧消息会在下一次写入时"复活"。
      addPendingPrune(chatKey, { from, to, note: trimText(body.note, 100) || '面板手动删除' });
      recordPurge({ chatKey, removed: disk.removed || 0, reason: 'manual-range', backupPath: disk.backupPath });
      refreshSnapshotSoon();
      return { body: { ok: true, removed: disk.removed || 0, backupPath: disk.backupPath || '', queued: true } };
    }

    /** 存档备份列表（一键回档用）。 */
    case 'backups': {
      mustChat();
      return { body: { ok: true, backups: listBackups(chatKey) } };
    }

    /** 一键回档：用某一份备份覆盖当前存档。 */
    case 'backup-restore': {
      mustChat();
      const r = restoreBackup(chatKey, body.file);
      if (!r.ok) throw new Error(r.error || '回档失败');
      refreshSnapshotSoon();
      return { body: { ok: true, ...r } };
    }

    case 'sweep-now': {
      const skip = body.skipActive ? [String(body.skipActive)] : [];
      const r = sweepOldMessages({
        retainDays: cfg().archiveRetainDays,
        backup: cfg().archiveBackupBeforePurge !== false,
        skipKeys: skip
      });
      setArchiveSweep();
      recordPurge({ removed: r.removed, reason: 'sweep-manual', chats: r.purged });
      // 顺手清掉已经过期的约定：这类条目留着只会让机器人翻旧账
      const appt = sweepDueAppointments({ graceHours: Number(cfg().appointmentGraceHours) || 12 });
      refreshSnapshotSoon();
      return { body: { ok: true, ...r, apptExpired: appt.removed, apptItems: (appt.items || []).slice(0, 50), details: (r.details || []).slice(0, 50) } };
    }

    /** 整理记忆：起一个后台任务，立刻返回；面板轮询 consolidate-status 看进度。 */
    case 'consolidate': {
      mustChat();
      if (job && !job.done) throw new Error(`已经有整理任务在跑（${job.chatKey}，第 ${job.step}/${job.total || '?'} 步）`);
      startConsolidateJob(chatKey, { extract: body.extract, judge: body.judge !== false, days: body.days, userIds: body.userIds });
      return { body: { ok: true, started: true, job: jobSnapshot() } };
    }

    case 'consolidate-status': {
      return { body: { ok: true, ...jobSnapshot() } };
    }

    /** 界面常驻状态区：任务进度 + 标签队列 + 最近一次操作 + 计数 + 专用模型是否生效。 */
    case 'status': {
      return { body: statusSnapshot(chatKey) };
    }

    /** 自检：插件在应用进程里到底能不能看到存档（排查"自动提取没对象"这类问题用）。 */
    case 'diag': {
      const chats = archivedChats();
      const c = cfg();
      return {
        body: {
          ok: true,
          dataDir: dataDir(),
          messagesDir: messagesDir(),
          chats: chats.map(({ chatKey }) => {
            const rows = readRecentFromDisk(chatKey, 400);
            return {
              chatKey,
              rows: rows.length,
              newest: rows.length ? new Date(Number(rows[rows.length - 1].ts)).toLocaleString('zh-CN') : '',
              lastAutoExtractAt: Number(chatFlags(chatKey).lastAutoExtractAt) || 0
            };
          }),
          settings: {
            autoExtractEnabled: c.autoExtractEnabled !== false,
            intervalHours: Number(c.autoExtractIntervalHours) || 3,
            minNew: Number(c.autoExtractMinNewMessages) || 20,
            mirrorCoreAppend: c.mirrorCoreAppend !== false,
            scan: Number(c.consolidateArchiveScanCount) || 120
          },
          busy: autoExtractBusy,
          jobState: job ? (job.done ? 'done(已结束，不影响提取)' : 'running') : 'idle',
          backoffUntil: autoExtractBackoffUntil,
          lastExtractError,
          counts: stats()
        }
      };
    }

    /** 跳过"够久/够多"的检查，立刻跑一次自动提取（面板按钮 + 核实用）。 */
    case 'extract-now': {
      const before = stats();
      const probe = archivedChats().map(({ chatKey }) => {
        const rows = readRecentFromDisk(chatKey, 400);
        return { chatKey, rows: rows.length, last: Number(chatFlags(chatKey).lastAutoExtractAt) || 0 };
      });
      const r = await maybeAutoExtract({ force: true });
      const after = stats();
      if (!r) {
        noteOperation(false, '手动提取：这次没有可提取的对象（没攒够新消息，或正在等限流重试）');
        return { body: { ok: false, note: '这次没有可提取的对象（可能还没攒够新消息，或正在等限流重试）；也可以点「整理本记忆」强制整理一遍', before, after, probe } };
      }
      if (r.error) {
        noteOperation(false, `手动提取失败：${r.error}`);
        return { body: { ok: false, ...r, before, after, probe, note: `提取失败：${r.error}` } };
      }
      noteOperation(true, r.added
        ? `手动提取：从 ${r.chatKey} 记下 ${r.added} 条短期记忆`
        : `手动提取：${r.chatKey} 里没有值得记的新内容`);
      refreshSnapshotSoon();
      return { body: { ok: true, ...r, before, after, note: r.added ? `提取到 ${r.added} 条短期记忆` : '没有值得记的新内容' } };
    }

    /** 把某个会话的所有人排进标签队列（一次一个人、间隔 30 秒）。 */
    case 'queue-start': {
      mustChat();
      const n = enqueueAllLabels(chatKey);
      return { body: { ok: true, queued: n, note: `已排队：${n} 个人，每 30 秒处理一个，刷新状态即可看进度` } };
    }

    case 'queue-clear': {
      mustChat();
      clearLabelQueue(chatKey);
      if (labelQueueChat === chatKey) labelQueueChat = '';
      refreshSnapshotSoon();
      return { body: { ok: true, note: '已清空标签队列' } };
    }

    case 'enqueue-consolidate': {
      mustChat();
      chatFlags(chatKey, { pendingConsolidateAt: Date.now() });
      return { body: { ok: true, queued: true, note: '已排队：该会话下一次运行时模型会立刻整理' } };
    }

    /** 刷新群名片：群友在 QQ 里改了昵称，记忆里存的还是建档那天的旧名 —— 拉一次实时名单把 name 对齐。
     *  只改 name，不动任何记忆正文；store 里没有的人（从没发过言）不凭空建档。 */
    case 'refresh-names': {
      if (!/^group:\d+$/.test(chatKey)) return { body: { ok: false, error: '只有群聊才有群名片可刷' } };
      const chatId = chatKey.split(':')[1];
      let list = [];
      try {
        const r = await fetch(`http://127.0.0.1:3210/api/groups/${chatId}/members`, { signal: AbortSignal.timeout(15000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        list = ((await r.json()) || {}).members || [];
      } catch (error) {
        return { body: { ok: false, error: `拉群成员名单失败：${String(error?.message ?? error)}` } };
      }
      const chat = chatState(chatKey, { create: false });
      const changed = [];
      let updated = 0;
      for (const m of list) {
        const uid = String(m.userId || '').trim();
        const live = String(m.card || m.nickname || '').trim();
        if (!uid || !live) continue;
        const rec = chat && chat.members && chat.members[uid];
        if (!rec) continue;
        if (String(rec.name || '') !== live) {
          changed.push(`${rec.name || uid}→${live}`);
          rec.name = live;
          updated += 1;
        }
      }
      if (updated) { saveState(); refreshSnapshot(); }
      return {
        body: {
          ok: true, scanned: list.length, updated, changed: changed.slice(0, 12),
          note: updated ? `已刷新 ${updated} 个昵称：${changed.slice(0, 4).join('、')}${updated > 4 ? '…' : ''}` : '昵称都跟群里一致'
        }
      };
    }

    /** 重新扫描：把插件与技能全部重扫一遍，并强制刷新本插件的数据快照。 */
    case 'rescan': {
      const r = await rescanSkills();
      refreshSnapshot();
      return { body: { ok: true, ...r } };
    }

    case 'snapshot': {
      const ok = refreshSnapshot();
      return { body: { ok, generatedAt: lastSnapshotAt } };
    }

    case 'host-status': {
      return { body: { ok: true, host: hostStatus() } };
    }

    case 'host-reinstall': {
      const r = await installHost({ log });
      // 这是用户显式点的"重装面板"，所以无论文件有没有变都刷新一次控制台
      const reload = await reloadConsole();
      refreshSnapshot();
      return { body: { ok: r.ok !== false, ...r, reload } };
    }

    case 'host-remove': {
      const r = await removeHost({ log });
      const reload = r.changed ? await reloadConsole() : { count: 0, error: '没有改动，不需要刷新' };
      return { body: { ok: r.ok !== false, ...r, reload } };
    }

    case 'expire-now': {
      const r = expireShort(cfg().shortTtlDays);
      refreshSnapshotSoon();
      return { body: { ok: true, ...r } };
    }

    case 'data-dir': {
      return { body: { ok: true, dir: dataDir() } };
    }

    default:
      return { status: 404, body: { ok: false, error: `未知动作：${key}` } };
  }
}

/** 从磁盘读某个人的长期记忆（面板动作没有 ctx.memory，只能读文件；只读，不写）。 */
function readLongFromDisk(chatKey, userId) {
  const all = readLongMembersFromDisk(chatKey);
  const hit = all.find((m) => String(m.userId) === String(userId));
  return hit ? { name: hit.name, impressions: hit.impressions } : { name: String(userId || ''), impressions: [] };
}

// 长期记忆快照的节流时间戳（每会话 60 秒最多导一次）
const longSnapshotAt = new Map();

/**
 * 把某个会话的长期记忆导出成 data/记忆/<会话>/长期记忆.json。
 * 只读副本：正文真相在核心 data/memory，这里只是给人看/备份用。
 */
function refreshLongSnapshot(chatKey, force = false) {
  const now = Date.now();
  const last = longSnapshotAt.get(chatKey) || 0;
  if (!force && now - last < 60000) return;
  longSnapshotAt.set(chatKey, now);
  try {
    writeLongSnapshot(chatKey, readLongMembersFromDisk(chatKey));
  } catch (error) {
    verbose(`导出长期快照失败：${error?.message ?? error}`);
  }
}

/** 核心数据根（<应用>/data），长期记忆正文在它下面的 memory/。
 *  ⚠️ 不能用 dataDir() 往上退：dataDir() 现在是用户指定的记忆文件夹，
 *  退一级会指到桌面这类位置，长期记忆就读不到了。 */
function dataDirRoot() {
  return path.dirname(coreMemoryRoot());
}

/** 起一个整理任务（后台跑，前端轮询进度）。 */
function startConsolidateJob(chatKey, opts) {
  job = {
    id: `j${Date.now().toString(36)}`,
    chatKey,
    startedAt: Date.now(),
    finishedAt: 0,
    label: '准备中',
    step: 0,
    total: 0,
    done: false,
    ok: true,
    summary: '',
    error: '',
    result: null
  };
  const mine = job;
  (async () => {
    try {
      const r = await consolidateChat({ chatKey, memory: null, store: null }, {
        extract: opts.extract,
        judge: opts.judge !== false,
        apply: true,
        days: opts.days,
        userIds: opts.userIds,
        onProgress: (p) => {
          if (job === mine) { job.label = p.label || job.label; job.step = p.step || 0; job.total = p.total || 0; }
        }
      });
      mine.result = r;
      mine.summary = r.summary;
      mine.ok = r.ok !== false;
    } catch (error) {
      mine.error = String(error?.message ?? error);
      mine.ok = false;
      mine.summary = `整理失败：${mine.error}`;
    } finally {
      mine.done = true;
      mine.finishedAt = Date.now();
      chatFlags(chatKey, { pendingConsolidateAt: 0 });
      refreshSnapshotSoon();
    }
  })();
  return job;
}

function jobSnapshot() {
  if (!job) return { running: false, job: null };
  const running = !job.done;
  return {
    running,
    job: {
      id: job.id,
      chatKey: job.chatKey,
      label: job.label,
      step: job.step,
      total: job.total,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      ok: job.ok,
      summary: job.summary,
      error: job.error,
      promotions: job.result?.promotions || [],
      labels: job.result?.labels || [],
      expired: job.result?.expired || { removed: 0 },
      extracted: job.result?.extracted || 0,
      queued: job.result?.queued || 0,
      diagnostics: job.result?.diagnostics || []
    }
  };
}

/** 只数一下磁盘上有几个长期记忆文件（状态区每几秒就会取一次，别在这儿解析全部 JSON）。 */
function countLongFromDisk(chatKey) {
  const key = String(chatKey || '');
  if (!key) return 0;
  const dir = path.join(dataDirRoot(), 'memory', key.replace(/[^a-z0-9_]/gi, '_'));
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json') && f !== '_meta.json').length;
  } catch {
    return 0;
  }
}

/** 界面常驻状态区要的全部信息。 */
function statusSnapshot(chatKey) {
  const c = cfg();
  const members = chatKey ? chatMembers(chatKey) : {};
  let short = 0;
  let labels = 0;
  for (const m of Object.values(members)) {
    short += (m.short || []).length;
    labels += (m.labels || []).length;
  }
  const flags = chatKey ? chatFlags(chatKey) : { lastConsolidatedAt: 0, pendingConsolidateAt: 0 };
  const q = chatKey ? getLabelQueue(chatKey) : { uids: [], done: [], failed: [], nextAt: 0 };
  const js = jobSnapshot();
  const dedicated = llmMod.resolveDedicatedApi(c);
  // 交叉验证用的那条通道（没单独配就跟随整理模型）
  const xcDedicated = llmMod.resolveDedicatedApi({
    modelProvider: String(c.crossCheckProvider || c.modelProvider || ''),
    modelName: String(c.crossCheckModel || c.modelName || '')
  });
  const activeChat = labelQueueChat || chatKey;
  const qa = activeChat ? getLabelQueue(activeChat) : q;
  return {
    ok: true,
    chatKey: chatKey || '',
    running: js.running,
    job: js.job,
    queue: {
      active: qa.uids.length > 0,
      chatKey: qa.uids.length ? activeChat : '',
      remaining: qa.uids.length,
      done: qa.done.length,
      failed: qa.failed,
      total: qa.uids.length + qa.done.length + qa.failed.length,
      nextInSec: qa.uids.length ? Math.max(0, Math.ceil(((qa.nextAt || 0) - Date.now()) / 1000)) : 0
    },
    last: lastOperation,
    counts: {
      long: countLongFromDisk(chatKey),
      short,
      labels,
      pendingQuestions: chatKey ? listQuestions(chatKey).filter((x) => x.status !== 'resolved').length : 0
    },
    lastConsolidatedAt: flags.lastConsolidatedAt,
    pendingConsolidateAt: flags.pendingConsolidateAt || 0,
    model: {
      provider: String(c.modelProvider || ''),
      model: String(c.modelName || ''),
      dedicated: !!(dedicated && dedicated.api),
      error: (dedicated && dedicated.error) || '',
      // 交叉验证单独配的模型（空 = 跟随上面这个）
      xcProvider: String(c.crossCheckProvider || ''),
      xcModel: String(c.crossCheckModel || ''),
      xcError: (xcDedicated && xcDedicated.error) || '',
      xcEnabled: c.crossCheckEnabled !== false
    },
    // 功能开关的当前实际状态（面板状态区直接显示，一眼看出哪些被关了）
    switches: {
      memory: on('enableMemory'),
      shortTerm: on('enableShortTerm'),
      labelFirst: on('enableLabelFirst'),
      archiveTools: on('enableArchiveTools'),
      toolCap: on('enableToolCap'),
      toolGuard: on('enableToolGuard'),
      historyTrim: on('enableHistoryTrim'),
      systemTrim: on('enableSystemTrim'),
      uiPanel: on('uiPanel')
    },
    // 花名册覆盖情况：发过言的人里有多少已经有记忆（面板显示"为什么有人没进记忆"）
    roster: (() => {
      try {
        const all = Object.entries(chatMembers(chatKey) || {}).map(([uid, m]) => ({
          uid,
          name: m.name || uid,
          count: Number(m.seen?.count) || 0,
          has: (m.short || []).length > 0 || (m.labels || []).length > 0
        }));
        const covered = all.filter((m) => m.has).length;
        return {
          total: all.length,
          covered,
          empty: all.length - covered,
          // 发言最多但还没记忆的几位（面板提示"这些人还没进记忆"）
          missing: all.filter((m) => !m.has).sort((a, b) => b.count - a.count).slice(0, 8).map((m) => `${m.name}(${m.count})`)
        };
      } catch { return { total: 0, covered: 0, empty: 0, missing: [] }; }
    })(),
    limits: {
      historyLimit: Number(c.historyLimit) || 0,
      toolResultMaxChars: Number(c.toolResultMaxChars) || 0,
      capOnlyTools: String(c.capOnlyTools || '').split(/[\s,，、;；]+/).filter(Boolean),
      mirrorCoreAppend: c.mirrorCoreAppend !== false,
      autoExtract: c.autoExtractEnabled !== false,
      autoExtractIntervalHours: Number(c.autoExtractIntervalHours) || 3,
      autoExtractMinNewMessages: Number(c.autoExtractMinNewMessages) || 20,
      blockedTools: String(c.blockedTools || '').split(/[\s,，、;；]+/).filter(Boolean)
    },
    // 最近一次提示词裁剪（面板显示"裁了多少条记录 / 裁了哪几段"）
    trim: { at: lastTrim.at, history: lastTrim.history, sections: lastTrim.sections },
    // 最近一次"真正发出去"的提示词摘要（面板用它证明裁剪/标签确实生效了）
    sent: {      at: lastSentPrompt.at,
      total: lastSentPrompt.total,
      memory: lastSentPrompt.memory,
      historyKept: lastSentPrompt.historyKept,
      historyCut: lastSentPrompt.historyCut,
      sections: lastSentPrompt.sections
    },
    host: undefined
  };
}

/** 给"最近一次操作"配一句人话（动作返回体里没有 note/summary 时用）。 */
function describeAction(key, body = {}) {
  switch (key) {
    case 'short-save': return body.merged ? '同一件事又记了一次，提及次数 +1' : '已记下一条短期记忆';
    case 'short-delete': return '已删除一条短期记忆';
    case 'short-kind': return '已修改这条短期记忆的类型';
    case 'labels-save': return `已保存标签（${(body.labels || []).length} 个）`;
    case 'label-add': return '已添加标签';
    case 'label-delete': return '已删除标签';
    case 'labels-suggest': return `标签已更新：${(body.tags || []).join(' · ') || '（无）'}`;
    case 'promote': return `已晋升为长期记忆${body.hits ? `（提及×${body.hits}）` : ''}`;
    case 'prune': return `已删除 ${body.removed || 0} 条聊天记录，并已排队复核`;
    case 'backup-restore': return `回档完成：恢复 ${body.restored || 0} 条记录`;
    case 'sweep-now': return `存档清理完成：${body.purged || 0} 个会话、共 ${body.removed || 0} 条`;
    case 'expire-now': return `已清理过期短期记忆 ${body.removed || 0} 条`;
    case 'rescan': return `已重新扫描：${body.loaded || 0} 个扩展${(body.failed || []).length ? `，${body.failed.length} 个失败` : ''}`;
    case 'question-resolve': return '已落定这条待裁决问题';
    case 'question-answer': return '已代答这条待裁决问题';
    case 'snapshot': return '状态已刷新';
    case 'consolidate': return body.started ? '已开始整理，进度会显示在右边' : '整理已提交';
    case 'queue-start': return body.note || '已排队';
    case 'extract-now': return body.note || '已尝试提取';    case 'queue-clear': return '已清空标签队列';
    case 'host-reinstall': return '面板已重装';
    default: return '';
  }
}

/** 重扫插件与技能（走核心自己的加载器，和「重新扫描」按钮同一套语义）。 */
async function rescanSkills() {
  try {
    const mod = await import('../../src/plugin-loader.js');
    const result = await mod.loadPlugins({ log });
    return {
      loaded: (result.loaded || []).length,
      failed: (result.failed || []).map((f) => ({ id: f.id, error: f.error })),
      pruned: result.pruned || []
    };
  } catch (error) {
    return { loaded: 0, failed: [], pruned: [], error: String(error?.message ?? error) };
  }
}

function chatOverview(chatKey) {
  const members = chatMembers(chatKey);
  const flags = chatFlags(chatKey);
  const questions = listQuestions(chatKey);
  return {
    chatKey,
    lastConsolidatedAt: flags.lastConsolidatedAt,
    pendingConsolidateAt: flags.pendingConsolidateAt,
    pendingPrune: flags.pendingPrune,
    questions,
    members: Object.entries(members).map(([userId, m]) => ({
      userId,
      name: m.name,
      short: m.short,
      labels: m.labels
    })),
    // 长期记忆的旁注（类型 / 提及次数 / 晋升理由），按正文原文匹配 —— 面板用它显示"约定"标记
    meta: Object.values(longMetaMap(chatKey)).map((m) => ({
      content: String(m.content || ''),
      kind: m.kind || '',
      hits: Number(m.hits) || 0,
      reason: String(m.reason || ''),
      updatedAt: Number(m.updatedAt) || 0
    }))
  };
}

// ══════════════════════════════════════════════════════════════════════
// 面板数据快照 + 定时器 + 生命周期
// ══════════════════════════════════════════════════════════════════════

let snapshotTimer = null;

/** 生成并写出前端面板读的静态快照（只含本插件的数据；长期记忆由面板直接问核心要）。 */
export function refreshSnapshot() {
  try {
    const chats = listChats().map((k) => chatOverview(k));
    const payload = {
      generatedAt: Date.now(),
      version: 2,
      dataDir: dataDir(),
      stats: stats(),
      kindLabels: KIND_LABELS,
      // 面板要按设置显示（短期保留天数、存档保留天数…），所以把当前设置也带上
      settings: { ...cfg() },
      host: hostStatus(),
      archive: { overview: archiveOverview().slice(0, 80), sweep: archiveSweepState() },
      chats
    };
    lastSnapshotAt = Date.now();
    return writeSnapshot(payload);
  } catch (error) {
    warn(`生成面板快照失败：${error?.message ?? error}`);
    return false;
  }
}

function refreshSnapshotSoon() {
  // 以前这里是 setTimeout 300ms 后再重建。面板上点一下改数据的按钮（删标签 / 删短期 / 记下 / 晋升）
  // 动作返回后前端会立刻重新拉快照，正好落在延迟窗口里，拉到的还是旧数据，
  // 表现就是"点了没反应、删不掉"。快照重建是同步写文件，成本很低，这里直接同步做。
  if (snapshotTimer) { clearTimeout(snapshotTimer); snapshotTimer = null; }
  try { refreshSnapshot(); } catch { /* ignore */ }
}

/** 到点检查存档定期清理（默认 30 天一次）。 */
function maybeSweepArchive(force = false) {
  const c = cfg();
  if (c.archiveCleanupEnabled === false && !force) return null;
  const intervalMs = Math.max(1, Number(c.archiveCleanupIntervalDays) || 30) * 86400000;
  const last = archiveSweepState().lastSweepAt || 0;
  if (!force && Date.now() - last < intervalMs) return null;
  const r = sweepOldMessages({
    retainDays: c.archiveRetainDays,
    backup: c.archiveBackupBeforePurge !== false
  });
  setArchiveSweep();
  recordPurge({ removed: r.removed, reason: 'sweep-auto', chats: r.purged });
  if (r.removed) log(`存档定期清理：${r.purged} 个会话、共 ${r.removed} 条（保留 ${c.archiveRetainDays} 天）`);
  return r;
}

/**
 * 过期待办清理（比存档清理勤得多）。
 *
 * 约定类一到点就该消失：留着它，模型每轮都读到，然后反复提
 * "你不是答应过今天三点起来吗" —— 这种记忆留在库里就是负资产。
 * 进程内节流；重启后启动检查会强制扫一次（见 startTimers 的 boot）。
 */
let lastApptSweepAt = 0;
function maybeSweepAppointments(force = false) {
  const c = cfg();
  if (c.apptCleanupEnabled === false && !force) return null;
  const intervalMs = Math.max(1, Number(c.apptCleanupIntervalHours) || 24) * 3600000;
  if (!force && Date.now() - lastApptSweepAt < intervalMs) return null;
  lastApptSweepAt = Date.now();
  const r = sweepDueAppointments({ graceHours: Number(c.appointmentGraceHours) || 12 });
  if (r.removed) log(`过期待办清理：${r.removed} 条（${r.chats} 个会话）`);
  return r;
}

/**
 * 花名册：把"在群里说过话的人"全部登记成记忆页里的成员。
 *
 * 用户反馈："为什么有些发过言的群友没有加入记忆？" —— 因为以前成员只有在
 * **被模型记了一条**之后才会出现，23 个发言人里只有 11 个有记录，剩下 12 个像没来过。
 * 这里用死规则补齐：谁说话谁就在册（累计发言数、首末次时间），完全不花模型调用。
 * 印象/标签之后由提取与压缩慢慢长上去。为避免重复计数，只处理上次之后的新消息。
 */
const rosterAt = new Map();   // chatKey -> 上次扫描时间（进程内节流）

function refreshRoster(chatKey, { force = false, ttlMs = 10 * 60 * 1000 } = {}) {
  if (!chatKey) return 0;
  const last = rosterAt.get(chatKey) || 0;
  if (!force && Date.now() - last < ttlMs) return 0;
  rosterAt.set(chatKey, Date.now());
  const since = Number(chatFlags(chatKey).lastRosterAt) || 0;
  // 首次（或很久没扫）时把窗口放大，做一次"补录"：把以前说过话、但当时没进记忆的人补进花名册
  const scan = since ? 800 : 3000;
  const rows = readRecentFromDisk(chatKey, scan);
  let added = 0;
  let maxTs = since;
  for (const m of rows) {
    if (!m || m.self || m.recalled || m.isPoke) continue;
    const ts = Number(m.ts) || 0;
    if (ts <= since) continue;
    const uid = String(m.senderId || '').replace(/\D/g, '');
    if (!uid) continue;
    try {
      if (touchMemberSeen(chatKey, uid, String(m.senderName || ''), ts)) added += 1;
    } catch (error) {
      verbose(`登记群友失败（${uid}）：${error?.message ?? error}`);
    }
    if (ts > maxTs) maxTs = ts;
  }
  if (maxTs > since) {
    chatFlags(chatKey, { lastRosterAt: maxTs });
    saveState();
  }
  if (added) verbose(`花名册：${chatKey} 新增 ${added} 位发过言的群友`);
  return added;
}

/**
 * 规则提取：**不花任何 token** 地把聊天记录里"明确约定/承诺"类的话记成短期记忆。
 *
 * 为什么需要它：模型额度会限流（实测渠道 429 tpm/rpm 超限时，整理一整天都是 0 条），
 * 而"约定类"恰恰是最不能丢的记忆。所以用死规则兜一层：只认**别人说的**、
 * 同时含"承诺动词 + 明确时间"的短句，一次最多两条，宁可少记也不误记。
 * @returns {Array<{userId:string,name:string,content:string,kind:string}>}
 */
const RULE_PROMISE = /(说好|说定了|说定|答应|约好|约定|别忘了|别忘|记得|回头|待会儿|晚点)/;
const RULE_TIME = /(明天|后天|大后天|今晚|今天晚上|晚上|早上|中午|下午|凌晨|周[一二三四五六日天末]|星期[一二三四五六日天]|\d{1,2}\s*[点:：]\s*\d{0,2})/;

function ruleExtract(chatKey, { scan = 200, since = 0, limit = 2 } = {}) {
  const rows = readRecentFromDisk(chatKey, scan);
  const out = [];
  const seen = new Set();
  for (let i = rows.length - 1; i >= 0 && out.length < limit; i -= 1) {
    const m = rows[i];
    if (!m || m.self || m.recalled || m.isPoke || !m.text) continue;
    if (Number(m.ts) <= Number(since || 0)) continue;
    const text = String(m.text).replace(/\s+/g, ' ').replace(/\[[^\]]*\]/g, '').trim();
    if (text.length < 6 || text.length > 100) continue;
    if (!RULE_PROMISE.test(text) || !RULE_TIME.test(text)) continue;
    if (/^(哈+|笑死|草|6+|？+|\?+)$/.test(text)) continue;
    const uid = String(m.senderId || '').replace(/\D/g, '');
    if (!uid) continue;
    const key = `${uid}:${text.slice(0, 40)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ userId: uid, name: String(m.senderName || ''), content: text.slice(0, 100), kind: 'appointment' });
  }
  return out;
}

/**
 * 自动从聊天记录里提取"新的稳定观察"→ 短期记忆。
 *
 * 为什么必须有这个：实测模型**几乎不主动记录**（200 个会话里 note_impression 被调用 0 次），
 * 光靠提示词教育它，"短期记忆"会永远是空的。所以这里兜一层确定性的：
 * 某会话距上次提取 ≥ N 小时、且期间攒够 ≥ M 条新消息时，自动提取一次（一次只处理一个会话）。
 * 成本：约每个会话每 N 小时一次模型调用（默认 3 小时 / 20 条），可以用设置关掉。
 * @returns {Promise<{chatKey:string,added:number}|null>}
 */
let autoExtractBusy = false;
let autoExtractBackoffUntil = 0;
/** 最近一次提取失败的原因（界面显示，别让人对着"没有可提取的对象"猜）。 */
let lastExtractError = null;

async function maybeAutoExtract({ force = false } = {}) {
  if (autoExtractBusy) return null;
  const c = cfg();
  if (!force && c.autoExtractEnabled === false) return null;
  // ⚠️ 必须是 `job && !job.done`：整理任务跑完后 job 对象会留着（done=true），
  //    写成 `if (job)` 会让自动提取**从此永远被跳过**（"一天都没短期记忆"的元凶）。
  if (job && !job.done) return null;
  if (!force && Date.now() < autoExtractBackoffUntil) return null;
  const intervalH = Math.max(1, Number(c.autoExtractIntervalHours) || 3);
  const minNew = Math.max(5, Number(c.autoExtractMinNewMessages) || 20);
  autoExtractBusy = true;
  try {
    // 先挑出候选（消息够多、够久、新消息够多），按"新消息最多"优先，一次只处理一个会话
    const cands = [];
    for (const { chatKey } of archivedChats()) {
      if (!chatKey) continue;
      try { refreshRoster(chatKey); } catch (error) { verbose(`花名册失败：${error?.message ?? error}`); }
      const rows = readRecentFromDisk(chatKey, 400);
      if (!rows || rows.length < 6) continue;
      const last = Number(chatFlags(chatKey).lastAutoExtractAt) || 0;
      const fresh = rows.filter((m) => Number(m.ts) > last).length;
      if (!force) {
        if (Date.now() - last < intervalH * 3600 * 1000) continue;
        if (fresh < minNew) continue;
      }
      cands.push({ chatKey, fresh, last, rows: rows.length });
    }
    cands.sort((a, b) => b.fresh - a.fresh);
    if (!cands.length) return null;

    for (const cand of cands) {
      const { chatKey, fresh } = cand;
      // ① 先用**零成本**的规则提取把"明确约定"捞出来（模型限流也照样能记）
      let added = 0;
      if (c.ruleExtractEnabled !== false) {
        for (const it of ruleExtract(chatKey, { scan: 200, since: cand.last, limit: 2 })) {
          try {
            addShort(chatKey, it.userId, it.name || '', {
              content: it.content, kind: 'appointment', source: 'rule'
            });
            added += 1;
          } catch (error) {
            verbose(`规则提取没记上：${error?.message ?? error}`);
          }
        }
      }
      // ② 再让模型回看一遍，补"稳定观察"（这一步会花 token，限流时算失败但不影响①）
      //    ★ 公平性：优先考察"还没有任何记忆"的人，否则模型每次都写那几个活跃的人，
      //      长尾群友永远进不了记忆（实测 23 个发言人里 12 个一条都没有）。
      const focus = membersWithoutMemory(chatKey, 6);
      const r = await extractFromArchive({ chatKey }, { scan: Number(c.consolidateArchiveScanCount) || 120, settings: c, focus });
      if (r.rateLimited || r.error) {
        const why = String(r.error || '模型限流');
        if (r.rateLimited) autoExtractBackoffUntil = Date.now() + 30 * 60 * 1000;
        lastExtractError = { at: Date.now(), chatKey, error: why };
        chatFlags(chatKey, { lastAutoExtractAt: Date.now() });
        saveState();
        if (added) {
          noteOperation(true, `自动提取（规则）：记下 ${added} 条约定类短期记忆；模型提取失败（${why.slice(0, 60)}），稍后再补`);
          refreshSnapshotSoon();
          return { chatKey, added, fresh, error: why, partial: true };
        }
        noteOperation(false, `自动提取失败：${why}`);
        if (!force) return { chatKey, added: 0, fresh, error: why, rateLimited: !!r.rateLimited };
        continue;   // 手动触发时换下一个会话再试
      }
      lastExtractError = null;

      for (const it of r.items) {
        if (!it.userId || !it.content) continue;
        try {
          addShort(chatKey, it.userId, it.name || '', {
            content: it.content,
            kind: KINDS.includes(it.kind) ? it.kind : (looksLikeAppointment(it.content) ? 'appointment' : 'general'),
            source: 'auto'
          });
          added += 1;
        } catch (error) {
          verbose(`自动提取的记忆没记上：${error?.message ?? error}`);
        }
      }
      chatFlags(chatKey, { lastAutoExtractAt: Date.now() });
      saveState();
      const why = r.note ? `（${r.note}）` : '';
      noteOperation(true, added
        ? `自动提取：从 ${chatKey} 最近的 ${fresh} 条记录里记下 ${added} 条短期记忆`
        : `自动提取：${chatKey} 最近的 ${fresh} 条记录里没有值得记的新内容${why}`);
      refreshSnapshotSoon();
      return { chatKey, added, fresh, note: r.note || '' };
    }
    return null;
  } finally {
    autoExtractBusy = false;
  }
}

function startTimers() {
  stopTimers();
  const t1 = setInterval(() => {
    try { expireShort(cfg().shortTtlDays); } catch (error) { warn(`过期清理失败：${error?.message ?? error}`); }
  }, 30 * 60 * 1000);
  const t2 = setInterval(() => {
    try { maybeSweepArchive(); } catch (error) { warn(`存档清理失败：${error?.message ?? error}`); }
  }, 6 * 60 * 60 * 1000);
  const t3 = setInterval(() => {
    try { if (cfg().uiPanel !== false) refreshSnapshot(); } catch { /* ignore */ }
  }, 30 * 60 * 1000);
  // 自动提取短期记忆：每 10 分钟检查一次「够久 + 攒够新消息」的会话（一次只处理一个）
  const t4 = setInterval(() => {
    maybeAutoExtract().catch((error) => warn(`自动提取失败：${error?.message ?? error}`));
  }, 10 * 60 * 1000);
  // 过期待办清理：每小时看一眼（默认每天真正扫一次）
  const t5 = setInterval(() => {
    try { maybeSweepAppointments(); } catch (error) { warn(`过期待办清理失败：${error?.message ?? error}`); }
  }, 60 * 60 * 1000);
  for (const t of [t1, t2, t3, t4, t5]) { t.unref?.(); timers.push(t); }
  // 启动后 60 秒做一次"到点就清"的检查，别在启动瞬间抢 IO
  const boot = setTimeout(() => {
    try {
      if (cfg().archiveCleanupEnabled !== false) maybeSweepArchive();
      // 先给历史约定补到期时间，再把早该失效的删掉
      // （不补的话老条目 dueAt=0，永远不会被判过期）
      const filled = backfillDueAt();
      if (filled.filled) log(`约定到期时间回填：${filled.filled} 条`);
      maybeSweepAppointments(true);
      if (cfg().uiPanel !== false) refreshSnapshot();
      maybeAutoExtract().catch(() => { /* ignore */ });
    } catch (error) { warn(`启动检查失败：${error?.message ?? error}`); }
  }, 60 * 1000);
  boot.unref?.();
  timers.push(boot);
}

function stopTimers() {
  while (timers.length) {
    const t = timers.pop();
    try { clearTimeout(t); clearInterval(t); } catch { /* ignore */ }
  }
  if (snapshotTimer) { try { clearTimeout(snapshotTimer); } catch { /* ignore */ } snapshotTimer = null; }
}

/** 插件生命周期：加载一次。 */
export function setup(api) {
  apiRef = api;
  cfg = api.config;
  // 记忆根目录：默认 D:\QQAgent\data\记忆，可在插件设置 storeDir 里改。
  // 必须在任何 store 读写之前设置好，否则第一次 load 会落到默认路径。
  try { setStoreDir(cfg()?.storeDir); } catch { setStoreDir(''); }
  try {
    registerTools(api);
  } catch (error) {
    api.error?.(`注册工具失败：${error?.message ?? error}`);
    throw error;
  }
  api.log('记忆与存档优化已加载（长期/短期两层记忆 + 聊天记录检索 + 存档清理 + 一键回档）');
}

/** 被启用（或热重载后重新激活）：装界面、起定时器。 */
export async function activate(ctx = {}) {
  try {
    const c = cfg();
    if (c.uiPanel !== false) {
      const r = await installHost({ log });
      if (r.ok === false) warn(`控制台界面没装上（不影响机器人功能）：${r.error}`);
      else if (r.changed) {
        // 界面文件变了/刚装上 → 让控制台自己刷新一次（等价于用户按 F5）。
        // 幂等安装保证这里不会变成重载循环。
        const rr = await reloadConsole();
        if (rr.count > 0) log(`控制台已刷新（${rr.count} 个窗口），「记忆」页已接管`);
        else warn(`界面已装好，但自动刷新控制台没做成（${rr.error}）—— 你按一下 F5 就能看到新界面`);
      }
      refreshSnapshot();
    }
    startTimers();
    // 上次限流留下的标签队列：接着跑完（队列写在 state.json 里，热重载/重启都不丢）
    try {
      const pendingQueues = chatsWithLabelQueue();
      if (pendingQueues.length) {
        labelQueueChat = pendingQueues[0];
        startLabelQueueTimer(labelQueueChat);
        log(`标签队列续跑：${labelQueueChat} 还有 ${getLabelQueue(labelQueueChat).uids.length} 个人（每 30 秒一个）`);
      }
    } catch (error) {
      warn(`续跑标签队列失败：${error?.message ?? error}`);
    }
    log('记忆与存档优化已激活');
  } catch (error) {
    warn(`激活失败：${error?.message ?? error}`);
  }
}

/** 被关闭：清定时器。热重载时**不摘界面**（避免闪烁，activate 会立刻重装覆盖）。 */
export function deactivate(ctx = {}) {
  stopTimers();
  if (ctx?.reason === 'reload') return;
  if (cfg().uiPanel !== false) {
    removeHost({ log }).catch(() => { /* ignore */ });
  }
}

/** 卸载/热重载的最终清理。 */
export function dispose() {
  stopTimers();
  blockCache.clear();
  finalPromptCache.clear();
}

/** 可用性自检：必须同步返回（返回 Promise 会被当成"可用"）。
 *  ⚠️ 这里**故意不再有**"全部停用"那种自毁总开关：它会把插件变成「不可用」，
 *     界面上只剩一句吓人的报错（用户实测：关掉后提示还留着，以为坏了）。
 *     要整块停用请用「插件」页自带的插件级开关（核心的标准做法），
 *     单个功能则用设置里的 ①~⑧ 分开关。 */
export function available() {
  try {
    loadState();
    return true;
  } catch (error) {
    return { ok: false, reason: `记忆数据目录不可读：${error?.message ?? error}` };
  }
}

export { consolidateChat, chatOverview, refreshSnapshot as _refreshSnapshot, jobSnapshot as _jobSnapshot, ruleExtract as _ruleExtract, maybeAutoExtract as _maybeAutoExtract };
export const internals = { resolveMember, applyRename, applyFact };
