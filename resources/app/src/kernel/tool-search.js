/**
 * 按需工具加载（虚拟 tool_search）
 *
 * 背景：本机每轮请求都会把全部工具 schema（约 24,000 字符）发给模型，
 * 但实测 2018 个会话里 Top10 工具占 95.7%，其余几十个几乎不被调用。
 * 这里把"常驻工具"照常发 schema，其余只给名字目录，模型需要时先调
 * tool_search 检索，命中后**下一轮**才拿到完整 schema 并可执行。
 *
 * 设计口径（照 Undefined 的 ToolSearchSession，但按本机中文工具重写打分）：
 *   · 一个 Session = 一次 runAgent 运行，不跨会话；
 *   · 加载集合只增不减；
 *   · 每轮取 tools 时同时冻结"本轮可执行名单"，模型同轮调用未加载工具一律拒绝；
 *   · 目录里只有 id 与中文名，不含描述与参数（省的就是这部分）。
 */

export const TOOL_SEARCH_NAME = 'tool_search';

const DEFAULT_MAX_RESULTS = 6;

/**
 * 停用词：这些词几乎每件工具的描述里都有，参与打分只会把无关工具捞进来。
 * 实盘案例：q="deepseek 余额 用量 查询" 里的"查询"把 affinity / persona / 表情库
 * 一起捞了回来，加载数从 1 件涨到 6 件。泛词必须在打分前先剔掉。
 */
const STOPWORDS = new Set([
  '查询', '查看', '查一下', '获取', '工具', '调用', '一下', '这个', '那个',
  '帮我', '帮忙', '请', '的', '了', '吗', '呢', '吧', '啊',
  'search', 'tool', 'call', 'get', 'use', 'the'
]);

/**
 * 人工别名表：本机工具 id 是英文，中文名又常常跟口语不一样（"查看表情库" vs "发表情"）。
 * 只靠 id/名称/描述做子串匹配，"B站"能中、"发个图"会落空 —— 所以关键工具补 3~5 个口语词。
 * 别名命中权重最高，改这一张表就能救一整类检索不中。
 */
const ALIASES = {
  'send_message': ['说话', '回复', '发言', '发消息'],
  'send_image': ['发图', '图片', '网图', '配图'],
  'send_sticker': ['表情包', '表情', '梗图', '发表情'],
  'sticker-steal__sticker': ['表情包', '表情', '梗图', '发表情'],
  'sticker-steal__sticker_library': ['表情包库', '表情库', '看表情'],
  'sticker-steal__sticker_collect': ['收表情', '收藏表情', '偷表情'],
  'sticker-steal__sticker_cleanup': ['清理表情', '删表情'],
  'list_stickers': ['表情编号', '表情列表'],
  'bili-video__bili_video': ['b站', 'bilibili', '视频推荐', '找视频'],
  'read_video': ['视频', '看视频', '读视频'],
  'web_search': ['搜索', '联网', '查一下'],
  'web_fetch': ['网页', '链接', '抓取'],
  'search_images': ['搜图', '找图', '配图'],
  'get_message_images': ['看图', '图片', '收到的图'],
  'get_recent_messages': ['聊天记录', '历史消息', '刚才说的'],
  'get_message_detail': ['消息详情', '转发', '回复哪条'],
  'send_poke': ['拍一拍', '戳一下'],
  'memory-plus__recall_impression': ['记忆', '印象', '回忆', '记得'],
  'memory-plus__note_impression': ['记印象', '记住', '记一条'],
  'memory-plus__search_archive': ['聊天记录', '检索记录', '翻聊天'],
  'memory-recall__memory_recall': ['回忆', '往事', '记忆'],
  'affinity__check': ['好感度', '好感'],
  'affinity__ties': ['关系', '关系网'],
  'mimo-tts__say': ['语音', '说话', '配音'],
  'ai-cover__cover': ['翻唱', '唱歌', '换音色'],
  'deepseek-balance__deepseek_balance_query': ['余额', '用量', '花了多少'],
  'get_active_members': ['活跃成员', '谁在说话'],
  'set_reminder': ['提醒', '定时'],
  'check_holiday': ['节假日', '放假', '节日'],
  'persona-self-edit__edit_persona': ['人设', '角色', '性格'],
  'persona-detail__query_persona_detail': ['人设细节', '细节库'],
  'report_feedback': ['反馈', '报错']
};

/** 把标识符拆成可检索的词：`sticker-steal__pick_sticker` → sticker / steal / pick */
function splitIdentifier(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[._\-\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** 收集参数名与参数描述，参与关键词打分（与 P06 同源，但只处理本机的朴素 schema）。 */
function collectParamIndex(parameters) {
  const names = [];
  const texts = [];
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return;
    if (typeof node.description === 'string') texts.push(node.description.toLowerCase());
    if (node.properties && typeof node.properties === 'object') {
      for (const [k, v] of Object.entries(node.properties)) {
        names.push(splitIdentifier(k).join(' '));
        walk(v, depth + 1);
      }
    }
    if (node.items) walk(node.items, depth + 1);
    for (const key of ['anyOf', 'oneOf', 'allOf']) {
      if (Array.isArray(node[key])) node[key].forEach((c) => walk(c, depth + 1));
    }
  };
  walk(parameters);
  return { names, text: texts.join(' ') };
}

function buildDoc(id, def) {
  const idParts = splitIdentifier(id);
  const zhName = String(def.name || '').toLowerCase();
  const { names, text } = collectParamIndex(def.parameters);
  return {
    id,
    parts: idParts,
    normalizedId: idParts.join(' '),
    zhName,
    aliases: (ALIASES[id] || []).map((a) => a.toLowerCase()),
    paramNames: names,
    text: `${String(def.description || '').toLowerCase()} ${text}`.trim()
  };
}

function docScore(doc, term) {
  let base = 0;
  if (doc.aliases.some((a) => a.includes(term) || term.includes(a))) base += 6;
  if (doc.parts.includes(term)) base += 10;
  else if (doc.parts.some((p) => p.includes(term))) base += 5;
  else if (doc.normalizedId.includes(term)) base += 3;
  if (doc.zhName.includes(term)) base += 4;
  if (doc.paramNames.some((n) => n.includes(term))) base += 3;
  // 描述只做"同义加分"，**不能单独把一件工具捞进来**：
  // 实盘噪声就是这么来的 —— "余额" 命中了表情库描述里的泛词，于是一次检索多带了 1 件无关工具。
  if (base <= 0) return 0;
  return doc.text.includes(term) ? base + 2 : base;
}

function buildToolSearchSchema(maxResults) {
  return {
    type: 'function',
    function: {
      name: TOOL_SEARCH_NAME,
      description:
        '检索并按需加载工具。本机常用工具已在列表里；如果你需要做的事没有对应工具，先用本工具按关键词搜索'
        + '（例如"记忆 归档""B站 视频""提醒"），命中的工具会在**下一轮**拿到完整参数并可调用。'
        + '本工具只加载工具定义，不执行任何业务操作、不查数据、不发消息；'
        + '加载成功不等于任务完成，拿到 schema 后仍要再调一次目标工具。'
        + '同一个工具在本轮已加载过就不要重复搜。',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '关键词，多个词用空格分隔，例如"表情包 库"、"记忆 印象"。也支持直接给工具 id。'
          },
          max_results: {
            type: 'integer',
            minimum: 1,
            description: `最多加载几个工具，默认 ${maxResults}，上限同样是 ${maxResults}。`
          }
        },
        required: ['query']
      }
    }
  };
}

/**
 * @param {Array} defs 已通过可用性过滤的工具定义
 * @param {{alwaysLoaded?: string[], maxResults?: number}} options
 * @returns {null|object} null 表示按需加载不可用（无延迟工具 / 真工具重名），调用方回退全量
 */
export function createToolSearchSession(defs, options = {}) {
  const alwaysLoaded = Array.isArray(options.alwaysLoaded) ? options.alwaysLoaded : [];
  const maxResults = Math.max(1, Number(options.maxResults) || DEFAULT_MAX_RESULTS);

  const catalog = new Map();
  for (const def of Array.isArray(defs) ? defs : []) {
    const id = String(def?.id || def?.name || '').trim();
    if (!id || catalog.has(id)) continue;
    catalog.set(id, def);
  }
  // 真工具已经占了 tool_search 这个名字：宁可不启用，也不能让模型把真工具当成加载器
  if (catalog.has(TOOL_SEARCH_NAME)) return null;

  const loaded = new Set();
  for (const raw of alwaysLoaded) {
    const id = String(raw || '').trim();
    if (catalog.has(id)) loaded.add(id);
  }
  const deferred = [...catalog.keys()].filter((id) => !loaded.has(id)).sort((a, b) => a.localeCompare(b));
  if (!deferred.length) return null;

  const docs = new Map();
  for (const [id, def] of catalog) docs.set(id, buildDoc(id, def));

  const schema = buildToolSearchSchema(maxResults);
  let exposed = new Set([...loaded, TOOL_SEARCH_NAME]);

  /** 本轮要发给模型的 tools：已加载的工具 + 虚拟 tool_search */
  function requestTools() {
    const out = [];
    for (const id of catalog.keys()) {
      if (loaded.has(id)) out.push(catalog.get(id));
    }
    exposed = new Set([...loaded, TOOL_SEARCH_NAME]);
    return out;
  }

  /** 本轮允许执行的名字（id 与中文名两种写法都算，模型有时把 name 写成中文） */
  function isExposed(name) {
    const raw = String(name || '').trim();
    if (!raw) return false;
    if (exposed.has(raw)) return true;
    for (const id of exposed) {
      const def = catalog.get(id);
      if (def && String(def.name || '') === raw) return true;
    }
    return false;
  }

  /** 模型看到的目录：只有 id 与中文名 */
  function catalogText() {
    const lines = deferred.map((id) => {
      const def = catalog.get(id);
      const zh = String(def?.name || '').trim();
      return zh ? `${id}（${zh}）` : id;
    });
    return [
      '<available_deferred_tools>',
      ...lines,
      '</available_deferred_tools>',
      '上面是"需要时再取"的工具目录（只有名字）。要调用其中任何一个，先调 tool_search 查它，',
      '下一轮拿到完整参数后再真正调用；直接调用不会执行，只会被拒绝。'
    ].join('\n');
  }

  function effectiveLimit(requested) {
    const n = Number(requested);
    if (!Number.isFinite(n) || n < 1) return maxResults;
    return Math.min(maxResults, Math.max(1, Math.floor(n)));
  }

  function loadMatches(ids, missing, truncated) {
    const outLoaded = [];
    const already = [];
    for (const id of ids) {
      if (id === TOOL_SEARCH_NAME || loaded.has(id)) already.push(id);
      else {
        loaded.add(id);
        outLoaded.push(id);
      }
    }
    return {
      loaded: outLoaded,
      already_loaded: already,
      not_found: missing,
      truncated: !!truncated,
      total_deferred_tools: deferred.length
    };
  }

  function resolveExact(query) {
    const raw = String(query || '').trim();
    if (!raw) return null;
    if (catalog.has(raw)) return raw;
    const lower = raw.toLowerCase();
    for (const d of catalog.values()) {
      if (String(d.name || '').trim() === raw) return String(d.id || d.name);
    }
    for (const id of catalog.keys()) {
      if (id.toLowerCase() === lower) return id;
    }
    return null;
  }

  /** 检索并把命中项加进加载集合；返回给模型看的固定结构 */
  function searchAndLoad(query, requestedMax) {
    const limit = effectiveLimit(requestedMax);
    const raw = String(query || '').trim();
    if (!raw) return loadMatches([], [raw], false);

    const selectMatch = raw.match(/^select\s*:(.*)$/i);
    if (selectMatch) {
      const hits = [];
      const miss = [];
      for (const piece of selectMatch[1].split(',')) {
        const name = piece.trim();
        if (!name) continue;
        const id = resolveExact(name);
        if (id && !hits.includes(id)) hits.push(id);
        else if (!id && !miss.includes(name)) miss.push(name);
      }
      return loadMatches(hits.slice(0, limit), miss, hits.length > limit);
    }

    const exact = resolveExact(raw);
    if (exact) return loadMatches([exact], [], false);

    const terms = raw.toLowerCase().split(/\s+/)
      .flatMap((t) => splitIdentifier(t) || [t])
      .filter((t) => t && !STOPWORDS.has(t));
    if (!terms.length) return loadMatches([], [raw], false);

    const scored = [];
    for (const id of catalog.keys()) {
      if (id === TOOL_SEARCH_NAME) continue;
      const doc = docs.get(id);
      const score = terms.reduce((sum, term) => sum + docScore(doc, term), 0);
      if (score > 0) {
        scored.push([score, id]);
        // 排障开关：DEBUG_TOOLSEARCH=1 时打印每个命中词的分解，方便判断噪声来自哪一层
        if (process.env.DEBUG_TOOLSEARCH === '1') {
          const parts = terms.map((term) => `${term}:${docScore(doc, term)}`).filter((s) => !s.endsWith(':0'));
          console.log(`[tool-search score] ${id} = ${score} (${parts.join(' ')})`);
        }
      }
    }
    scored.sort((a, b) => (b[0] - a[0]) || a[1].localeCompare(b[1]));
    const ids = scored.map(([, id]) => id);
    // 只靠榜首压过第二名就砍数量太粗暴（"记忆 印象"这类宽问题会被砍到 2 件），
    // 降噪交给上面的停用词表；这里只在"唯一命中"时才收敛到 1 件。
    const take = scored.length === 1 ? 1 : limit;
    // 已经加载过的也要回给模型（放在 already_loaded），否则它会以为"没搜到"而反复重搜
    const fresh = ids.filter((id) => !loaded.has(id));
    const already = ids.filter((id) => loaded.has(id));
    const truncated = fresh.length > take;
    const picked = [...fresh.slice(0, take), ...already.slice(0, take)];
    return loadMatches(picked, picked.length ? [] : [raw], truncated);
  }

  return {
    name: TOOL_SEARCH_NAME,
    schema,
    catalog: catalog,
    requestTools,
    isExposed,
    catalogText,
    searchAndLoad,
    get loadedCount() { return loaded.size; },
    get deferredCount() { return deferred.length; }
  };
}
