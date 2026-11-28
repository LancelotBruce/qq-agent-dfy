import fs from 'node:fs';

// 调试探针默认关闭：置 QQ_CACHE_PROBE=1 才写 cache-probe.log。
// 之前默认每轮同步写盘两次，日志已涨到 147KB/1,313 行，且 llm.request-params 那个探针
// 在真实请求体上取不到 tools（tools=na），已经验不出东西，没必要一直跑。
const PROBE = process.env.QQ_CACHE_PROBE === '1';

function headingAt(text, label) {
  let i = text.indexOf(label);
  while (i >= 0 && i > 0 && text[i-1] !== '\n') i = text.indexOf(label, i + label.length);
  return i;
}
const VIDEO_RULE = '▸ 视频理解\n你看到的视频画面是抽帧截图，不是连续视频：帧与帧之间发生的事你看不到。描述时用"看起来""某一帧里"这类措辞，不要断言中间的连续过程。';
export function stabilizeSystem(text) {
  if (typeof text !== 'string') return text;
  return text.replace(/(?:^|\n)▸ 视频理解\r?\n你看到的视频画面[^\r\n]*/g, '').trimEnd() + '\n' + VIDEO_RULE;
}
export function reorderUser(text) {
  if (typeof text !== 'string') return text;
  const moved = [], historyAt = headingAt(text, '【已读信息】');
  if (historyAt < 0) return text;
  let head = text.slice(0, historyAt);
  const tail = text.slice(historyAt), unreadAt = headingAt(tail, '【未读信息】');
  if (unreadAt < 0) return text;
  const stickerAt = headingAt(head, '【可用表情包】'), guideAt = stickerAt < 0 ? -1 : headingAt(head, '【引导说明】');
  if (stickerAt >= 0 && guideAt > stickerAt) { moved.push(head.slice(stickerAt, guideAt).trimEnd()); head = head.slice(0, stickerAt) + head.slice(guideAt); }
  const memoryAt = headingAt(head, '【记忆】');
  if (memoryAt >= 0) { moved.push(head.slice(memoryAt).trimEnd()); head = head.slice(0, memoryAt); }
  if (!moved.length) return text;
  return head + tail.slice(0, unreadAt) + moved.join('\n\n') + '\n\n' + tail.slice(unreadAt);
}

// 把「表情包库」动态候选段整段从系统提示里摘出来（它每轮都变，且带随机候选），
// 由调用方追加到用户消息末尾 —— 这样系统提示从「安全规则」到「技能段结尾」字节固定，
// 前缀缓存能吃到几乎整个 system，而不是被第 8% 处的候选列表一刀切断。
function splitStickerSection(text) {
  if (typeof text !== 'string') return null;
  const at = text.indexOf('\n▸ 表情包库');
  if (at < 0) return null;
  const rest = text.slice(at + 1);
  const rel = rest.search(/\n▸ |\n【@ 身份锚点】/);
  if (rel < 0) return null;
  return { head: text.slice(0, at), seg: rest.slice(0, rel).trimEnd(), tail: text.slice(at + 1 + rel) };
}

// 把「每轮会变的段」整段从系统提示里摘出来，改挂到用户消息末尾，
// 目的是让 system 从头到尾字节固定，tools 数组才能跟着一起吃前缀缓存。
// 只摘「内容本身就是当下上下文」的段：待晋升的记忆 / 跨轮 / 长期记忆+待办+设定。
// 好感度段原位保留 —— 它同时是输出格式指令（[aff:档位]），搬走有让模型忘记打标记的风险。
const END_OF_SECTION = /\n▸ |\n【/;
function cutHeadSection(text, label) {
  const at = text.indexOf(label);
  if (at < 0) return null;
  const bodyStart = at + label.length;
  const rel = text.slice(bodyStart).search(END_OF_SECTION);
  const end = rel < 0 ? text.length : bodyStart + rel;
  return { at, seg: text.slice(at, end).trimEnd(), end };
}
function cutDynamic(text) {
  if (typeof text !== 'string') return { rest: text, segs: [] };
  let t = text;
  const found = [];
  for (const label of ['\n▸ 待晋升的记忆']) {
    const r = cutHeadSection(t, label);
    if (!r) continue;
    found.push({ pos: r.at, seg: r.seg });
    t = t.slice(0, r.at) + t.slice(r.end);
  }
  // 尾部块（【跨轮】/【长期记忆】+【待办】【设定】【话题】），到末尾为止，
  // 但不吞掉「视频理解」段——它要留给 stabilizeSystem 挪到最末尾做固定尾巴。
  const cand = ['\n\n【跨轮】', '\n\n【长期记忆】'].map((s) => t.indexOf(s)).filter((i) => i >= 0);
  if (cand.length) {
    const tailAt = Math.min(...cand);
    const vidAt = t.indexOf('▸ 视频理解');
    const stop = (vidAt > tailAt) ? vidAt : t.length;
    found.push({ pos: tailAt, seg: t.slice(tailAt, stop).trimEnd() });
    t = t.slice(0, tailAt) + t.slice(stop);
  }
  found.sort((a, b) => a.pos - b.pos);
  return { rest: t.replace(/\n{3,}/g, '\n\n').trimEnd(), segs: found.map((x) => x.seg) };
}

export const hooks = {'before-llm-messages': ({messages} = {}) => {
  try {
    if (PROBE) {
      const sys0 = Array.isArray(messages) ? messages.find((m) => m?.role === 'system') : null;
      const st = sys0 ? typeof sys0.content : 'nosys';
      const idx = st === 'string' ? sys0.content.indexOf('\n▸ 表情包库') : -3;
      const len = st === 'string' ? sys0.content.length : 0;
      fs.appendFileSync('D:\\QQAgent\\data\\cache-probe.log',
        new Date().toISOString() + ' msgs=' + (Array.isArray(messages) ? messages.length : 'na')
        + ' sysType=' + st + ' idx=' + idx + ' len=' + len + '\n');
    }
  } catch {}
  if (!Array.isArray(messages)) return;
  const system=messages.find(m=>m?.role==='system');
  const user=messages.find(m=>m?.role==='user');
  if (system && typeof system.content==='string') {
    // 安全前提：没有 user 消息就整段不搬，否则摘出来的段会凭空丢掉
    if (user && typeof user.content === 'string') {
      const sp = splitStickerSection(system.content);
      if (sp) system.content = sp.head + sp.tail;
      const dyn = cutDynamic(system.content);
      system.content = dyn.rest;
      const add = [];
      if (sp && sp.seg) add.push(sp.seg);
      if (dyn.segs.length) add.push(...dyn.segs);
      if (add.length) user.content = user.content.trimEnd() + '\n\n' + add.join('\n\n');
      try { if (PROBE) fs.appendFileSync(P, new Date().toISOString() + ' CUT syslen=' + (typeof system.content === 'string' ? system.content.length : 'na') + ' userlen=' + (typeof user.content === 'string' ? user.content.length : 'na') + ' segs=' + add.length + '\n'); } catch {}
    }
    system.content = stabilizeSystem(system.content);
  }
  if (user && typeof user.content==='string') user.content=reorderUser(user.content);
}};
const P = 'D:\\QQAgent\\data\\cache-probe.log';
function h32(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h * 33) ^ s.charCodeAt(i)) >>> 0;
  return h.toString(16);
}
// 抓真实请求体：对比相邻两次的 tools / messages 前缀是否一致，
// 定位缓存到底在哪一段断掉。
export const providers = {
  'llm.request-params': (body) => {
    if (!PROBE) return body;
    try {
      const t = body?.tools;
      const ts = JSON.stringify(t || null);
      const cs = JSON.stringify((body?.messages || []).map((m) => [m?.role, String(m?.content || '').slice(0, 30)]));
      fs.appendFileSync(P, new Date().toISOString()
        + ' REQ tools=' + (Array.isArray(t) ? t.length : 'na')
        + ' tLen=' + ts.length + ' tHash=' + h32(ts)
        + ' mHeadHash=' + h32(cs)
        + ' keys=' + Object.keys(body || {}).join('|') + '\n');
    } catch {}
    return body;
  }
};
export function available() {return {ok:true};}
