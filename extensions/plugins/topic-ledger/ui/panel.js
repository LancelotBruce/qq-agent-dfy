// 台账页：只调本插件自己的两个工具（取数 / 立即扫一次），不碰宿主其它接口。
import { ctx } from '/panels/panel-client.js';
import '/panels/theme.js';
import { installMotion } from '/panels/motion.js';

installMotion();

const TOOL_DATA = 'topic-ledger__panel_data';
const TOOL_SCAN = 'topic-ledger__scan_now';

const $label = document.querySelector('#label');
const $sub = document.querySelector('#sub');
const $list = document.querySelector('#list');
const $empty = document.querySelector('#empty');
const $refresh = document.querySelector('#refresh');
const $tabs = document.querySelector('#tabs');

let filter = 'all';
let payload = null;

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
  add('变更', chain.changes.map((c) => `${c.at} ${c.note}`).join('\n'));
  add('消息', `${chain.count} 条${chain.memoryWritten ? '｜已写进长期记忆' : ''}${chain.error ? '｜上次整理失败：' + chain.error : ''}`);
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

  const meta = el('div', 'chat', `${chain.chatLabel}｜${chain.count} 条消息${chain.drafted ? '' : '｜还未整理'}`);
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
  card.append(more, detail);
  return card;
}

function render() {
  if (!payload || !Array.isArray(payload.chains)) return;
  $label.textContent = `今日台账 · ${payload.label}`;
  const open = payload.chains.filter((c) => c.status === 'open').length;
  $sub.textContent = `账期从 ${new Date(payload.windowStart).toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit' })} 起｜事件链 ${payload.chains.length} 条（进行中 ${open}）｜今日整理调用 ${payload.budget?.calls ?? 0} 次`;

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

// 面板打开先读一次，之后每 60 秒刷新；文档隐藏时停手。
load(false);
let timer = setInterval(() => { if (!document.hidden) load(false); }, 60000);
window.addEventListener('pagehide', () => { clearInterval(timer); });
