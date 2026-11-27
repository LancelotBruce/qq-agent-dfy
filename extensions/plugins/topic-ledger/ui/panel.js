// 台账页：只调本插件自己的工具（取数 / 立即扫一次 / 强制收尾），不碰宿主其它接口。
import { ctx } from '/panels/panel-client.js';
import '/panels/theme.js';
import { installMotion } from '/panels/motion.js';

installMotion();

const TOOL_DATA = 'topic-ledger__panel_data';
const TOOL_SCAN = 'topic-ledger__scan_now';
const TOOL_CLOSE = 'topic-ledger__force_close';

const $label = document.querySelector('#label');
const $sub = document.querySelector('#sub');
const $list = document.querySelector('#list');
const $empty = document.querySelector('#empty');
const $refresh = document.querySelector('#refresh');
const $closeAll = document.querySelector('#close-all');
const $refineAll = document.querySelector('#refine-all');
const $tabs = document.querySelector('#tabs');

let filter = 'all';
let payload = null;
let allArmed = false;
let refineArmed = false;
let pollTimer = 0;

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

function parseToolContent(raw) {
  if (!raw) return null;
  if (raw && raw.ok === false) return { error: raw.error || '工具调用失败' };
  if (typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'result')) raw = raw.result;
  if (raw && typeof raw === 'object' && typeof raw.content === 'string') raw = raw.content;
  if (typeof raw === 'string') {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function chip(text, cls = '') {
  return el('span', `chip ${cls}`.trim(), text);
}

function renderDetail(chain) {
  const box = el('div', 'detail');
  const dl = el('dl');
  const add = (k, v) => {
    if (!v) return;
    dl.append(el('dt', '', k), el('dd', '', v));
  };
  add('参与', chain.cast || '');
  add('对话', chain.pairText || '');
  add('事实', chain.facts.join('\n'));
  add('已定', chain.decided.join('\n'));
  add('未决', chain.pending.join('\n'));
  add('约定', chain.promises.join('\n'));
  add('原话', chain.quotes.map((q) => `${q.who} ${q.at}「${q.text}」`).join('\n'));
  add('情绪', chain.mood);
  if (chain.splitReason === 'manual') add('收尾', '手动强制收尾');
  add('变更', chain.changes.map((c) => `${c.at} ${c.note}`).join('\n'));
  add('消息', `${chain.count} 条${chain.memoryWritten ? '｜已写进长期记忆' : ''}${chain.error ? '｜上次整理失败：' + chain.error : ''}`);
  add('尾段', chain.tailNote);
  box.append(dl);
  return box;
}

function renderCard(chain) {
  const card = el('article', `card ${chain.status === 'open' ? 'open' : 'closed'}`);
  const row = el('div', 'row');
  row.append(el('span', 'seq', `T${chain.seq}`), el('span', 'title', chain.title));
  row.append(chip(chain.statusText, chain.status === 'open' ? 'open' : ''));
  if (chain.memoryWritten) row.append(chip('入记忆', 'mem'));
  row.append(el('span', 'when', `${chain.start}–${chain.end}`));
  card.append(row);

  let metaText = `${chain.chatLabel}｜${chain.count} 条消息${chain.drafted ? '' : '｜还未整理'}`;
  if (chain.status === 'closed') {
    if (chain.refining) metaText += '｜精修中';
    else if (!chain.finalized) metaText += '｜待终稿';
    else if (chain.finalizeMode === 'refined') metaText += '｜已精修';
    else if (chain.finalizeMode === 'fast') metaText += '｜已秒收';
    else if (chain.finalizeMode === 'refine-failed') metaText += '｜精修失败';
    else if (chain.finalizeMode === 'local-budget') metaText += '｜预算不足，未精修';
  }
  if (chain.tailNote) metaText += '｜尾段未整理';
  const meta = el('div', 'chat', metaText);
  card.append(meta);

  const brief = [];
  if (chain.facts.length) brief.push(chain.facts[0]);
  if (chain.decided.length) brief.push('已定：' + chain.decided[0]);
  if (chain.pending.length) brief.push('未决：' + chain.pending[0]);
  if (chain.promises.length) brief.push('约定：' + chain.promises[0]);
  if (brief.length) card.append(el('p', 'brief', brief.join('；')));

  const detail = renderDetail(chain);
  const more = el('button', 'more', '展开细节');
  more.type = 'button';
  more.addEventListener('click', () => {
    const on = detail.classList.toggle('on');
    more.textContent = on ? '收起' : '展开细节';
  });

  const actions = el('div', 'card-actions');
  actions.append(more);

  // 进行中的链给「精修 / 强制」；已经秒收的链再给一个「补精修」。
  const isOpen = chain.status === 'open';
  const canRefine = isOpen || (chain.status === 'closed' && chain.finalized && !chain.memoryWritten
    && (chain.finalizeMode === 'fast' || chain.finalizeMode === 'refine-failed' || chain.finalizeMode === 'local-budget'
      || (chain.splitReason === 'manual' && !chain.finalizeMode)));
  if (canRefine) {
    const label = isOpen ? '精修收尾' : '补精修';
    const refine = el('button', 'btn refine', label);
    refine.type = 'button';
    refine.title = isOpen
      ? '封链后让模型把已有条目和整条链再收一遍终稿，慢一点、会消耗调用次数'
      : '这条是秒收的，让模型再补一版终稿（未封版、未写长期记忆才可补）';
    let refineTimer = 0;
    const disarmRefine = () => {
      delete refine.dataset.armed;
      refine.classList.remove('is-armed');
      refine.textContent = label;
    };
    refine.addEventListener('click', async () => {
      if (!refine.dataset.armed) {
        refine.dataset.armed = '1';
        refine.classList.add('is-armed');
        refine.textContent = isOpen ? '确认精修？' : '确认补精修？';
        refineTimer = setTimeout(disarmRefine, 3000);
        return;
      }
      clearTimeout(refineTimer);
      refine.disabled = true;
      refine.textContent = '精修中…';
      try {
        const raw = await ctx.call(TOOL_CLOSE, { id: chain.id, refine: true });
        const data = parseToolContent(raw);
        if (!data || data.error || data.ok === false) throw new Error(data?.error || '精修收尾失败');
        meta.textContent += isOpen ? '｜已排入精修' : '｜补精修排队中';
        pollRefine();
        setTimeout(() => load(false), 1200);
      } catch (error) {
        refine.disabled = false;
        disarmRefine();
        $sub.textContent = `${isOpen ? '精修收尾' : '补精修'}失败：${error?.message ?? error}`;
      }
    });
    actions.append(refine);
  }

  if (isOpen) {
    const force = el('button', 'btn force', '强制收尾');
    force.type = 'button';
    force.title = '立刻把这条封掉，不调模型，几秒内落盘';
    let armedTimer = 0;
    const disarm = () => {
      delete force.dataset.armed;
      force.classList.remove('is-armed');
      force.textContent = '强制收尾';
    };
    force.addEventListener('click', async () => {
      if (!force.dataset.armed) {
        force.dataset.armed = '1';
        force.classList.add('is-armed');
        force.textContent = '再点一次确认';
        armedTimer = setTimeout(disarm, 3000);
        return;
      }
      clearTimeout(armedTimer);
      force.disabled = true;
      force.textContent = '收尾中…';
      try {
        const raw = await ctx.call(TOOL_CLOSE, { id: chain.id });
        const data = parseToolContent(raw);
        if (!data || data.error || data.ok === false) throw new Error(data?.error || '收尾失败');
        force.textContent = '已收尾';
        meta.textContent += '｜已强制收尾';
        setTimeout(() => load(false), 600);
      } catch (error) {
        force.disabled = false;
        disarm();
        $sub.textContent = `强制收尾失败：${error?.message ?? error}`;
      }
    });
    actions.append(force);
  }

  card.append(actions, detail);
  return card;
}

function render() {
  if (!payload || !Array.isArray(payload.chains)) return;
  $label.textContent = `今日台账 · ${payload.label}`;
  const open = payload.chains.filter((c) => c.status === 'open').length;
  $sub.textContent = `账期从 ${new Date(payload.windowStart).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 起｜事件链 ${payload.chains.length} 条（进行中 ${open}）｜今日整理调用 ${payload.budget?.calls ?? 0} 次`;
  $closeAll.hidden = open === 0;
  if (!allArmed) $closeAll.textContent = `全部收尾（${open}）`;
  $refineAll.hidden = open === 0;
  if (!refineArmed) $refineAll.textContent = `全部精修（${open}）`;

  const rows = payload.chains.filter((c) => filter === 'all' || c.status === filter);
  $list.replaceChildren(...rows.map(renderCard));
  $empty.hidden = rows.length > 0;
  $empty.textContent = payload.chains.length ? '这个筛选下没有条目。' : '今天还没有记下任何事。';
}

async function load(scan = false) {
  $refresh.disabled = true;
  try {
    if (scan) {
      try { await ctx.call(TOOL_SCAN, {}); } catch { /* 扫描失败也让下面的读取继续 */ }
    }
    const raw = await ctx.call(TOOL_DATA, {});
    const data = parseToolContent(raw);
    if (data && data.error) { $sub.textContent = `读取失败：${data.error}`; return; }
    if (data && !data.error) payload = data;
  } catch (error) {
    $sub.textContent = `读取失败：${error?.message ?? error}`;
  } finally {
    $refresh.disabled = false;
    render();
  }
}

$tabs.addEventListener('click', (event) => {
  const btn = event.target.closest('button[data-filter]');
  if (!btn) return;
  filter = btn.dataset.filter;
  for (const tab of $tabs.querySelectorAll('button')) tab.classList.toggle('is-on', tab === btn);
  render();
});

$refresh.addEventListener('click', () => load(true));

let allTimer = 0;
const disarmAll = () => {
  allArmed = false;
  $closeAll.classList.remove('is-armed');
  const n = payload?.chains?.filter((c) => c.status === 'open').length ?? 0;
  $closeAll.textContent = `全部收尾（${n}）`;
};
$closeAll.addEventListener('click', async () => {
  if (!allArmed) {
    allArmed = true;
    $closeAll.classList.add('is-armed');
    $closeAll.textContent = '再点一次确认';
    allTimer = setTimeout(disarmAll, 3000);
    return;
  }
  clearTimeout(allTimer);
  $closeAll.disabled = true;
  $closeAll.textContent = '收尾中…';
  try {
    const raw = await ctx.call(TOOL_CLOSE, { all: true });
    const data = parseToolContent(raw);
    if (!data || data.error || data.ok === false) throw new Error(data?.error || '收尾失败');
    $closeAll.textContent = `已收尾 ${data.count || 0} 条`;
    $closeAll.disabled = false;
    allArmed = false;
    setTimeout(() => load(false), 600);
  } catch (error) {
    $closeAll.disabled = false;
    disarmAll();
    $sub.textContent = `全部收尾失败：${error?.message ?? error}`;
  }
});

function pollRefine() {
  clearInterval(pollTimer);
  let n = 0;
  pollTimer = setInterval(() => {
    if (document.hidden) return;
    load(false);
    n += 1;
    if (n >= 18) { clearInterval(pollTimer); pollTimer = 0; }
  }, 5000);
}

let refineAllTimer = 0;
const disarmRefineAll = () => {
  refineArmed = false;
  $refineAll.classList.remove('is-armed');
  const n = payload?.chains?.filter((c) => c.status === 'open').length ?? 0;
  $refineAll.textContent = `全部精修（${n}）`;
};
$refineAll.addEventListener('click', async () => {
  if (!refineArmed) {
    refineArmed = true;
    $refineAll.classList.add('is-armed');
    $refineAll.textContent = '确认全部精修？';
    refineAllTimer = setTimeout(disarmRefineAll, 3000);
    return;
  }
  clearTimeout(refineAllTimer);
  $refineAll.disabled = true;
  $refineAll.textContent = '精修排队中…';
  try {
    const raw = await ctx.call(TOOL_CLOSE, { all: true, refine: true });
    const data = parseToolContent(raw);
    if (!data || data.error || data.ok === false) throw new Error(data?.error || '精修收尾失败');
    $refineAll.textContent = `已排入精修 ${data.count || 0} 条`;
    $refineAll.disabled = false;
    refineArmed = false;
    pollRefine();
    setTimeout(() => load(false), 1200);
  } catch (error) {
    $refineAll.disabled = false;
    disarmRefineAll();
    $sub.textContent = `全部精修失败：${error?.message ?? error}`;
  }
});

// 面板打开先读一次，之后每 60 秒刷新；文档隐藏时停手。
load(false);
let timer = setInterval(() => { if (!document.hidden) load(false); }, 60000);
window.addEventListener('pagehide', () => { clearInterval(timer); clearInterval(pollTimer); });
