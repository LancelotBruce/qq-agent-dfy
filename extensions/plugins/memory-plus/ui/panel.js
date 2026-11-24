/* 印象档案 · 0.5 控制台面板
 *
 * 数据通道（0.5 官方契约，用户面板 iframe 是 sandbox=allow-scripts，没有同源，
 * 所以不能直接 fetch，必须走宿主注入的 postMessage RPC）：
 *   宿主 → 面板：{ jsonrpc:'2.0', method:'panel.init', params:{ nonce, panel }, meta:{ nonce, panel } }
 *   面板 → 宿主：{ jsonrpc:'2.0', id, method:'ctx.call', params:{ tool, args }, meta:{ nonce, panel } }
 *   ctx.call 只会转发到本插件自己的工具，这里用的是 memory-plus__panel_api，
 *   它在插件内部原样调用 handleAction(action, body)，等于把 0.4 的控制台动作重新接上。
 */
const FALLBACK_TOOL = 'memory-plus__panel_api';

// 类型用中文显示：界面上写 "general" 看不出是什么，写成"一般观察"才一眼明白
const KIND_CN = { general: '一般观察', appointment: '约定·待办', preference: '偏好', fact: '事实', relation: '关系', correction: '纠正/雷区' };
function kindCn(kind) { return KIND_CN[kind] || String(kind || ''); }

const state = {
  nonce: '',
  panel: 'memory-plus',
  ready: false,
  seq: 0,
  pending: new Map(),
  snapshot: null,
  activeChat: '',
  longs: [],
  sort: 'count',
  busy: false
};

function el(id) { return document.getElementById(id); }

function esc(text) {
  return String(text ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}

function stamp(ms) {
  const n = Number(ms) || 0;
  if (!n) return '—';
  const d = new Date(n);
  const pad = (v) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function toast(text, bad = false) {
  const old = document.querySelector('.toast');
  if (old) old.remove();
  const node = document.createElement('div');
  node.className = `toast${bad ? ' bad' : ''}`;
  node.textContent = text;
  document.body.appendChild(node);
  setTimeout(() => node.remove(), bad ? 6000 : 2800);
}

/** 向宿主发一条 RPC，等回复。 */
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!state.nonce) { reject(new Error('面板还没和宿主握手（刷新控制台重试）')); return; }
    const id = `mp-${++state.seq}`;
    const timer = setTimeout(() => {
      state.pending.delete(id);
      reject(new Error('宿主没有响应（超时）'));
    }, 30000);
    state.pending.set(id, { resolve, reject, timer });
    window.parent.postMessage({
      jsonrpc: '2.0',
      id,
      method,
      params,
      meta: { nonce: state.nonce, panel: state.panel }
    }, '*');
  });
}

/** 面板专属动作通道：ctx.call → 插件 memory-plus__panel_api 工具。 */
async function act(action, body = {}) {
  const reply = await rpc('ctx.call', { tool: FALLBACK_TOOL, args: { action, body } });
  if (reply && reply.ok === false) throw new Error(reply.error || '动作失败');
  const payload = reply && Object.hasOwn(reply, 'result') ? reply.result : reply;
  const raw = payload && typeof payload === 'object' && 'content' in payload ? payload.content : payload;
  if (typeof raw !== 'string') return raw || {};
  try { return JSON.parse(raw); } catch { return { text: raw }; }
}

/** 回 panel.ready（握手）。头部同步脚本可能已经代发过，重复发宿主侧无害。 */
function replyReady(force = false) {
  const hs = window.__mpHandshake;
  if (hs && hs.sent && !force) return true;
  if (!state.nonce) return false;
  state.ready = true;
  window.parent.postMessage({
    jsonrpc: '2.0',
    method: 'panel.ready',
    meta: { nonce: state.nonce, panel: state.panel }
  }, '*');
  if (hs) hs.sent = true;
  return true;
}

/**
 * 接走头部脚本已经收到的握手。
 * 宿主只在 iframe load 时**单发一次** panel.init，模块脚本晚一步执行就永久丢掉它。
 * 头部同步脚本先接住 nonce，这里把它接管过来并开始读数据。
 */
function adoptHandshake() {
  const hs = window.__mpHandshake;
  if (!hs) return false;
  if (hs.nonce && !state.nonce) {
    state.nonce = String(hs.nonce);
    state.panel = String(hs.panel || state.panel);
  }
  if (state.nonce && !state.ready) {
    state.ready = true;
    replyReady(true);
    load().catch((error) => toast(`面板读取失败：${error?.message ?? error}`, true));
    return true;
  }
  return false;
}

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'panel.init') {
    state.nonce = String(message.params?.nonce || '');
    state.panel = String(message.params?.panel || state.panel);
    if (!state.ready) { state.ready = true; load().catch((error) => toast(`面板读取失败：${error?.message ?? error}`, true)); }
    replyReady(true);
    return;
  }
  // 宿主切走面板时要求"保存并退出"。不回这条，宿主会等满 4 秒后判定失败，
  // 结果是侧栏高亮变了、右侧还停在旧面板，看起来像整个控制台卡死。
  if (message.method === 'panel.leave') {
    const params = message.params || {};
    const meta = message.meta || {};
    window.parent.postMessage({
      jsonrpc: '2.0',
      method: 'panel.flushed',
      params: { flushId: params.flushId, ok: true },
      meta: { nonce: state.nonce || String(meta.nonce || ''), panel: state.panel || String(meta.panel || 'memory-plus') }
    }, '*');
    return;
  }
  if (message.id && state.pending.has(message.id)) {
    const item = state.pending.get(message.id);
    state.pending.delete(message.id);
    clearTimeout(item.timer);
    if (message.error) item.reject(new Error(message.error.message || '宿主拒绝'));
    else item.resolve(message.result);
  }
});

async function run(action, body = {}, okText = '完成') {
  if (state.busy) return;
  state.busy = true;
  el('note').textContent = '执行中…';
  try {
    const out = await act(action, body);
    if (out && out.ok === false) throw new Error(out.error || '动作没有成功');
    el('note').textContent = okText;
    toast(okText);
    return out;
  } catch (error) {
    el('note').textContent = '';
    toast(String(error?.message ?? error), true);
    throw error;
  } finally {
    state.busy = false;
  }
}

function renderStats() {
  const snap = state.snapshot || {};
  const stats = snap.stats || {};  const cards = [
    ['会话', Number(stats.chats) || (snap.chats || []).length],
    ['短期记忆', Number(stats.short) || 0],
    ['压缩标签', Number(stats.labels) || 0],
    ['记过的人', Number(stats.members) || 0],
    ['待裁决', Number(stats.pendingQuestions) || 0],
    ['已过期', Number(stats.expired) || 0],
    ['已晋升', Number(stats.promoted) || 0]
  ];
  el('stats').innerHTML = cards.map(([k, v]) => (
    `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`
  )).join('');
  el('meta').textContent = snap.readAt ? `读取于 ${stamp(snap.readAt)}` : '已连接';
}

/** 顶部横幅：把「画像调试」这个主入口直接摆在最显眼的位置。 */
function renderBanner() {
  const host = el('banner');
  if (!host) return;
  const n = Number((state.snapshot?.stats || {}).members) || 0;
  host.innerHTML = `<div class="tip banner-tip">
    <span class="tip-text">人物画像和三层记忆都在「按 QQ 号档案」里${n ? `（${n} 人）` : ''}，点开某人就能改画像</span>
    <button class="btn xs primary" type="button" data-open-profiles>打开画像调试 →</button>
  </div>`;
}

function renderChats() {
  const chats = state.snapshot?.chats || [];
  const profActive = state.activeChat === '__profiles' ? ' active' : '';
  const profItem = `<div class="chat-item prof-entry${profActive}" data-key="__profiles">
      <div class="key">按 QQ 号档案</div>
      <div class="sub">一人一份 · 点开可调试人物画像</div>
    </div>`;
  if (!chats.length) {
    el('chats').innerHTML = profItem + '<div class="empty">还没有会话记忆</div>';
    bindChatClicks();
    return;
  }
  el('chats').innerHTML = profItem + chats.map((chat) => {
    const pending = (chat.questions || []).length;
    const flags = [
      pending ? `<span class="badge hot">待裁决 ${pending}</span>` : '',
      chat.pendingConsolidateAt ? '<span class="badge">待整理</span>' : '',
      chat.pendingPrune ? '<span class="badge">待清理</span>' : ''
    ].join('');
    const active = chat.chatKey === state.activeChat ? ' active' : '';
    return `<div class="chat-item${active}" data-key="${esc(chat.chatKey)}">
      <div class="key">${esc(chat.chatKey)}</div>
      <div class="sub">成员 ${(chat.members || []).length} · 整理 ${stamp(chat.lastConsolidatedAt)}${flags}</div>
    </div>`;
  }).join('');
  bindChatClicks();
}

function bindChatClicks() {
  for (const node of el('chats').querySelectorAll('.chat-item')) {
    node.addEventListener('click', () => {
      state.activeChat = node.dataset.key;
      renderChats();
      if (node.dataset.key === '__profiles') { renderProfiles(); return; }
      renderDetail();
      void fetchLong(node.dataset.key).then(() => renderDetail());
    });
  }
}

/** 按 QQ 号的统一档案（后台一人一份、跨会话合并）。 */
const PROF_HIDE = ['黄油', '黄游', '小黄游', '成人游戏', '隆胸', '黄图', '色情', '本子', '约炮', '裸聊'];
function profHide(text) { const s = String(text ?? ''); return PROF_HIDE.some((w) => s.includes(w)); }
/** 关键点的类别中文名（预筛时打的 aspect）。 */
const ASPECT_CN = { health: '身体', money: '钱', family: '家里', work: '工作', plan: '日程', confide: '私下说', other: '事实' };

/** 画像条目的调试编辑器：改文字 / 维度 / 置信度，或降到长期、删掉。 */
function traitEditorHtml(t, uid) {
  const id = t ? String(t.id || '') : '';
  const dims = ['人格', '说话', '关系', '情绪', '喜好', '其他'];
  return `<div class="trait-editor">
    <div class="field">内容（改这句话本身）</div>
    <textarea data-trait-text="${esc(id)}" rows="3">${esc(t ? t.text : '')}</textarea>
    <div class="field" style="margin-top:8px">维度 · 置信度</div>
    <div class="row-actions">
      <select data-trait-dim="${esc(id)}" class="sel">${dims.map((d) => `<option value="${d}"${t && t.dim === d ? ' selected' : ''}>${d}</option>`).join('')}</select>
      <input class="sel" style="width:78px" type="number" min="0" max="100" step="5" data-trait-conf="${esc(id)}" value="${esc(t ? (t.confidence ?? 70) : 70)}">
      <button class="btn xs primary" type="button" data-trait-save="${esc(id)}" data-uid="${esc(uid)}">保存</button>
      ${t ? `<button class="btn xs ghost" type="button" data-trait-demote="${esc(id)}" data-uid="${esc(uid)}">降到长期</button>
      <button class="btn xs ghost" type="button" data-trait-drop="${esc(id)}" data-uid="${esc(uid)}">删掉</button>` : ''}
      <button class="btn xs ghost" type="button" data-trait-cancel="${esc(id)}">收起</button>
    </div>
    <div class="meta-line">信 = 置信度（低于 55 基本不会被塞进提示词）。「降到长期」= 从画像拿下来、回到可读的长期层，还能再升回去；「删掉」只删这条。</div>
  </div>`;
}

/** 一个人的完整档案：人物画像（最高层）｜长期记忆（可读）｜短期原料（只计数、不展示原文）。 */
function profBodyHtml(p, ttl) {
  if (!p) return '<div class="muted">没有这个人的档案</div>';
  const uid = esc(p.userId);
  const traits = (p.persona && p.persona.traits) || [];
  const tags = (p.persona && p.persona.tags) || [];
  const lt = (p.longTerm || []).filter((x) => x.flag !== 'sensitive' && !profHide(x.text));
  const facts = lt.filter((x) => x.kind !== 'event' && !x.promoted);
  const upFacts = lt.filter((x) => x.kind !== 'event' && x.promoted);
  const events = lt.filter((x) => x.kind === 'event');
  // 长期时效：只把最近 N 天内出现/复核过的结论算「在用」，更早的标成过时效（仍存档）；N=0 不限
  const longDays = Number(ttl && ttl.long) || 0;
  const minHits = Math.max(2, Number(ttl && ttl.minHits) || 3);
  const shortDays = Math.max(1, Number(ttl && ttl.short) || 2);
  const stillFresh = (x) => {
    if (x.kind === 'appointment') return true;
    if (!longDays) return true;
    const ref = Math.max(Number(x.lastVerified) || 0, Number(x.createdAt) || 0);
    return !ref || ref >= Date.now() - longDays * 86400000;
  };
  const factsFresh = facts.filter(stillFresh);
  const factsStale = facts.filter((x) => !stillFresh(x));
  const cands = (p.candidates || []).filter((x) => !profHide(x.text));
  const shorts = p.state || p.shortTerm || [];
  const expired = p.expired || [];
  const recent = shorts.reduce((m, x) => Math.max(m, Number(x.createdAt) || 0), 0);
  const maxHits = cands.reduce((m, x) => Math.max(m, Number(x.hits) || 0), 0);
  const line = (text, extra = '') => `<div class="short-line">${esc(text)}${extra}</div>`;
  const bar = (title, count, extra = '') => `<div class="bar"><span class="bar-title">${title}</span>${extra}<span class="bar-count">${count} 条</span></div>`;
  const traitLine = (t) => `<div class="short-line">${t.status === '废弃' ? '<span class="chip">已停用</span>' : ''}${esc(t.text)
    }<span class="chip" style="margin-left:6px">${esc(t.dim || '人格')} · 信 ${esc(t.confidence ?? 0)}</span>
    <button class="btn xs primary" type="button" data-trait-edit="${esc(t.id)}" data-uid="${uid}">调试</button></div>
    <div data-trait-box="${esc(t.id)}"></div>`;
  const traitsHtml = `<div data-trait-box="new"></div>` + (traits.length
    ? traits.map(traitLine).join('')
    : '<div class="muted">还没有画像结论。整理沉淀出长期结论后，可以把其中稳定的那条「升到画像」，或者直接点「＋ 加一条」手写</div>');
  const addTraitBtn = `<button class="btn xs primary" type="button" data-trait-new="1" data-uid="${uid}">＋ 加一条</button>`;
  const tagsHtml = tags.length
    ? `<div class="chips">${tags.map((t) => `<span class="chip label">${esc(t.tag)}</span>`).join('')}</div>`
    : '<div class="muted">还没有标签</div>';
  const factLine = (x) => `<div class="short-line">${esc(x.text)
    }<button class="btn xs ghost" type="button" data-trait-add="${esc(x.id)}" data-uid="${uid}">升到画像</button>${x.kind === 'appointment'
      ? '<span class="chip appt">约定</span>'
      : `<span class="chip">${esc(ASPECT_CN[x.aspect] || '事实')}</span>`
    }${Number(x.hits) > 1 ? `<span class="badge">提及 ${esc(x.hits)}</span>` : ''}
    <button class="btn xs ghost" type="button" data-long-demote="${esc(x.id)}" data-uid="${uid}">降到候选</button></div>${x.evidence
      ? `<div class="meta-line" style="opacity:.7">原话：${esc(String(x.evidence).slice(0, 80))}</div>` : ''}`;
  const keyFacts = factsFresh.filter((x) => x.kind === 'fact' || x.kind === 'appointment');
  const memoFacts = factsFresh.filter((x) => !(x.kind === 'fact' || x.kind === 'appointment'));
  const keyHtml = keyFacts.length
    ? keyFacts.map(factLine).join('')
    : '<div class="muted">还没捞到关键点（身体、家里、工作钱、日程这类硬事实）</div>';
  const memoHtml = memoFacts.length
    ? memoFacts.map(factLine).join('')
    : '<div class="muted">还没有转过正的结论</div>';
  const staleHtml = factsStale.length
    ? `<details style="margin:4px 0"><summary class="muted" style="cursor:pointer">已过时效 ${factsStale.length} 条（只存档，不进提示词）</summary>${factsStale.map((x) => `<div class="meta-line" style="opacity:.6">${esc(x.text)}</div>`).join('')}</details>`
    : '';
  const upHtml = upFacts.length
    ? `<details style="margin:4px 0"><summary class="muted" style="cursor:pointer">已升入画像 ${upFacts.length} 条（长期段不再重复）</summary>${upFacts.map((x) => `<div class="meta-line" style="opacity:.7">${esc(x.text)}</div>`).join('')}</details>`
    : '';
  const eventsHtml = events.length
    ? `<details style="margin:4px 0"><summary class="muted" style="cursor:pointer">事件流水 ${events.length} 条（存档，不注入提示词）</summary>${events.slice().reverse().slice(0, 60).map((x) => `<div class="meta-line">${esc(String(x.text || '').slice(0, 200))}</div>`).join('')}${events.length > 60 ? `<div class="muted">还有 ${events.length - 60} 条没有列出来</div>` : ''}</details>`
    : '';
  // 短期只当原料：不给模型读，这里也不展开原文，只让人看见「积了多少、什么时候到期」
  const shortHtml = `<div class="meta-line">存进档案当原料，不进提示词；${shortDays} 天到期后自动归档${recent ? `，最近一条 ${stamp(recent)}` : ''}</div>
    <div class="meta-line">候审 ${cands.length} 条${cands.length ? `（提及最多 ${maxHits} 次，满 ${minHits} 次才转长期）` : ''}　已归档 ${expired.length} 条</div>`;
  return `<div class="block-primary">${bar('人物画像 · 最高层（可以在这里调试）', traits.length, addTraitBtn)}${traitsHtml}${tagsHtml}</div>
    ${bar('关键点 · 硬事实（优先注入，不压标签）', keyFacts.length)}${keyHtml}
    ${bar('其他结论（性格 / 关系 / 偏好）' + (longDays ? `（近 ${longDays} 天在用）` : ''), memoFacts.length)}${memoHtml}${staleHtml}${upHtml}${eventsHtml}
    ${bar('短期记忆 · 原料池（不读原文）', shorts.length)}${shortHtml}`;
}

async function renderProfiles() {
  el('detail').innerHTML = '<div class="muted">读取档案…</div>';
  let out = null;
  try { out = await act('profiles', {}); } catch { /* 已提示 */ }
  const items = (out && out.items) || [];
  if (!items.length) {
    el('detail').innerHTML = '<div class="empty">档案目录还是空的（整理过一次就会有）</div>';
    return;
  }
  el('detail').innerHTML = `
    <div class="detail-head">
      <h3>按 QQ 号档案（${items.length} 人）</h3>
      <div class="row-actions"><span class="muted">一人一份、跨会话合并</span>
        <button class="btn xs ghost" type="button" data-demote-sweep="1">按设置降级一次</button></div>
    </div>
    <div class="tip"><span class="dot">◆</span><span class="tip-text">点某张卡（或右上「展开档案」）看三层：<b>人物画像</b>（每条旁「调试」可改文字 / 维度 / 置信度，可降到长期或删掉）→ 长期记忆（可升到画像、可降到候选）→ 短期原料（只报条数）</span></div>
    ${items.map((p) => `<div class="member" data-prof="${esc(p.userId)}">
      <div class="top"><span class="name">${esc(p.name)}</span><span class="uid">QQ ${esc(p.userId)}</span>
        <span class="badge" style="margin-left:auto">画像 ${esc(p.portrait)} · 长期 ${esc(p.long)} · 事件 ${esc(p.events)} · 短期 ${esc(p.shortTerm)}</span>
        <button class="btn xs primary" type="button" data-prof-expand="${esc(p.userId)}">展开档案 ▾</button>
      </div>
      <div class="chips">${(p.tags || []).map((t) => `<span class="chip label">${esc(t)}</span>`).join('')}</div>
      <div class="meta-line">${esc((p.aliases || []).filter((a) => a !== p.userId).join(' / ') || '无别名')}　${esc((p.scopes || []).join(' '))}</div>
      <div data-prof-body="${esc(p.userId)}"></div>
    </div>`).join('')}`;
}

/** 仅切到档案视图（列出所有人）。 */
async function openProfiles() {
  state.activeChat = '__profiles';
  renderChats();
  await renderProfiles();
}

/** 从会话视图点「画像」：直接切到按 QQ 号档案，并把这个人展开到画像调试那一段。 */
async function jumpToProfile(uid) {
  if (!uid) { await openProfiles(); return; }
  await openProfiles();
  const card = document.querySelector(`[data-prof="${uid}"]`);
  if (!card) {
    toast('这个人的档案还没建（整理过一次才有）', true);
    return;
  }
  const btn = card.querySelector('[data-prof-expand]');
  if (btn && btn.dataset.open !== '1') await expandProf(btn);
  card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  const edit = card.querySelector('[data-trait-edit],[data-trait-new]');
  if (edit) setTimeout(() => edit.focus?.(), 300);
}

/** 展开一个人：按需读取完整档案，避免一次拉 73 人。 */
async function expandProf(btn) {
  const uid = btn.dataset.profExpand;
  const card = btn.closest('.member');
  const box = card && card.querySelector(`[data-prof-body="${uid}"]`);
  if (!box || !uid) return;
  if (btn.dataset.open === '1') {
    box.innerHTML = '';
    btn.dataset.open = '0';
    btn.textContent = '展开 ▾';
    return;
  }
  btn.textContent = '收起';
  btn.dataset.open = '1';
  box.innerHTML = '<div class="muted">读取…</div>';
  try {
    const out = await act('profile-detail', { userId: uid });
    state.profMap = state.profMap || {};
    state.profMap[uid] = (out && out.profile) || null;
    box.innerHTML = profBodyHtml(out && out.profile, out && out.ttl);
  } catch (error) {
    box.innerHTML = `<div class="muted">读取失败：${esc(error?.message ?? error)}</div>`;
  }
}

/** 取某个会话的核心长期印象（只读磁盘，失败就当空，不影响主界面）。 */
async function fetchLong(chatKey) {
  if (!chatKey) { state.longs = []; return; }
  try {
    const out = await act('long-list', { chatKey });
    state.longs = Array.isArray(out?.members) ? out.members : [];
  } catch {
    state.longs = [];
  }
}

function shortContent(item) {
  if (typeof item === 'string') return item;
  return String(item?.content || item?.text || '');
}

function memberBlock(m, longEntry) {
  const uid = esc(m.userId);
  const name = esc(m.name || m.userId);
  const labels = (m.labels || []).map((t) => {
    const tag = typeof t === 'string' ? t : (t?.tag || '');
    return tag ? `<span class="chip label">${esc(tag)}</span>` : '';
  }).join('');
  const impressions = (longEntry?.impressions || [])
    .map((it) => ({ content: String(it?.content || ''), createdAt: Number(it?.createdAt) || 0 }))
    .filter((it) => it.content)
    .sort((a, b) => b.createdAt - a.createdAt || (a.content < b.content ? -1 : 1));
  const longHtml = impressions.length
    ? impressions.map((it) => `<label class="pick"><input type="checkbox" data-long="1" data-text="${esc(it.content)}"><span>${esc(it.content)}</span></label>`).join('')
    : '<div class="muted">还没有长期印象</div>';
  const shorts = (m.short || []).filter((s) => shortContent(s))
    .sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
  const shortHtml = shorts.length
    ? shorts.map((s) => {
      const id = typeof s === 'string' ? '' : String(s.id || '');
      const hits = typeof s === 'string' ? 0 : (Number(s.hits) || 0);
      const kind = typeof s === 'string' ? '' : String(s.kind || '');
      // 约定类显示说定的具体时刻：只写"明天三点"在界面上等于没有信息，过一天就不知道是哪天了
      const dueNote = typeof s === 'string' ? '' : String(s.dueNote || '');
      const dueAt = typeof s === 'string' ? 0 : (Number(s.dueAt) || 0);
      const duePast = dueAt && Date.now() > dueAt;
      const dueHtml = dueNote ? `<span class="badge due${duePast ? ' due-past' : ''}">约在 ${esc(dueNote)}${duePast ? ' · 已到点' : ''}</span>` : '';
      return `<label class="pick"><input type="checkbox" data-short="1" data-id="${esc(id)}"><span>${esc(shortContent(s))}</span>${kind ? `<span class="chip${kind === 'appointment' ? ' appt' : ''}">${esc(kindCn(kind))}</span>` : ''}${dueHtml}${hits ? `<span class="badge">提及 ${hits}</span>` : ''}</label>`;
    }).join('')
    : '<div class="muted">没有短期记忆</div>';
  return `<div class="member" data-uid="${uid}" data-name="${name}">
    <div class="top"><span class="name">${name}</span><span class="uid">${uid}</span><button class="btn xs ghost" style="margin-left:auto" type="button" data-act="consolidate-one" title="只整理这个人（回看天数用上面的范围）">整理他</button><button class="btn xs" type="button" data-prof-jump="${uid}" title="打开他的人物画像，可改文字 / 维度 / 置信度、升到画像或降级">画像</button></div>
    ${labels ? `<div class="chips">${labels}</div>` : ''}
    <div class="bar"><span class="bar-title">印象（核心长期）</span><button class="btn xs" type="button" data-act="long-all">全选</button><button class="btn xs ghost" type="button" data-act="long-del">删除选中</button><span class="bar-count" data-count="long"></span></div>
    ${longHtml}
    <div class="bar"><span class="bar-title">短期记忆</span><button class="btn xs" type="button" data-act="short-all">全选</button><button class="btn xs ghost" type="button" data-act="promote">晋升选中</button><button class="btn xs ghost" type="button" data-act="short-del">删除选中</button><span class="bar-count" data-count="short"></span></div>
    ${shortHtml}
  </div>`;
}

function syncCounts(card) {
  if (!card) return;
  for (const kind of ['long', 'short']) {
    const boxes = [...card.querySelectorAll(kind === 'long' ? 'input[data-long]' : 'input[data-short]')];
    const picked = boxes.filter((box) => box.checked).length;
    const label = card.querySelector(`[data-count="${kind}"]`);
    if (label) label.textContent = boxes.length ? `已选 ${picked} / ${boxes.length}` : '';
  }
}

async function onBatch(btn) {
  const card = btn.closest('.member');
  const chatKey = state.activeChat;
  if (!card || !chatKey) return;
  const action = btn.dataset.act;
  const uid = card.dataset.uid;
  const name = card.dataset.name || '';
  if (!uid) return;
  // 只整理这一个人：回看天数沿用标题栏那个范围，其他人完全不动
  if (action === 'consolidate-one') {
    const days = (Number((el('chat-days') || {}).value) || 3);
    await run('consolidate', { chatKey, userIds: [uid], days }, `已启动整理：${name || uid}（回看 ${days} 天）`);
    await load().catch(() => {});
    return;
  }
  if (action === 'long-all' || action === 'short-all') {
    const selector = action === 'long-all' ? 'input[data-long]' : 'input[data-short]';
    const boxes = [...card.querySelectorAll(selector)];
    const all = boxes.length > 0 && boxes.every((box) => box.checked);
    boxes.forEach((box) => { box.checked = !all; });
    syncCounts(card);
    return;
  }
  const pickedLong = [...card.querySelectorAll('input[data-long]:checked')].map((box) => box.dataset.text || '');
  const pickedShort = [...card.querySelectorAll('input[data-short]:checked')].map((box) => box.dataset.id || '');
  if (action === 'long-del' || action === 'short-del') {
    if (!pickedLong.length && !pickedShort.length) { toast('先勾选要删除的条目', true); return; }
    if (!btn.dataset.armed) {
      // 第一次点击只是"上膛"：按钮变红并写清要删几条。不设自动复位——
      // 4 秒后自己还原会让用户以为没点上，反而点第三次。
      btn.dataset.armed = '1';
      btn.classList.add('danger');
      const n = action === 'long-del' ? pickedLong.length : pickedShort.length;
      btn.textContent = `确认删除 ${n} 条`;
      return;
    }
    delete btn.dataset.armed;
    btn.classList.remove('danger');
    btn.textContent = '删除选中';
  }
  if (action === 'long-del') {
    await run('long-delete', { chatKey, userId: uid, name, contents: pickedLong }, `已删除 ${pickedLong.length} 条长期印象`);
    await fetchLong(chatKey);
    renderDetail();
    return;
  }
  if (action === 'promote') {
    if (!pickedShort.length) { toast('先勾选要晋升的短期记忆', true); return; }
    let done = 0;
    for (const shortId of pickedShort) {
      try {
        const out = await act('promote', { chatKey, userId: uid, shortId });
        if (out && out.ok !== false) done += 1;
      } catch (error) { toast(String(error?.message ?? error), true); }
    }
    toast(`已晋升 ${done} 条到长期记忆`);
    await fetchLong(chatKey);
    await load();
    return;
  }
  if (action === 'short-del') {
    let done = 0;
    for (const shortId of pickedShort) {
      try {
        const out = await act('short-delete', { chatKey, userId: uid, shortId });
        if (out && out.ok !== false) done += 1;
      } catch (error) { toast(String(error?.message ?? error), true); }
    }
    toast(done ? `已删除 ${done} 条短期记忆` : '没删掉（可能已被处理）', !done);
    await load();
  }
}

function renderDetail() {
  if (state.activeChat === '__profiles') { void renderProfiles(); return; }
  const chat = (state.snapshot?.chats || []).find((c) => c.chatKey === state.activeChat);
  if (!chat) {
    el('detail').innerHTML = '<div class="empty">选择左侧会话查看成员印象</div>';
    return;
  }
  const members = chat.members || [];
  const meta = chat.meta || [];
  const questions = chat.questions || [];
  const longByUid = new Map((state.longs || []).map((m) => [String(m.userId), m]));
  const sortMode = state.sort;
  const countOf = (m) => (longByUid.get(String(m.userId))?.impressions || []).length + (m.short || []).length;
  const sorted = [...members].sort((a, b) => {
    if (sortMode === 'qq') return String(a.userId).localeCompare(String(b.userId), undefined, { numeric: true });
    if (sortMode === 'name') return String(a.name || a.userId).localeCompare(String(b.name || b.userId), 'zh-Hans-CN');
    return countOf(b) - countOf(a) || String(a.userId).localeCompare(String(b.userId), undefined, { numeric: true });
  });

  const memberHtml = sorted.length
    ? sorted.map((m) => memberBlock(m, longByUid.get(String(m.userId)))).join('')
    : '<div class="empty">这个会话还没有成员印象</div>';

  const metaHtml = meta.length ? meta.map((m) => (
    `<div class="member"><div class="top"><span class="chip">${esc(m.kind || '长期')}</span><span class="uid">提及 ${esc(m.hits || 0)}</span></div>
     <div class="short-line">${esc(m.content)}</div>
     ${m.reason ? `<div class="meta-line">${esc(m.reason)}</div>` : ''}</div>`
  )).join('') : '<div class="empty">暂无长期记忆旁注</div>';

  const questionHtml = questions.length ? questions.map((q) => {
    const text = typeof q === 'string' ? q : (q?.content || q?.question || '');
    return `<div class="q">${esc(text)}${q?.createdAt ? `<div class="meta-line">${stamp(q.createdAt)}</div>` : ''}</div>`;
  }).join('') : '<div class="muted">没有待裁决的问题</div>';

  el('detail').innerHTML = `
    <div class="detail-head">
      <h3>${esc(chat.chatKey)}</h3>
      <div class="row-actions">
        <select id="member-sort" class="sel" title="成员排序">
          <option value="count">成员：按条数</option>
          <option value="qq">成员：按 QQ 号</option>
          <option value="name">成员：按昵称</option>
        </select>
        <select id="chat-days" class="sel" title="整理时回看几天聊天记录">
          <option value="1">范围：1 天（今天）</option>
          <option value="3" selected>范围：3 天</option>
          <option value="7">范围：7 天</option>
        </select>
        <button class="btn" id="chat-consolidate" type="button">整理这个会话</button>
        <button class="btn ghost" id="chat-keypoints" type="button">这次能捞到什么</button>
        <button class="btn ghost" id="chat-status" type="button">看任务状态</button>
      </div>
    </div>
    <div class="section-title">成员</div>${memberHtml}
    <div class="section-title">长期记忆（晋升旁注）</div>${metaHtml}
    <div class="section-title">待裁决（模型拿不准，等你定）</div>${questionHtml}
  `;
  for (const card of el('detail').querySelectorAll('.member')) syncCounts(card);

  el('member-sort').value = state.sort;
  el('member-sort').addEventListener('change', (event) => {
    state.sort = event.target.value || 'count';
    renderDetail();
  });

  el('chat-consolidate').addEventListener('click', async () => {
    try {
      const daysSel = el('chat-days');
      const days = daysSel ? (Number(daysSel.value) || 3) : 3;
      await run('consolidate', { chatKey: chat.chatKey, days }, `整理任务已启动（回看 ${days} 天，会花一次模型调用）`);
      await load();
    } catch { /* 已提示 */ }
  });
  el('chat-keypoints').addEventListener('click', async () => {
    // 整理之前先看规则筛出了什么：噪声多就说明这回没东西可记，不是"漏记"
    const days = Number((el('chat-days') || {}).value) || 3;
    try {
      const out = await act('keypoints', { chatKey: chat.chatKey, days, max: 30 });
      const items = (out && out.items) || [];
      el('note').textContent = items.length
        ? `存档 ${out.archived} 条 / 近 ${out.days} 天 ${out.inRange} 条 / 筛出 ${out.count} 条候选：` + items.slice(0, 8).map((i) => `[${i.aspect}] ${i.name}：${i.text}`).join(' ／ ')
        : `近 ${out.days} 天没有筛到候选句（存档 ${out.archived} 条，${out.inRange} 条在范围内）—— 这段确实没有生活事实类的话`;
    } catch (error) {
      toast(String(error?.message ?? error), true);
    }
  });
  el('chat-status').addEventListener('click', async () => {
    try {
      const out = await run('status', { chatKey: chat.chatKey }, '状态已读取');
      el('note').textContent = JSON.stringify(out).slice(0, 600);
    } catch { /* 已提示 */ }
  });
}
async function load() {
  el('note').textContent = '读取中…';
  const snap = await act('overview', {});
  if (snap && typeof snap === 'object' && !Array.isArray(snap)) snap.readAt = Date.now();
  state.snapshot = snap || {};
  if (!state.activeChat && (snap.chats || []).length) state.activeChat = snap.chats[0].chatKey;
  renderStats();
  renderBanner();
  renderChats();
  if (state.activeChat !== '__profiles') await fetchLong(state.activeChat);
  renderDetail();
  el('note').textContent = '就绪';
}

el('banner').addEventListener('click', (event) => {
  if (!event.target.closest('[data-open-profiles]')) return;
  void openProfiles().catch((error) => toast(String(error?.message ?? error), true));
});

el('detail').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-act]');
  if (btn) void onBatch(btn).catch((error) => toast(String(error?.message ?? error), true));
});

// 档案「展开/收起」：一个人一层点开，才去读他的完整档案；整张卡也能点（只在没展开时展开）
el('detail').addEventListener('click', (event) => {
  if (event.target.closest('button,a,input,textarea,select,label')) {
    const btn = event.target.closest('[data-prof-expand]');
    if (btn) void expandProf(btn).catch((error) => toast(String(error?.message ?? error), true));
    return;
  }
  const card = event.target.closest('.member[data-prof]');
  if (!card) return;
  const btn = card.querySelector('[data-prof-expand]');
  if (btn && btn.dataset.open !== '1') void expandProf(btn).catch((error) => toast(String(error?.message ?? error), true));
});

// 勾选状态一变就刷新计数，并把"确认删除 N 条"复位：
// 选择变了之后原来那个数字就不对了，留着会让人以为只删旧的几条。
el('detail').addEventListener('change', (event) => {
  if (!event.target.matches('input[data-long],input[data-short]')) return;
  const card = event.target.closest('.member');
  if (!card) return;
  syncCounts(card);
  for (const btn of card.querySelectorAll('[data-act="long-del"],[data-act="short-del"]')) {
    delete btn.dataset.armed;
    btn.classList.remove('danger');
    btn.textContent = '删除选中';
  }
});

// 长期结论「升到画像」：升完直接在他自己的卡里重画，不用整页刷新
async function redrawProf(uid, out) {
  if (out && out.profile) {
    state.profMap = state.profMap || {};
    state.profMap[uid] = out.profile;
  }
  const box = document.querySelector(`[data-prof-body="${uid}"]`);
  if (box && out && out.profile) box.innerHTML = profBodyHtml(out.profile, out.ttl);
}

async function onTraitAdd(btn) {
  const uid = btn.dataset.uid;
  const id = btn.dataset.traitAdd;
  if (!uid || !id) return;
  btn.disabled = true;
  try {
    const out = await act('promote-trait', { userId: uid, id });
    await redrawProf(uid, out);
    toast(out && out.already ? '这条已经在画像里了' : '已升到人物画像');
  } catch (error) {
    btn.disabled = false;
    toast(String(error?.message ?? error), true);
  }
}

/** 画像调试窗口：打开编辑器 / 保存 / 降到长期 / 删掉；长期那层也能「降到候选」。 */
async function onTraitAction(btn) {
  const uid = btn.dataset.uid || '';
  const editId = btn.dataset.traitEdit;
  const saveId = btn.dataset.traitSave;
  const demoteId = btn.dataset.traitDemote;
  const dropId = btn.dataset.traitDrop;
  const longId = btn.dataset.longDemote;

  // 打开编辑器
  if (editId !== undefined || btn.dataset.traitNew !== undefined) {
    const key = editId !== undefined ? editId : 'new';
    const host = document.querySelector(`[data-trait-box="${key}"]`);
    if (!host) return;
    const p = uid && state.profMap && state.profMap[uid];
    const t = editId !== undefined && p
      ? ((p.persona || {}).traits || []).find((x) => String(x.id) === String(editId))
      : null;
    host.innerHTML = traitEditorHtml(t, uid);
    const ta = host.querySelector('textarea');
    if (ta) ta.focus();
    return;
  }

  // 收起
  if (btn.dataset.traitCancel !== undefined) {
    const host = btn.closest('.trait-editor');
    if (host) host.remove();
    return;
  }

  const scope = btn.closest('.trait-editor');
  try {
    if (saveId !== undefined) {
      const text = (scope && scope.querySelector('[data-trait-text]')?.value) || '';
      const dim = (scope && scope.querySelector('[data-trait-dim]')?.value) || '人格';
      const conf = Number((scope && scope.querySelector('[data-trait-conf]')?.value));
      if (!String(text).trim()) { toast('内容不能为空', true); return; }
      const out = await act('trait-save', { userId: uid, id: saveId, text, dim, confidence: conf });
      await redrawProf(uid, out);
      toast('画像已保存');
      return;
    }
    if (demoteId !== undefined) {
      const out = await act('demote', { userId: uid, layer: 'trait', id: demoteId });
      await redrawProf(uid, out);
      toast('已降到长期记忆');
      return;
    }
    if (dropId !== undefined) {
      const out = await act('trait-delete', { userId: uid, id: dropId });
      await redrawProf(uid, out);
      toast('已删掉这条画像');
      return;
    }
    if (longId !== undefined) {
      const out = await act('demote', { userId: uid, layer: 'long', id: longId });
      await redrawProf(uid, out);
      toast('已降到候选（要重新攒够次数才转正）');
    }
  } catch (error) {
    toast(String(error?.message ?? error), true);
  }
}

el('detail').addEventListener('click', async (event) => {
  const jump = event.target.closest('[data-prof-jump]');
  if (jump) {
    void jumpToProfile(jump.dataset.profJump).catch((error) => toast(String(error?.message ?? error), true));
    return;
  }
  const sweep = event.target.closest('[data-demote-sweep]');
  if (sweep) {
    try {
      const out = await act('demote-sweep', {});
      toast(`按设置降级：长期 ${out.long || 0} 条 → 候选，画像 ${out.trait || 0} 条 → 长期（扫了 ${out.scanned || 0} 人）`);
      await renderProfiles();
    } catch (error) {
      toast(String(error?.message ?? error), true);
    }
    return;
  }
  const add = event.target.closest('[data-trait-add]');
  if (add) { void onTraitAdd(add).catch((error) => toast(String(error?.message ?? error), true)); return; }
  const btn = event.target.closest('[data-trait-edit],[data-trait-new],[data-trait-save],[data-trait-demote],[data-trait-drop],[data-trait-cancel],[data-long-demote]');
  if (btn) void onTraitAction(btn).catch((error) => toast(String(error?.message ?? error), true));
});

el('refresh').addEventListener('click', () => { load().catch((e) => toast(String(e?.message ?? e), true)); });
el('export').addEventListener('click', () => { run('export-snapshot', {}, '长期记忆快照已导出').catch(() => {}); });
el('sweep').addEventListener('click', () => { run('sweep-now', {}, '存档清理完成').catch(() => {}); });

// 接走头部同步脚本已经收到的握手；还没有就登记一个等待位，
// 等它收到 panel.init 时回调过来（模块脚本比宿主的单发 init 晚执行时全靠这条）。
if (!adoptHandshake()) {
  (window.__mpHandshakeWaiters || (window.__mpHandshakeWaiters = [])).push(adoptHandshake);
}

// 兜底：3 秒还没收到 panel.init 就提示（不在宿主 iframe 里直接打开时就是这样）
setTimeout(() => {
  if (!state.ready) {
    el('note').textContent = '';
    toast('没有收到宿主握手：请在控制台里打开本面板，而不是直接打开这个文件。', true);
  }
}, 3000);
