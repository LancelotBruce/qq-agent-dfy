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

window.addEventListener('message', (event) => {
  const message = event.data;
  if (!message || message.jsonrpc !== '2.0') return;
  if (message.method === 'panel.init') {
    state.nonce = String(message.params?.nonce || '');
    state.panel = String(message.params?.panel || state.panel);
    if (!state.ready) { state.ready = true; load().catch((error) => toast(`面板读取失败：${error?.message ?? error}`, true)); }
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
  const stats = snap.stats || {};
  const cards = [
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

function renderChats() {
  const chats = state.snapshot?.chats || [];
  if (!chats.length) {
    el('chats').innerHTML = '<div class="empty">还没有会话记忆</div>';
    return;
  }
  el('chats').innerHTML = chats.map((chat) => {
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
  for (const node of el('chats').querySelectorAll('.chat-item')) {
    node.addEventListener('click', () => {
      state.activeChat = node.dataset.key;
      renderChats();
      renderDetail();
      void fetchLong(node.dataset.key).then(() => renderDetail());
    });
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
      return `<label class="pick"><input type="checkbox" data-short="1" data-id="${esc(id)}"><span>${esc(shortContent(s))}</span>${kind ? `<span class="chip">${esc(kind)}</span>` : ''}${hits ? `<span class="badge">提及 ${hits}</span>` : ''}</label>`;
    }).join('')
    : '<div class="muted">没有短期记忆</div>';
  return `<div class="member" data-uid="${uid}" data-name="${name}">
    <div class="top"><span class="name">${name}</span><span class="uid">${uid}</span></div>
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
      btn.dataset.armed = '1';
      btn.textContent = '再点一次确认';
      setTimeout(() => { if (btn.dataset.armed) { delete btn.dataset.armed; btn.textContent = '删除选中'; } }, 4000);
      return;
    }
    delete btn.dataset.armed;
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
        <button class="btn" id="chat-consolidate" type="button">整理这个会话</button>
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
      await run('consolidate', { chatKey: chat.chatKey }, '整理任务已启动（会花一次模型调用）');
      await load();
    } catch { /* 已提示 */ }
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
  renderChats();
  await fetchLong(state.activeChat);
  renderDetail();
  el('note').textContent = '就绪';
}

el('detail').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-act]');
  if (btn) void onBatch(btn).catch((error) => toast(String(error?.message ?? error), true));
});

el('refresh').addEventListener('click', () => { load().catch((e) => toast(String(e?.message ?? e), true)); });
el('export').addEventListener('click', () => { run('export-snapshot', {}, '长期记忆快照已导出').catch(() => {}); });
el('sweep').addEventListener('click', () => { run('sweep-now', {}, '存档清理完成').catch(() => {}); });

// 兜底：3 秒还没收到 panel.init 就提示（不在宿主 iframe 里直接打开时就是这样）
setTimeout(() => {
  if (!state.ready) {
    el('note').textContent = '';
    toast('没有收到宿主握手：请在控制台里打开本面板，而不是直接打开这个文件。', true);
  }
}, 3000);
