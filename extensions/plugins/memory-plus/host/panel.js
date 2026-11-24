/* 记忆与存档优化 · 控制台界面（渲染进程侧）
 *
 * v2.1.0 —— 接管原有的「记忆」页（不新开页签），并补上三件使用体验上的事：
 *   ① **右上角常驻状态区**：任务进度 / 限流排队 / 最近一次操作结论（成功也报，不只报错）、
 *      专用模型开关，还有「刷新状态」按钮。每 2.5 秒自动刷新一次（只在记忆页轮询）。
 *   ② **留在原地**：任何改动之后重画都保持滚动位置与折叠状态，连着改十条也不用重新翻。
 *   ③ 批量压缩标签被限流时，任务会自动转入"每 30 秒一个人"的排队模式，
 *      状态区显示还剩几个、下一个几秒后、以及谁失败了（点开看原因）。
 *
 * 结构与类名尽量沿用核心那一套（.detail-header / .collapsible.mem-fold / .mem-who /
 * .mem-actions / .coll-body / .btn / .badge / .inp / .muted），字体与主题自动一致。
 * 改代码要改插件目录里的 host/panel.js（插件每次激活都会覆盖 ui/ 下的副本）。
 */
(function () {
  'use strict';

  var ACTION = '/api/skills/memory-plus/action/';
  var SNAP_URL = '/memory-plus-data.json';
  var FALLBACK_KINDS = {
    general: '一般观察', appointment: '约定/待办', preference: '偏好', fact: '事实', relation: '关系', correction: '纠正/雷区'
  };

  var S = {
    snapshot: null,
    cfg: null,
    providers: null,
    members: {},        // chatKey -> 核心成员数组（长期记忆）
    status: null,       // 最近一次 status 快照（状态区用它）
    archiveOpen: false,
    pollTimer: null,
    lastActive: false,
    installed: false,
    // 成员排序方式：count=按记忆条数（默认）、qq=按 QQ 号、name=按昵称。记住上次选择
    sortMode: (function () {
      try { return window.localStorage.getItem('mp-sort-mode') || 'count'; } catch (e) { return 'count'; }
    })(),
    // 交叉验证：勾选了哪几个人（chatKey -> {uid: true}），以及上一次报告里的疑点（chatKey -> issues[]）
    // 疑点只用来把条目**标红**提示，绝不自动改数据——用户自己进编辑弹窗改
    xcSel: {},
    xcIssues: {},
    // 「定位」跳到第几处了（chatKey -> 索引），再点就跳下一处
    xcLoc: {}
  };

  var lastRenderedChat = '';

  // ── 基础工具 ────────────────────────────────────────────────────────
  function q1(sel, root) { return (root || document).querySelector(sel); }
  function qa(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }
  function esc(s) {
    if (typeof window.esc === 'function') return window.esc(s);
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(ts) {
    var n = Number(ts) || 0;
    if (!n) return '—';
    if (typeof window.fmtTime === 'function') { try { return window.fmtTime(n); } catch (e) { /* 兜底 */ } }
    var d = new Date(n);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }
  function keyToPath(k) { return String(k || '').replace(':', '_'); }
  function chatTitle(k) {
    try {
      if (typeof window.formatChatTitle === 'function' && typeof window.chatNameOf === 'function') {
        return window.formatChatTitle(k, window.chatNameOf(k));
      }
    } catch (e) { /* 兜底 */ }
    return k;
  }
  function kindLabel(kind) {
    var map = (S.snapshot && S.snapshot.kindLabels) || FALLBACK_KINDS;
    return map[kind] || FALLBACK_KINDS[kind] || '一般观察';
  }
  function kindOption(v) { return kindLabel(v) + '（' + v + '）'; }
  function coreState() {
    try { return (typeof state !== 'undefined' && state) ? state : null; } catch (e) { return null; }
  }
  function currentChatKey() {
    var st = coreState();
    return (st && st.currentMemoryChatKey) || lastRenderedChat || '';
  }
  function errText(status, data, raw) {
    if (data && typeof data === 'object') {
      if (data.error) return String(data.error);
      if (data.hint) return String(data.hint);
      try { return JSON.stringify(data).slice(0, 300); } catch (e) { /* ignore */ }
    }
    return (raw ? String(raw).slice(0, 300) : ('HTTP ' + status));
  }

  async function act(key, body) {
    var r = await fetch(ACTION + encodeURIComponent(key), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {})
    });
    var text = '';
    try { text = await r.text(); } catch (e) { text = ''; }
    var data = null;
    try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
    if (r.status === 404) {
      throw new Error('动作路由不可用（HTTP 404）：这台机器上「插件动作路由」的补丁可能被应用更新覆盖了。'
        + '重跑一次安装根目录的 data\\apply-module-manager-fix.mjs 再刷新本页即可；长期记忆的增删改不受影响。');
    }
    if (!r.ok || (data && data.ok === false)) throw new Error(errText(r.status, data, text));
    return data || {};
  }

  async function core(pathname, opts) {
    if (typeof window.api === 'function') return window.api(pathname, opts);
    var r = await fetch(pathname, opts);
    var data = null;
    try { data = await r.json(); } catch (e) { data = null; }
    if (!r.ok) throw new Error(errText(r.status, data, ''));
    return data;
  }
  function confirmBox(msg) {
    if (typeof window.uiConfirm === 'function') return window.uiConfirm(msg);
    return Promise.resolve(window.confirm(msg));
  }

  // ── 视图位置保持（"改一条想连续操作"的关键）────────────────────────
  function captureView() {
    var detail = q1('#memory-detail');
    var collapsed = {};
    qa('.mem-fold[data-uid]', detail || document).forEach(function (el) {
      if (!el.open) collapsed[el.getAttribute('data-uid')] = true;
    });
    return {
      top: detail ? detail.scrollTop : 0,
      win: (window.scrollY || window.pageYOffset || 0),
      collapsed: collapsed
    };
  }
  function restoreView(v) {
    if (!v) return;
    var apply = function () {
      var detail = q1('#memory-detail');
      if (detail) {
        qa('.mem-fold[data-uid]', detail).forEach(function (el) {
          if (v.collapsed[el.getAttribute('data-uid')]) el.open = false;
          var fb = el.querySelector('[data-mp="fold-toggle"]');
          if (fb) fb.textContent = el.open ? '▾' : '▸';
        });
        detail.scrollTop = v.top;
      }
      try { window.scrollTo(0, v.win); } catch (e) { /* ignore */ }
    };
    apply();
    try { window.requestAnimationFrame(apply); } catch (e) { /* ignore */ }
    setTimeout(apply, 60);
    setTimeout(apply, 200);
  }
  /** 跑一段会改 DOM 的代码，前后自动保位置。 */
  async function keepingView(fn) {
    var v = captureView();
    var r = await fn();
    restoreView(v);
    return r;
  }

  // ── 数据 ────────────────────────────────────────────────────────────
  async function loadSnapshot() {
    var r = await fetch(SNAP_URL + '?t=' + Date.now(), { cache: 'no-store' });
    S.snapshot = await r.json();
    return S.snapshot;
  }
  function snapChat(chatKey) {
    var chats = (S.snapshot && S.snapshot.chats) || [];
    for (var i = 0; i < chats.length; i += 1) if (chats[i].chatKey === chatKey) return chats[i];
    return null;
  }
  function snapMember(chatKey, uid) {
    var sc = snapChat(chatKey);
    return ((sc && sc.members) || []).filter(function (m) { return String(m.userId) === String(uid); })[0] || null;
  }
  function metaFor(chatKey, content) {
    var sc = snapChat(chatKey);
    var list = (sc && sc.meta) || [];
    for (var i = 0; i < list.length; i += 1) if (list[i].content === content) return list[i];
    return null;
  }
  function coreMember(chatKey, uid) {
    return (S.members[chatKey] || []).filter(function (m) { return String(m.userId) === String(uid); })[0] || null;
  }
  async function loadCoreMembers(chatKey) {
    try {
      var r = await core('/api/memory-files/' + keyToPath(chatKey));
      S.members[chatKey] = (r && r.members) || [];
    } catch (e) {
      S.members[chatKey] = S.members[chatKey] || [];
    }
    return S.members[chatKey];
  }
  async function loadCfg() {
    if (S.cfg) return S.cfg;
    try { S.cfg = await core('/api/config'); } catch (e) { S.cfg = {}; }
    return S.cfg;
  }
  async function loadProviders() {
    if (S.providers) return S.providers;
    try {
      var r = await core('/api/providers');
      S.providers = (r && r.providers) || [];
    } catch (e) { S.providers = []; }
    return S.providers;
  }
  function noteOf(userId) {
    var st = coreState();
    var notes = (S.cfg && S.cfg.memberNotes) || (st && st.config && st.config.memberNotes) || {};
    return notes[String(userId)] || '';
  }
  function nameOf(chatKey, uid) {
    var cm = coreMember(chatKey, uid);
    var sm = snapMember(chatKey, uid);
    // 顺序：手工备注 > 插件快照（点「拉取群成员列表」时会刷成最新群名片）> 核心记忆里的 name > QQ 号。
    // 核心那份 name 往往是建档那天的旧昵称，甚至被写成字符串 "undefined"，不能压在新昵称上面。
    var snapName = (sm && sm.name && String(sm.name) !== String(uid)) ? String(sm.name) : '';
    var coreName = (cm && cm.name && String(cm.name) !== 'undefined' && String(cm.name) !== String(uid)) ? String(cm.name) : '';
    return noteOf(uid) || snapName || coreName || String(uid);
  }

  // ── 交叉验证（独立工具，不在右栏工具栏里）──────────────────────────
  // 流程：勾几位群友 → 点「交叉验证」→ 只核对这几个人之间的问题 → 有问题的条目**标红**。
  // 一律不改数据：跑完只是把疑点标出来，用户自己进编辑弹窗改。
  function xcSelCount(chatKey) {
    var sel = S.xcSel[chatKey] || {};
    return Object.keys(sel).filter(function (k) { return !!sel[k]; }).length;
  }
  function xcIssuesOf(chatKey) { return (S.xcIssues && S.xcIssues[chatKey]) || []; }
  /** 比对用的归一化：去掉标点与空白，只留字。 */
  function cmpNorm(s) {
    return String(s || '').replace(/[\s，。、！？“”"'：:；;（）()·—\-…]/g, '');
  }
  /** 疑点里"另一条"记忆的原文（detail 冒号后面那段）。 */
  function xcOtherOf(iss) {
    var d = String(iss.detail || '');
    var i = d.indexOf('：');
    return i >= 0 ? d.slice(i + 1).trim() : '';
  }
  /**
   * 这条记忆命中了哪条疑点。
   * 命中的可能是疑点本身那句（content），也可能是它指出的对立面那句（other）——
   * 两条都标红，用户才看得出"这两条打架"。
   */
  function xcHitOf(chatKey, content) {
    var list = xcIssuesOf(chatKey);
    var n = cmpNorm(content);
    if (!n || !list.length) return null;
    for (var i = 0; i < list.length; i += 1) {
      var it = list[i];
      var pairs = [[it.content, 'main'], [xcOtherOf(it), 'other']];
      for (var j = 0; j < pairs.length; j += 1) {
        var tn = cmpNorm(pairs[j][0]);
        if (!tn) continue;
        if (n === tn) return { issue: it, role: pairs[j][1] };
        // 写盘时原句被 trimText 截到 200 字，比长度没意义，比开头 20 个字最稳
        var h = Math.min(20, n.length, tn.length);
        if (h >= 8 && n.slice(0, h) === tn.slice(0, h)) return { issue: it, role: pairs[j][1] };
      }
    }
    return null;
  }
  var XC_TYPE_CN = { conflict: '两处说法矛盾', attribution: '主语不是本人', duplicate: '同一件事重复记' };

  /** 标红条目里那行小字：说你这条跟谁、哪条打架。 */
  function xcTipHtml(hit) {
    var it = hit.issue || {};
    var hint = XC_TYPE_CN[it.type] || '有问题';
    var body = hit.role === 'other'
      ? ('另有说法与这条打架：' + (it.content || ''))
      : (it.detail || '');
    return '<span class="mp-bad-tip">⚠ ' + esc(hint) + '　' + esc(body) + '</span>';
  }

  function xcBarHtml(chatKey) {
    var n = xcSelCount(chatKey);
    var bad = xcIssuesOf(chatKey).length;
    return [
      '<div class="mp-xcbar" id="mp-xcbar">',
      '  <span class="mp-xc-count" id="mp-xc-count">',
      n ? ('已选 <b>' + n + '</b> 人，只核对这几个人') : '勾选成员块标题左侧的「选人」方框，勾满 2 人后点交叉验证',
      '  </span>',
      '  <button class="btn btn-small" data-mp="xc-run"' + (n < 2 ? ' disabled' : '')
        + ' title="只把勾选的这几个人的记忆放在一起核对：同一个人长期和短期有没有重复、彼此之间说法有没有矛盾。只标红，一条记忆都不会改">交叉验证</button>',
      '  <button class="btn btn-small" data-mp="xc-clear"' + (n ? '' : ' disabled') + '>清空选择</button>',
      '  <button class="btn btn-small" data-mp="xc-refresh" title="重新读一次交叉验证报告，并按当前记忆内容重新标红：手动改过一条之后点它，红框就会按最新内容对齐（不改任何记忆）">刷新</button>',
      bad ? ('  <button class="btn btn-small" data-mp="xc-locate" title="跳到下一处标红的记忆：会自动展开它所在的成员块并滚到屏幕中间，闪三下方便看清（多处时再点就跳下一处）">'
        + (bad > 1 ? '定位下一处' : '定位') + '</button>') : '',
      bad ? ('  <span class="mp-xc-bad">上次查出 <b>' + bad + '</b> 处疑点，下面红框标出来的请手动改</span>') : '',
      '</div>'
    ].join('\n');
  }
  /** 只改文字与禁用态，不重建节点——按钮的 click 绑定才不会丢。 */
  function updateXcBar(chatKey) {
    var bar = q1('#mp-xcbar');
    if (!bar) return;
    var n = xcSelCount(chatKey);
    var cnt = q1('#mp-xc-count', bar);
    if (cnt) {
      cnt.innerHTML = n
        ? ('已选 <b>' + n + '</b> 人，只核对这几个人')
        : '勾选成员块标题左侧的「选人」方框，勾满 2 人后点交叉验证';
    }
    var run = q1('[data-mp="xc-run"]', bar);
    if (run) run.disabled = n < 2;
    var clr = q1('[data-mp="xc-clear"]', bar);
    if (clr) clr.disabled = n < 1;
  }
  /** 读回上一次的报告：刷新界面后疑点仍要标红，不能跑完一刷新就全没了。 */
  async function loadXcReport(chatKey) {
    try {
      var r = await act('xc-report', { chatKey: chatKey });
      S.xcIssues[chatKey] = (r && r.issues) || [];
    } catch (e) {
      S.xcIssues[chatKey] = [];
    }
  }

  // ── 一、右侧常驻状态区 ──────────────────────────────────────────────
  /** 操作区：以前横排在标题下面，占了好几行、把页面撑得很空；现在整块竖排到右栏最上面。 */
  function opsBarHtml() {
    return [
      '<div class="mp-ops">',
      '  <div class="mp-ops-t">操作</div>',
      '  <select class="inp mp-sel" id="mp-sort" title="换一种排列方式">',
      '    <option value="count">按记忆条数（多→少）</option>',
      '    <option value="qq">按 QQ 号（小→大）</option>',
      '    <option value="name">按昵称</option>',
      '  </select>',
      '  <select class="inp mp-sel" id="mp-scope" title="整理时回看哪一段聊天记录（只影响「整理本记忆」里的提取那一步）">',
      '    <option value="1">整理范围：今天</option>',
      '    <option value="3">整理范围：最近 3 天</option>',
      '    <option value="7">整理范围：最近 7 天</option>',
      '  </select>',
      '  <button class="btn btn-small" data-mp="add-member">＋ 添加记忆</button>',
      '  <button class="btn btn-small" data-mp="consolidate">整理本记忆</button>',
      '  <button class="btn btn-small" data-mp="extract-now" title="立刻让模型回看聊天记录、把新的稳定信息记成短期记忆（平时每 3 小时自动做一次）">立刻提取新记忆</button>',
      '  <button class="btn btn-small" data-mp="core-consolidate">合并去重</button>',
      '  <button class="btn btn-small" data-mp="queue-start" title="一次一个人、间隔 30 秒地重新压缩所有人的标签（限流时的稳妥做法）">全部重压标签</button>',
      '  <button class="btn btn-small" data-mp="queue-clear" title="停掉正在排队的标签任务">停止排队</button>',
      '  <button class="btn btn-small" data-mp="expire">清理过期短期</button>',
      '  <button class="btn btn-small" data-mp="rescan" title="重新加载全部扩展。装了新插件时才需要点；重载期间其它扩展会有一两秒不可用（比如好感度插件），这是宿主的热重载窗口">重新扫描</button>',
      '</div>'
    ].join('\n');
  }

  function statusBarHtml() {
    return [
      '<div class="mp-side" id="mp-statusbar">',
      opsBarHtml(),
      '  <div class="mp-side-row">',
      '    <span class="mp-dot" id="mp-dot"></span>',
      '    <span class="mp-status-text" id="mp-status-text">就绪</span>',
      '    <button class="btn btn-small" data-mp="refresh-status" title="立刻重新读一次任务进度与记忆数据（不会跳回顶部）">刷新状态</button>',
      '  </div>',
      '  <div class="mp-progress"><i id="mp-bar"></i></div>',
      '  <div class="mp-side-model">',
      '    <span class="muted" style="font-size:12px">整理用模型</span>',
      '    <select class="inp mp-sel" id="mp-provider-sel" title="选一个渠道专门用来压缩标签/判定晋升"><option value="">跟随主模型</option></select>',
      '    <select class="inp mp-sel" id="mp-model-sel"><option value="">（先选渠道）</option></select>',
      '    <button class="btn btn-small" data-mp="save-model">保存</button>',
      '  </div>',
      '  <div class="mp-side-model">',
      '    <span class="muted" style="font-size:12px">交叉验证模型</span>',
      '    <select class="inp mp-sel" id="mp-xc-provider-sel" title="交叉验证要多批次跑、判定也重，这里单独给它一个快模型，就不会和整理抢额度"><option value="">跟随整理模型</option></select>',
      '    <select class="inp mp-sel" id="mp-xc-model-sel"><option value="">（先选渠道）</option></select>',
      '    <button class="btn btn-small" data-mp="save-xc-model">保存</button>',
      '  </div>',
      '  <div class="mp-side-hint muted" id="mp-model-hint"></div>',
      '  <div class="mp-side-hint muted" id="mp-xc-hint"></div>',
      '  <div class="mp-side-hint muted" id="mp-switch-hint"></div>',
      '  <div class="mp-side-fail" id="mp-fail-list"></div>',
      '</div>'
    ].join('\n');
  }

  function renderStatus() {
    var st = S.status || {};
    var dot = q1('#mp-dot');
    var text = q1('#mp-status-text');
    var bar = q1('#mp-bar');
    if (!dot) return;
    var job = st.job || null;
    var q = st.queue || { active: false, remaining: 0, done: 0, failed: [] };
    var last = st.last || null;
    var running = !!st.running;
    var queueing = !!(q.remaining > 0);

    var cls = 'mp-dot';
    var msg = '就绪';
    var pct = 0;
    if (running) {
      cls += ' mp-dot-run';
      msg = '整理中：' + ((job && job.label) || '准备中');
      if (job && job.total) { msg += '（' + job.step + '/' + job.total + '）'; pct = Math.round(100 * job.step / job.total); }
    } else if (queueing) {
      cls += ' mp-dot-queue';
      msg = '限流排队中：还剩 ' + q.remaining + ' 个人，下一个 ' + (q.nextInSec > 0 ? q.nextInSec + ' 秒后' : '马上')
        + '（已完成 ' + q.done + (q.failed && q.failed.length ? '，失败 ' + q.failed.length : '') + '）';
      pct = q.total ? Math.round(100 * q.done / q.total) : 0;
    } else if (last && last.ok === false) {
      cls += ' mp-dot-err';
      msg = '上次操作失败：' + String(last.text || '').slice(0, 160);
    } else if (last && last.text) {
      cls += ' mp-dot-ok';
      msg = '上次操作：' + String(last.text).slice(0, 160);
    }
    dot.className = cls;
    if (text) text.textContent = msg;
    if (bar) {
      bar.style.width = (running || queueing) ? Math.max(3, pct) + '%' : '0%';
      bar.className = (running || queueing) ? 'on' : '';
    }

    var box = q1('#mp-fail-list');
    if (box) {
      var fails = (q.failed || []).slice(0, 12);
      if (!fails.length) box.innerHTML = '';
      else {
        box.innerHTML = '<details class="mp-fail"><summary>有 ' + q.failed.length + ' 个人没成功，点开看是谁、为什么</summary>'
          + fails.map(function (f) {
            return '<div class="mp-fail-item">· ' + esc(nameOf(st.chatKey || '', f.userId)) + '：' + esc(f.error || '未知原因') + '</div>';
          }).join('')
          + '</details>';
      }
    }

    var hint = q1('#mp-model-hint');
    var m = st.model || {};
    if (hint) {
      if (m.error) hint.textContent = '⚠ ' + m.error;
      else if (m.dedicated) hint.textContent = '生效中：专用渠道 ' + (m.provider || '') + ' / 模型 ' + (m.model || '');
      else hint.textContent = '当前跟随主模型（想单独指定就选渠道+模型再保存）';
      hint.style.color = m.error ? 'var(--err)' : '';
    }
    var xcHint = q1('#mp-xc-hint');
    if (xcHint) {
      if (m.xcError) xcHint.textContent = '⚠ 交叉验证模型：' + m.xcError;
      else if (m.xcProvider || m.xcModel) xcHint.textContent = '交叉验证生效中：' + (m.xcProvider || '（跟随）') + ' / ' + (m.xcModel || '（跟随）');
      else xcHint.textContent = '交叉验证当前跟随上面的整理模型（想单独指定就选渠道+模型再保存）';
      xcHint.style.color = m.xcError ? 'var(--err)' : '';
    }
    fillModelSelects(m);
    fillXcSelects(m);
    renderSwitchHint(st);
  }

  /** 开关摘要 + 最近一次提示词裁剪情况（一眼看出哪些功能被关了、省了多少）。 */
  function renderSwitchHint(st) {
    var box = q1('#mp-switch-hint');
    if (!box) return;
    var sw = st.switches;
    var lim = st.limits || {};
    var tr = st.trim || {};
    var bits = [];
    if (sw) {
      var onNames = [];
      if (sw.memory) onNames.push('两层记忆');
      if (sw.shortTerm) onNames.push('短期记忆');
      if (sw.labelFirst) onNames.push('标签优先');
      if (sw.archiveTools) onNames.push('记录检索');
      if (sw.historyTrim) onNames.push('记录裁剪×' + (lim.historyLimit || 0));
      if (sw.systemTrim) onNames.push('段落裁剪');
      if (sw.toolGuard) onNames.push('工具护栏' + (lim.blockedTools && lim.blockedTools.length ? '（拦 ' + lim.blockedTools.join('/') + '）' : ''));
      if (sw.toolCap) onNames.push('结果截断×' + (lim.toolResultMaxChars || 0)
        + (lim.capOnlyTools && lim.capOnlyTools.length ? '（只截 ' + lim.capOnlyTools.join('/') + '）' : '（全部工具）'));
      var offNames = [];
      if (!sw.memory) offNames.push('两层记忆');
      if (!sw.shortTerm) offNames.push('短期记忆');
      if (!sw.labelFirst) offNames.push('标签优先');
      if (!sw.archiveTools) offNames.push('记录检索');
      if (!sw.historyTrim) offNames.push('记录裁剪');
      if (!sw.systemTrim) offNames.push('段落裁剪');
      if (!sw.toolGuard) offNames.push('工具护栏');
      if (!sw.toolCap) offNames.push('结果截断');
      bits.push('已开：' + (onNames.join('、') || '（无）'));
      if (offNames.length) bits.push('已关：' + offNames.join('、'));
    }
    if (tr.at) {
      var when = new Date(Number(tr.at));
      var p2 = function (n) { return String(n).padStart(2, '0'); };
      var stamp = p2(when.getHours()) + ':' + p2(when.getMinutes());
      bits.push('上次裁剪 ' + stamp + '：记录少带 ' + (tr.history || 0) + ' 条'
        + ((tr.sections && tr.sections.length) ? '，裁掉段落 ' + tr.sections.join('、') : ''));
    }
    // 实发内容摘要：控制台「会话」页显示的是核心原文（钩子之前），这里给的是**真正发出去**的
    var se = st.sent || {};
    if (se.at) {
      var mem = se.memory || {};
      var memTxt = mem.members
        ? ('记忆段：' + mem.members + ' 人' + (mem.labelOnly ? '（其中 ' + mem.labelOnly + ' 人走标签档）' : '（全文档）'))
        : '记忆段：未替换（核心原文）';
      var histTxt = se.historyCut
        ? ('已读信息：' + se.historyKept + ' 条（省掉 ' + se.historyCut + ' 条）')
        : '已读信息：未裁剪';
      bits.push('📤 上轮实发 ' + (se.total || 0) + ' 字 ｜ ' + memTxt + ' ｜ ' + histTxt
        + ((se.sections && se.sections.length) ? ' ｜ 裁段 ' + se.sections.join('、') : ''));
    }
    bits.push('其它开关在「插件 → 记忆与存档优化 → 设置」里');
    box.textContent = bits.join('\n');
    box.style.whiteSpace = 'pre-line';
    box.style.color = '';
  }

  function fillModelSelects(m) {
    var sel = q1('#mp-provider-sel');
    var msel = q1('#mp-model-sel');
    if (!sel || !msel) return;
    var providers = S.providers || [];
    if (sel.getAttribute('data-filled') !== '1') {
      sel.innerHTML = '<option value="">跟随主模型</option>'
        + providers.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.displayName || p.id) + '</option>';
        }).join('');
      sel.setAttribute('data-filled', '1');
      sel.addEventListener('change', function () { fillModelOptions(sel.value, ''); });
    }
    if (document.activeElement !== sel && sel.value !== (m.provider || '')) sel.value = m.provider || '';
    fillModelOptions(sel.value, m.model || '');
  }

  function fillModelOptions(providerId, keepModel) {
    var msel = q1('#mp-model-sel');
    if (!msel) return;
    var p = (S.providers || []).filter(function (x) { return String(x.id) === String(providerId); })[0];
    if (!p) { msel.innerHTML = '<option value="">跟随主模型</option>'; msel.value = ''; return; }
    var models = Array.isArray(p.models) ? p.models : [];
    var names = p.modelNames || {};
    var html = '<option value="">（这个渠道的模型）</option>'
      + models.map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(names[id] || id) + '</option>';
      }).join('');
    var target = String(keepModel || '');
    if (target && models.indexOf(target) < 0) {
      // 当前配置里的模型不在这个渠道的列表里，也保留一项，免得被静默改掉
      html += '<option value="' + esc(target) + '">' + esc(target) + '（当前配置）</option>';
    }
    msel.innerHTML = html;
    if (document.activeElement !== msel) msel.value = target;
  }

  /** 交叉验证那一组下拉：和整理用模型是同构的，只是读写的是 crossCheckProvider/Model。 */
  function fillXcSelects(m) {
    var sel = q1('#mp-xc-provider-sel');
    if (!sel) return;
    var providers = S.providers || [];
    if (sel.getAttribute('data-filled') !== '1') {
      sel.innerHTML = '<option value="">跟随整理模型</option>'
        + providers.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(p.displayName || p.id) + '</option>';
        }).join('');
      sel.setAttribute('data-filled', '1');
      sel.addEventListener('change', function () { fillXcModelOptions(sel.value, ''); });
    }
    if (document.activeElement !== sel && sel.value !== (m.xcProvider || '')) sel.value = m.xcProvider || '';
    fillXcModelOptions(sel.value, m.xcModel || '');
  }

  function fillXcModelOptions(providerId, keepModel) {
    var msel = q1('#mp-xc-model-sel');
    if (!msel) return;
    if (!String(providerId || '')) {
      msel.innerHTML = '<option value="">跟随整理模型</option>';
      msel.value = '';
      return;
    }
    var p = (S.providers || []).filter(function (x) { return String(x.id) === String(providerId); })[0];
    if (!p) { msel.innerHTML = '<option value="">（先选渠道）</option>'; msel.value = ''; return; }
    var models = Array.isArray(p.models) ? p.models : [];
    var names = p.modelNames || {};
    var html = '<option value="">（这个渠道的模型）</option>'
      + models.map(function (id) {
        return '<option value="' + esc(id) + '">' + esc(names[id] || id) + '</option>';
      }).join('');
    var target = String(keepModel || '');
    if (target && models.indexOf(target) < 0) {
      html += '<option value="' + esc(target) + '">' + esc(target) + '（当前配置）</option>';
    }
    msel.innerHTML = html;
    if (document.activeElement !== msel) msel.value = target;
  }

  async function saveXcModel() {
    var sel = q1('#mp-xc-provider-sel');
    var msel = q1('#mp-xc-model-sel');
    var provider = String((sel && sel.value) || '');
    var model = String((msel && msel.value) || '');
    try {
      await core('/api/skills/memory-plus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { crossCheckProvider: provider, crossCheckModel: model } })
      });
      await pollStatus(true);
      appendLocalNote(provider && model ? ('交叉验证模型已保存：' + provider + ' / ' + model) : '交叉验证已改为跟随整理模型');
    } catch (e) {
      appendLocalNote('保存失败：' + e.message, true);
    }
  }

  async function saveModel() {
    var sel = q1('#mp-provider-sel');
    var msel = q1('#mp-model-sel');
    var provider = String((sel && sel.value) || '');
    var model = String((msel && msel.value) || '');
    try {
      await core('/api/skills/memory-plus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ settings: { modelProvider: provider, modelName: model } })
      });
      await pollStatus(true);
      appendLocalNote(provider && model ? ('专用模型已保存：' + provider + ' / ' + model) : '已改为跟随主模型');
    } catch (e) {
      appendLocalNote('保存失败：' + e.message, true);
    }
  }

  /** 状态区直接改写一句话（比如"已删除 3 条"），不用等下一轮轮询。 */
  function appendLocalNote(text, isErr) {
    var el = q1('#mp-status-text');
    if (el) {
      el.textContent = String(text).slice(0, 220);
      var dot = q1('#mp-dot');
      if (dot) dot.className = 'mp-dot ' + (isErr ? 'mp-dot-err' : 'mp-dot-ok');
    }
    if (isErr) {
      var box = q1('#mp-fail-list');
      if (box) box.innerHTML = '<div class="mp-fail-item">' + esc(text) + '</div>';
    }
  }
  function setStatus(text, isErr) { appendLocalNote(text, isErr); }

  // ── 二、状态轮询（进度常驻显示）──────────────────────────────────────
  async function pollStatus(force) {
    var st = coreState();
    if (!force && st && st.tab !== 'memory') return null;
    var key = currentChatKey();
    try {
      var r = await act('status', { chatKey: key });
      var wasActive = S.lastActive;
      S.status = r;
      S.lastActive = !!(r.running || (r.queue && r.queue.active));
      renderStatus();
      if (wasActive && !S.lastActive) {
        // 任务刚跑完 → 数据可能变了，刷新一次并留在原地
        await refreshAll();
        try {
          var r2 = await act('status', { chatKey: key });
          S.status = r2;
          renderStatus();
        } catch (e) { /* ignore */ }
      }
      return r;
    } catch (e) {
      return null;
    }
  }

  function startPoll() {
    if (S.pollTimer) return;
    S.pollTimer = setInterval(function () {
      var st = coreState();
      if (!st || st.tab !== 'memory') return;   // 只在记忆页轮询
      pollStatus(false);
    }, 2500);
  }

  // ── 三、整页刷新（保持位置）─────────────────────────────────────────
  async function refreshAll() {
    var chatKey = currentChatKey();
    if (!chatKey) return;
    await keepingView(async function () {
      await loadSnapshot();
      await loadCoreMembers(chatKey);
      await loadProviders();
      await renderDetail(chatKey);
    });
  }

  // ── 四、渲染详情 ────────────────────────────────────────────────────
  function memberBlock(chatKey, uid, cm, sm) {
    var who = nameOf(chatKey, uid);
    var longList = (cm && cm.impressions) || [];
    var shortList = (sm && sm.short) || [];
    var labels = (sm && sm.labels) || [];
    var head = [
      '<details class="collapsible mem-fold" open data-uid="' + esc(uid) + '">',
      '  <summary>',
      '    <button class="mp-fold-btn" data-mp="fold-toggle" title="收起 / 展开这个人的记忆">▾</button>',
      '    <button type="button" class="mp-who-pick' + ((S.xcSel[chatKey] && S.xcSel[chatKey][uid]) ? ' mp-on' : '') + '" data-mp="pick-member" data-uid="' + esc(uid) + '" title="勾选这个人，只让他参与交叉验证（和下面每条的勾选框是两回事）"><span class="mp-whobox"></span>选人</button>',
      '    <span class="mem-who">' + esc(who) + ' <span class="muted">(QQ ' + esc(uid) + ')</span>',
      '      （长期 ' + longList.length + ' · 短期 ' + shortList.length + '）</span>',
      '    <span class="mem-actions">',
      '      <label class="mp-all-wrap" title="勾上就全选这个人的条目"><input type="checkbox" class="mp-pick" data-mp="pick-all" />全选</label>',
      '      <button class="btn btn-small btn-danger" data-mp="bulk-del" title="删掉上面勾选的条目（长期和短期都可以）">删除选中</button>',
      '      <button class="btn btn-small" data-mp="bulk-promote" title="把勾选的短期记忆提升为长期记忆">晋升选中</button>',
      '      <button class="btn btn-small" data-mp="edit-all">编辑</button>',
      '      <button class="btn btn-small" data-mp="refresh">更新记忆</button>',
      '      <button class="btn btn-small" data-mp="tags">压缩标签</button>',
      '    </span>',
      '  </summary>',
      '  <div class="coll-body">'
    ].join('\n');
    var body = [];

    body.push('<div class="mp-row"><span class="mp-row-k">标签</span><span class="mp-tags">');
    if (!labels.length) body.push('<span class="muted" style="font-size:12px">还没有标签（点「压缩标签」让模型生成，或手工加）</span>');
    labels.forEach(function (l) {
      body.push('<span class="badge' + (l.pinned ? ' ok' : '') + '">' + esc(l.tag)
        + '<span class="mp-x" data-mp="tag-del" data-tag="' + esc(l.tag) + '" title="删除标签">×</span></span>');
    });
    body.push('<input class="inp mp-tag-in" data-mp="tag-in" placeholder="加标签" size="6" />');
    body.push('<button class="btn btn-small" data-mp="tag-add">加</button>');
    body.push('</span></div>');

    body.push('<div class="mp-sec">长期记忆 · 稳定，可以直接引用（' + longList.length + ' 条，勾选后可在右上角删除）</div>');
    if (!longList.length) body.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有长期记忆</div>');
    longList.forEach(function (it, idx) {
      var meta = metaFor(chatKey, it.content) || {};
      var appt = meta.kind === 'appointment';
      var hits = Number(meta.hits) || 0;
      var xc = xcHitOf(chatKey, it.content);
      body.push('<div class="mp-line' + (xc ? ' mp-bad' : '') + '" data-long-idx="' + idx + '">');
      body.push('<input type="checkbox" class="mp-pick" data-mp="pick" data-kind="long" data-idx="' + idx + '" title="勾选这一条" />');
      body.push('<span class="mp-line-t">');
      if (appt) body.push('<span class="badge" style="color:var(--warn);border-color:var(--warn-line)">约定·原文</span> ');
      body.push(esc(it.content));
      if (hits > 0) body.push(' <span class="muted" style="font-size:11px">提及×' + hits + '</span>');
      if (meta.reason) body.push(' <span class="muted" style="font-size:11px" title="晋升理由">· ' + esc(meta.reason) + '</span>');
      if (xc) body.push(xcTipHtml(xc));
      body.push('</span>');
      body.push('<span class="mp-line-a">');
      body.push('<button class="btn btn-small" data-mp="long-edit" data-idx="' + idx + '">改</button>');
      body.push('</span></div>');
    });

    body.push('<div class="mp-sec">短期记忆 · 最近才形成，会过期（' + shortList.length + ' 条，勾选后可晋升或删除）</div>');
    if (!shortList.length) body.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有短期记忆</div>');
    shortList.slice().sort(function (a, b) { return (Number(b.hits) || 0) - (Number(a.hits) || 0); }).forEach(function (s) {
      var hits = Math.max(0, Number(s.hits) || 0);
      var appt = s.kind === 'appointment';
      var left = '';
      try {
        var ttl = (S.snapshot && S.snapshot.settings && S.snapshot.settings.shortTtlDays) || 14;
        left = Math.max(0, Math.ceil((Number(s.createdAt) + ttl * 86400000 - Date.now()) / 86400000)) + ' 天后过期';
      } catch (e) { /* 不影响展示 */ }
      var xc = xcHitOf(chatKey, s.content);
      body.push('<div class="mp-line' + (xc ? ' mp-bad' : '') + '" data-short-id="' + esc(s.id) + '">');
      body.push('<input type="checkbox" class="mp-pick" data-mp="pick" data-kind="short" data-short-id="' + esc(s.id) + '" title="勾选这一条" />');
      body.push('<span class="mp-line-t">');
      if (appt) body.push('<span class="badge" style="color:var(--warn);border-color:var(--warn-line)">约定</span> ');
      body.push(esc(s.content));
      body.push(' <span class="muted" style="font-size:11px">' + esc(kindLabel(s.kind))
        + (hits > 0 ? '，提及×' + hits : '') + (left ? '，' + left : '') + '</span>');
      if (xc) body.push(xcTipHtml(xc));
      body.push('</span></div>');
    });

    body.push('<div class="mp-row mp-add-row">');
    body.push('<input class="inp mp-add-in" data-mp="add-in" placeholder="记一条短期记忆…（回车也可）" />');
    body.push('<select class="inp mp-add-kind" data-mp="add-kind">');
    ['general', 'appointment', 'preference', 'fact', 'relation', 'correction'].forEach(function (k) {
      body.push('<option value="' + k + '">' + esc(kindOption(k)) + '</option>');
    });
    body.push('</select>');
    body.push('<button class="btn btn-small" data-mp="add-save">记下</button>');
    body.push('</div>');

    return head + body.join('') + '</div></details>';
  }

  function archiveBlock(chatKey) {
    var ov = ((S.snapshot && S.snapshot.archive && S.snapshot.archive.overview) || [])
      .filter(function (o) { return o.chatKey === chatKey; })[0];
    var sweep = (S.snapshot && S.snapshot.archive && S.snapshot.archive.sweep) || {};
    var thisYear = new Date().getFullYear();
    var years = [];
    for (var y = thisYear; y >= thisYear - 6; y -= 1) years.push(y);
    var daySel = function (name) {
      var out = ['<select class="inp mp-date" data-mp="' + name + '-y"><option value="">年</option>'];
      years.forEach(function (yy) { out.push('<option value="' + yy + '">' + yy + '</option>'); });
      out.push('</select><select class="inp mp-date" data-mp="' + name + '-m"><option value="">月</option>');
      for (var m = 1; m <= 12; m += 1) out.push('<option value="' + m + '">' + m + ' 月</option>');
      out.push('</select><select class="inp mp-date" data-mp="' + name + '-d"><option value="">日</option>');
      for (var d = 1; d <= 31; d += 1) out.push('<option value="' + d + '">' + d + ' 日</option>');
      out.push('</select>');
      return out.join('');
    };
    return [
      '<details class="collapsible mem-fold mp-archive"', S.archiveOpen ? ' open' : '', '>',
      '  <summary><span class="mem-who">聊天记录存档',
      ov ? '（' + ov.count + ' 条，' + (ov.bytes / 1024).toFixed(0) + ' KB，' + esc(ov.firstAt || '—') + ' ~ ' + esc(ov.lastAt || '—') + '）' : '（这个会话还没有本地存档）',
      '</span><span class="mem-actions"><span class="muted" style="font-size:11px">上次自动清理 ' + esc(sweep.lastSweepAt ? fmt(sweep.lastSweepAt) : '从未') + '</span></span></summary>',
      '  <div class="coll-body">',
      '    <div class="mp-row"><span class="mp-row-k">快删</span>',
      '      <button class="btn btn-small" data-mp="quick" data-days="7">删 7 天前</button>',
      '      <button class="btn btn-small" data-mp="quick" data-days="30">删 30 天前</button>',
      '      <button class="btn btn-small" data-mp="quick" data-days="90">删 90 天前</button>',
      '      <button class="btn btn-small" data-mp="quick" data-days="180">删半年之前</button>',
      '      <button class="btn btn-small btn-danger" data-mp="quick" data-days="0">全删</button>',
      '    </div>',
      '    <div class="mp-row"><span class="mp-row-k">自选</span> 从 ', daySel('from'), ' 到 ', daySel('to'),
      '      <button class="btn btn-small" data-mp="preview">看看命中几条</button>',
      '      <button class="btn btn-small btn-danger" data-mp="prune">删除这些</button>',
      '    </div>',
      '    <div class="mp-row"><span class="mp-row-k"></span>',
      '      <button class="btn btn-small" data-mp="sweep">现在按设置清理一次（保留 ' + esc(String(((S.snapshot && S.snapshot.settings) || {}).archiveRetainDays || 30)) + ' 天）</button>',
      '      <button class="btn btn-small" data-mp="backups">查看可回档的备份</button>',
      '    </div>',
      '    <div class="mp-backups"></div>',
      '    <div class="muted" style="font-size:11px;padding:2px 0">删存档只动机器人本地的记录，QQ 里不会有任何变化；删之前会自动备份，能一键回档。</div>',
      '  </div>',
      '</details>'
    ].join('');
  }

  function questionsBlock(chatKey, questions) {
    var list = (questions || []).filter(function (q) { return q.status !== 'resolved'; });
    if (!list.length) return '';
    return [
      '<details class="collapsible mem-fold" open>',
      '  <summary><span class="mem-who">待你裁决的记忆判定（' + list.length + '）</span></summary>',
      '  <div class="coll-body">',
      list.map(function (q) {
        return '<div class="mp-q" data-qid="' + esc(q.id) + '">'
          + '<span class="badge' + (q.status === 'pending' ? '' : ' ok') + '">' + (q.status === 'pending' ? '等主人回答' : '主人已答') + '</span> '
          + esc(q.question)
          + (q.answer ? '<div class="muted" style="font-size:12px">主人答：' + esc(q.answer) + '</div>' : '')
          + '<div class="mp-row"><input class="inp mp-q-in" placeholder="直接代答 / 给结论" />'
          + '<button class="btn btn-small" data-mp="q-resolve">落定</button></div></div>';
      }).join(''),
      '  </div>',
      '</details>'
    ].join('');
  }

  // ── 按 QQ 号档案视图 ────────────────────────────────────────────────
  // 一人一份、跨会话合并。三段：人物画像（标签是附加）｜长期记忆（结论 + 事件流水）｜短期记忆
  var PROF_SENS = ['黄油', '黄游', '小黄游', '成人游戏', '隆胸', '黄图', '色情', '本子', '约炮', '裸聊'];
  function profSensitive(t) {
    var s = String(t || '');
    for (var i = 0; i < PROF_SENS.length; i += 1) { if (s.indexOf(PROF_SENS[i]) >= 0) return true; }
    return false;
  }

  function profBodyHtml(p) {
    if (!p) return '<div class="muted" style="padding:6px 0">没有这个人的档案</div>';
    var traits = (p.persona && p.persona.traits) || [];
    var tags = (p.persona && p.persona.tags) || [];
    var lt = (p.longTerm || []).filter(function (x) { return x.flag !== 'sensitive' && !profSensitive(x.text); });
    var gen = lt.filter(function (x) { return x.kind !== 'event'; });
    var ev = lt.filter(function (x) { return x.kind === 'event'; });
    var st = (p.state || p.shortTerm || []).filter(function (x) { return !profSensitive(x.text); });
    var out = [];

    out.push('<div class="mp-sec">人物画像 · 标签是附加（' + traits.length + ' 条）</div>');
    if (!traits.length) out.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有画像结论，多整理几次会沉淀出来</div>');
    traits.forEach(function (t) {
      out.push('<div class="mp-line"><span class="mp-line-t">' + esc(t.text) + '</span></div>');
    });
    out.push('<div class="mp-row" style="margin-top:4px"><span class="mp-row-k">附加标签</span><span class="mp-tags">');
    if (!tags.length) out.push('<span class="muted" style="font-size:12px">还没有标签</span>');
    tags.forEach(function (t) { out.push('<span class="badge">' + esc(t.tag) + '</span>'); });
    out.push('</span></div>');

    out.push('<div class="mp-sec">长期记忆 · 结论（' + gen.length + ' 条）</div>');
    if (!gen.length) out.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有稳定结论</div>');
    gen.forEach(function (x) {
      out.push('<div class="mp-line"><span class="mp-line-t">' + esc(x.text)
        + (x.kind === 'appointment' ? ' <span class="badge" style="color:var(--warn);border-color:var(--warn-line)">约定·原文</span>' : '')
        + '</span></div>');
    });

    if (ev.length) {
      out.push('<details class="collapsible mem-fold"><summary><span class="mem-who">长期记忆 · 事件流水（' + ev.length + ' 条，存档、不注入提示词）</span></summary><div class="coll-body">');
      ev.slice(0, 40).forEach(function (x) {
        out.push('<div class="mp-line"><span class="mp-line-t" style="font-size:12px">' + esc(String(x.text || '').slice(0, 220)) + '</span></div>');
      });
      if (ev.length > 40) out.push('<div class="muted" style="font-size:12px">还有 ' + (ev.length - 40) + ' 条，看文件里的完整档案</div>');
      out.push('</div></details>');
    }

    out.push('<div class="mp-sec">短期记忆 · 会过期、不注入提示词（' + st.length + ' 条）</div>');
    if (!st.length) out.push('<div class="muted" style="font-size:12px;padding:2px 0">还没有短期记忆</div>');
    st.slice().sort(function (a, b) { return (Number(b.hits) || 0) - (Number(a.hits) || 0); }).forEach(function (x) {
      var left = '';
      if (x.expiresAt) {
        var days = Math.ceil((Number(x.expiresAt) - Date.now()) / 86400000);
        left = days > 0 ? '，' + days + ' 天后过期' : '，已过期';
      }
      out.push('<div class="mp-line"><span class="mp-line-t">' + esc(x.text)
        + '<span class="muted" style="font-size:11px">' + esc(left) + '</span></span></div>');
    });

    var alias = (p.aliases || []).filter(function (a) { return String(a) !== String(p.userId); });
    out.push('<div class="mp-row muted" style="margin-top:8px;font-size:12px">来自会话：'
      + esc((p.scopes || []).join('、') || '—') + (alias.length ? '　别名：' + esc(alias.join('、')) : '') + '</div>');
    return out.join('\n');
  }

  function profCardHtml(item) {
    var uid = esc(item.userId);
    var head = '<span class="mem-who">' + esc(item.name) + ' <span class="muted">(QQ ' + uid + ')</span>'
      + '<span class="muted">　画像 ' + (Number(item.portrait) || 0) + ' · 长期 ' + (Number(item.long) || 0)
      + ' · 事件 ' + (Number(item.events) || 0) + ' · 短期 ' + (Number(item.shortTerm) || 0) + '</span></span>';
    return '<details class="collapsible mem-fold" data-prof="' + uid + '">'
      + '<summary>' + head
      + '<span class="mem-actions"><button class="btn btn-small" data-mp="prof-consolidate" data-uid="' + uid + '" title="只整理这个人：回看聊天记录补新记忆、重压标签、判晋升">整理他</button></span>'
      + '</summary>'
      + '<div class="coll-body" data-prof-body="' + uid + '"><div class="muted">点开加载…</div></div>'
      + '</details>';
  }

  async function fillProf(uid, body) {
    body.innerHTML = '<div class="muted">读取…</div>';
    try {
      var r = await act('profile-detail', { userId: uid });
      body.innerHTML = profBodyHtml(r && r.profile);
    } catch (e) {
      body.innerHTML = '<div class="muted">读取失败：' + esc(e && e.message ? e.message : e) + '</div>';
    }
  }

  async function consolidateProfile(uid) {
    var p = null;
    try { var r = await act('profile-detail', { userId: uid }); p = r && r.profile; } catch (e) { /* 用不到就退 */ }
    var scopes = (p && p.scopes) || [];
    if (!scopes.length) { setStatus('这个人还没有归属会话，先在会话视图里整理一次', true); return; }
    var days = Number((S.snapshot && S.snapshot.settings && S.snapshot.settings.consolidateDays) || 3);
    if (days !== 1 && days !== 7) days = 3;
    try {
      await act('consolidate', { chatKey: scopes[0], userIds: [String(uid)], days: days });
      setStatus('已开始整理 ' + uid + '（' + (p.name || uid) + '，范围 ' + days + ' 天），进度看右侧状态区');
      startPoll();
    } catch (e) {
      setStatus('整理失败：' + (e && e.message ? e.message : e), true);
    }
  }

  async function renderProfilesView() {
    var detail = q1('#memory-detail');
    if (!detail) return;
    detail.innerHTML = [
      '<div class="detail-header mp-page">',
      '  <div class="mp-main">',
      '    <h2>按 QQ 号档案 <button class="btn btn-small" id="mp-back-chat" style="margin-left:10px">返回会话</button></h2>',
      '    <div class="sub" id="mp-prof-sub">读取中…</div>',
      '    <div id="mp-prof-list"></div>',
      '  </div>',
      '</div>'
    ].join('\n');
    var list = q1('#mp-prof-list');
    var r = null;
    try {
      r = await act('profiles', {});
    } catch (e) {
      var sub0 = q1('#mp-prof-sub');
      if (sub0) sub0.textContent = '读取失败：' + (e && e.message ? e.message : e);
      return;
    }
    var items = (r && r.items) || [];
    var sub = q1('#mp-prof-sub');
    if (sub) sub.textContent = '一人一份、跨会话合并　共 ' + items.length + ' 人　目录：' + (r.dir || '');
    if (!items.length) {
      list.innerHTML = '<div class="muted" style="padding:10px">档案目录还是空的，先整理任意一个会话就会生成</div>';
      return;
    }
    list.innerHTML = items.map(profCardHtml).join('\n');

    qa('details[data-prof]', list).forEach(function (el) {
      el.addEventListener('toggle', function () {
        if (!el.open) return;
        var body = q1('[data-prof-body]', el);
        if (!body || body.getAttribute('data-loaded')) return;
        body.setAttribute('data-loaded', '1');
        void fillProf(el.getAttribute('data-prof'), body);
      });
    });
    qa('[data-mp="prof-consolidate"]', list).forEach(function (btn) {
      btn.addEventListener('click', function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        void consolidateProfile(btn.getAttribute('data-uid'));
      });
    });
    var back = q1('#mp-back-chat');
    if (back) back.addEventListener('click', function () { void renderDetail(currentChatKey()); });
  }

  async function renderDetail(chatKey) {
    var detail = q1('#memory-detail');
    if (!detail || !chatKey) return;
    var view = captureView();
    await loadCfg();
    // 上一次的交叉验证疑点：不读回来，刷新一次标红就全没了
    await loadXcReport(chatKey);
    if (!S.members[chatKey]) await loadCoreMembers(chatKey);
    var coreMembers = S.members[chatKey] || [];
    var sc = snapChat(chatKey);
    var snapMembers = (sc && sc.members) || [];
    var longN = coreMembers.reduce(function (n, m) { return n + ((m.impressions || []).length); }, 0);
    var shortN = snapMembers.reduce(function (n, m) { return n + ((m.short || []).length); }, 0);
    var tagN = snapMembers.reduce(function (n, m) { return n + ((m.labels || []).length); }, 0);
    var last = sc && sc.lastConsolidatedAt ? fmt(sc.lastConsolidatedAt) : '从未';
    var ids = {};
    coreMembers.forEach(function (m) { ids[String(m.userId)] = true; });
    snapMembers.forEach(function (m) { ids[String(m.userId)] = true; });
    // 成员顺序：默认按记忆条数从多到少（有积累的人排在前面），也可切成按 QQ 号或昵称
    var order = (S.sortMode || 'count');
    var rowsData = Object.keys(ids).map(function (uid) {
      var cm = coreMember(chatKey, uid);
      var sm = snapMember(chatKey, uid);
      return {
        uid: uid,
        // 这里以前少传了 chatKey，nameOf 拿到的全是 "undefined"，导致"按昵称"排序等于没排
        name: nameOf(chatKey, uid) || String(uid),
        count: ((cm && cm.impressions) || []).length + ((sm && sm.short) || []).length
      };
    });
    rowsData.sort(function (a, b) {
      if (order === 'qq') {
        var na = Number(a.uid);
        var nb = Number(b.uid);
        // 非数字 uid 一律沉底，免得 NaN 把整列顺序带乱
        if (!Number.isFinite(na)) na = Number.MAX_SAFE_INTEGER;
        if (!Number.isFinite(nb)) nb = Number.MAX_SAFE_INTEGER;
        return (na - nb) || String(a.uid).localeCompare(String(b.uid));
      }
      if (order === 'name') {
        // 还没起昵称的人（名字就是 QQ 号）沉到最后，其余按中文拼音 + 数字自然序
        var an = String(a.name) === String(a.uid) ? 1 : 0;
        var bn = String(b.name) === String(b.uid) ? 1 : 0;
        if (an !== bn) return an - bn;
        return String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true })
          || ((Number(a.uid) || 0) - (Number(b.uid) || 0));
      }
      return (b.count - a.count) || ((Number(a.uid) || 0) - (Number(b.uid) || 0));
    });
    var rows = rowsData.map(function (x) {
      return memberBlock(chatKey, x.uid, coreMember(chatKey, x.uid), snapMember(chatKey, x.uid));
    }).join('');
    var kind = chatKey.indexOf('group') === 0 ? 'group' : 'private';
    var membersHtml = kind === 'group'
      ? '<div class="field" style="margin:8px 0"><button class="btn btn-small" id="mem-load-members-btn">拉取群成员列表（编辑备注）</button><span id="mem-members-status" class="muted"></span></div><div id="mem-members"></div>'
      : '';
    var roster = (S.status && S.status.roster) || null;
    var rosterHint = (roster && roster.total) ? (' · 群友 ' + roster.total + ' 人 / 有记忆 ' + roster.covered + ' 人') : '';
    detail.innerHTML = [
      '<div class="detail-header mp-page">',
      '  <div class="mp-main">',
      '    <h2>' + esc(chatTitle(chatKey)) + ' 的记忆 <button class="btn btn-small" id="mp-open-profiles" style="margin-left:10px" title="按 QQ 号一人一份的档案：人物画像（标签是附加）｜长期记忆（结论 + 事件流水）｜短期记忆">按 QQ 号档案</button></h2>',
      '    <div class="sub">',
      '      <span>长期 ' + longN + ' 条 · 短期 ' + shortN + ' 条 · 标签 ' + tagN + ' 个 · 上次整理 ' + esc(last) + rosterHint + '</span>',
      '    </div>',
      '    ' + membersHtml,
      '    ' + questionsBlock(chatKey, sc && sc.questions),
      '    ' + xcBarHtml(chatKey),
      '    ' + (rows || '<div class="muted" style="padding:10px">这个会话还没有任何记忆。可以点右侧「＋ 添加记忆」手动记，或点「整理本记忆」让模型从聊天记录里提炼。</div>'),
      '    ' + archiveBlock(chatKey),
      '  </div>',
      statusBarHtml(),
      '</div>'
    ].join('\n');

    var loadMembersBtn = q1('#mem-load-members-btn');
    if (loadMembersBtn) {
      loadMembersBtn.addEventListener('click', async function () {
        var chatId = chatKey.split(':')[1] || '';
        var note = '';
        // 群里改过群名片，记忆里存的还是旧名：先让插件把 name 刷成最新的，再重画这一块
        if (chatKey.indexOf('group:') === 0) {
          try {
            var rr = await act('refresh-names', { chatKey: chatKey });
            note = (rr && rr.note) || '';
            await loadSnapshot();
          } catch (e) {
            setStatus('刷新昵称失败：' + (e && e.message ? e.message : e), true);
          }
        }
        await renderDetail(chatKey);
        // 再调宿主那张"群名片 / QQ昵称 / 备注"的表（表情编辑备注用的）
        if (typeof window.loadGroupMembers === 'function') window.loadGroupMembers(chatId, chatKey);
        if (note) setStatus(note);
      });
    }
    var openProf = q1('#mp-open-profiles');
    if (openProf) openProf.addEventListener('click', function () { void renderProfilesView(); });
    var sortSel = q1('#mp-sort');
    if (sortSel) {
      sortSel.value = S.sortMode || 'count';
      sortSel.addEventListener('change', function () {
        S.sortMode = sortSel.value || 'count';
        try { window.localStorage.setItem('mp-sort-mode', S.sortMode); } catch (e) { /* 隐私模式禁写就算了 */ }
        renderDetail(chatKey);
      });
    }
    // 整理范围：1 / 3 / 7 天，选完立刻存进设置（下一轮整理生效）
    var scopeSel = q1('#mp-scope');
    if (scopeSel) {
      var curDays = Number((S.snapshot && S.snapshot.settings && S.snapshot.settings.consolidateDays) || 3);
      if (curDays !== 1 && curDays !== 7) curDays = 3;
      scopeSel.value = String(curDays);
      scopeSel.addEventListener('change', async function () {
        var v = Number(scopeSel.value) === 1 ? 1 : (Number(scopeSel.value) === 7 ? 7 : 3);
        try {
          await core('/api/skills/memory-plus', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ settings: { consolidateDays: v } })
          });
          if (S.snapshot && S.snapshot.settings) S.snapshot.settings.consolidateDays = v;
          appendLocalNote('整理范围已设为' + (v === 1 ? '「今天」' : '「最近 ' + v + ' 天」'));
        } catch (e) {
          appendLocalNote('保存整理范围失败：' + e.message, true);
        }
      });
    }
    bindDetail(detail, chatKey);
    lastRenderedChat = chatKey;
    restoreView(view);
    renderStatus();
  }

  // ── 五、交互 ────────────────────────────────────────────────────────
  function memberEl(root, uid) { return q1('.mem-fold[data-uid="' + uid + '"]', root); }

  async function refreshMember(root, chatKey, uid) {
    await keepingView(async function () {
      await loadCoreMembers(chatKey);
      await loadSnapshot();
      var old = memberEl(root, uid);
      var html = memberBlock(chatKey, uid, coreMember(chatKey, uid), snapMember(chatKey, uid));
      if (old) {
        var tmp = document.createElement('div');
        tmp.innerHTML = html;
        // ⚠️ replaceWith 会把这个节点从 tmp 里**移走**，之后 tmp.firstElementChild 就是 null，
        //    以前直接拿它去 bindMember，等于把所有按钮的点击绑定全丢掉：点一下只会触发折叠。
        var node = tmp.firstElementChild;
        old.replaceWith(node);
        bindMember(node, chatKey, uid, root);
      } else {
        await renderDetail(chatKey);
      }
    });
    pollStatus(true);
  }

  function bindMember(el, chatKey, uid, root) {
    if (!el) return;
    var pick = function (name) { return q1('[data-mp="' + name + '"]', el); };
    var longList = function () {
      var cm = coreMember(chatKey, uid);
      return (cm && cm.impressions) || [];
    };

    // 折叠改成专用按键：标题栏上点哪儿都不会再顺手把整块收起来（以前点在按钮上会把块一起折了）
    var foldBtn = pick('fold-toggle');
    var sum = q1('summary', el);
    if (foldBtn) foldBtn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      el.open = !el.open;
      foldBtn.textContent = el.open ? '▾' : '▸';
    });
    if (sum) {
      // 拦掉 <summary> 的默认折叠：只有上面那个按钮能收/放。
      // 用捕获阶段，否则「点到 summary 自身的空白处」时等到冒泡已经来不及，
      // 整块照样会被收起来（用户看到的就是「点删除顺带折叠」）。
      // 按钮 / 复选框这些自己 stopPropagation 的交互控件放行，勾选照常。
      sum.addEventListener('click', function (e) {
        var t = e.target;
        if (t && t.closest && t.closest('[data-mp="fold-toggle"]')) return;
        if (t && t.closest && t.closest('button, input, label, select, textarea, a')) return;
        e.preventDefault();
      }, true);
    }

    // 「选人」：只决定这个人参不参与交叉验证（和他名下条目的勾选是两套，互不影响）。
    // 这里**不能**用原生 input/label —— 放在 <summary> 里，点击会被 details 的折叠
    // 默认行为抢走，checked 当场被回滚、连 change 都不触发（实测）。所以自绘方框 + 自己管状态。
    var pickMember = pick('pick-member');
    if (pickMember) {
      pickMember.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        var sel = S.xcSel[chatKey] || (S.xcSel[chatKey] = {});
        if (sel[uid]) delete sel[uid];
        else sel[uid] = true;
        pickMember.classList.toggle('mp-on', !!sel[uid]);
        updateXcBar(chatKey);
      });
    }

    var editAll = pick('edit-all');
    if (editAll) editAll.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      var cm = coreMember(chatKey, uid) || { userId: uid, name: '', impressions: [] };
      if (typeof window.openMemberImpressModal === 'function') window.openMemberImpressModal(chatKey, cm);
      else setStatus('核心的编辑弹窗不可用（控制台版本不匹配）', true);
    });

    var refreshBtn = pick('refresh');
    if (refreshBtn) refreshBtn.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      appendLocalNote('已让模型重新分析这个人…');
      try {
        await core('/api/memory-files/consolidate', {
          method: 'POST', body: JSON.stringify({ chatKey: chatKey, userIds: [uid], force: true })
        });
        appendLocalNote('已提交「更新记忆」，结果稍后自动刷新');
      } catch (err) { appendLocalNote('更新失败：' + err.message, true); }
    });

    var tagsBtn = pick('tags');
    if (tagsBtn) tagsBtn.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      var btn = e.currentTarget;
      btn.disabled = true; btn.textContent = '压缩中…';
      appendLocalNote('正在让模型压缩标签…');
      try {
        var r = await act('labels-suggest', { chatKey: chatKey, userId: uid });
        if (r && r.ok) appendLocalNote('标签已更新：' + (r.tags || []).join(' · '));
        else appendLocalNote('没拿到可用标签：' + ((r && (r.error || r.hint)) || '模型没返回'), true);
        await refreshMember(root, chatKey, uid);
      } catch (err) {
        appendLocalNote('压缩标签失败：' + err.message, true);
      } finally {
        btn.disabled = false; btn.textContent = '压缩标签';
      }
    });

    // ── 勾选批量：删除 / 晋升（以前每条后面两个按钮，点一个删一个，慎得慌；现在勾几个删几个）──
    var picked = function (kind) {
      var out = [];
      qa('[data-mp="pick"]:checked', el).forEach(function (c) {
        if (kind === 'long' && c.getAttribute('data-kind') === 'long') out.push(Number(c.getAttribute('data-idx')));
        if (kind === 'short' && c.getAttribute('data-kind') === 'short') out.push(c.getAttribute('data-short-id'));
      });
      return out;
    };

    var pickAll = pick('pick-all');
    if (pickAll) {
      pickAll.addEventListener('click', function (e) { e.stopPropagation(); });
      pickAll.addEventListener('change', function () {
        var on = pickAll.checked;
        qa('[data-mp="pick"]', el).forEach(function (c) { c.checked = on; });
      });
    }

    var bulkDel = pick('bulk-del');
    if (bulkDel) bulkDel.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      var longs = picked('long');
      var shorts = picked('short');
      var n = longs.length + shorts.length;
      if (!n) { appendLocalNote('先勾选要删的条目（每条左边有个方框）', true); return; }
      var seg = [];
      if (longs.length) seg.push('长期 ' + longs.length + ' 条');
      if (shorts.length) seg.push('短期 ' + shorts.length + ' 条');
      if (!(await confirmBox('删除 ' + nameOf(chatKey, uid) + ' 选中的 ' + n + ' 条？\n（' + seg.join(' / ') + '）'))) return;
      bulkDel.disabled = true; bulkDel.textContent = '删除中…';
      var ok = 0;
      var bad = [];
      try {
        if (longs.length) {
          // 长期记忆一次性写回剩下的，不逐条打请求
          var keep = longList().filter(function (x, i) { return longs.indexOf(i) < 0; }).map(function (x) { return x.content; });
          await putMember(chatKey, uid, keep);
          ok += longs.length;
        }
        for (var i = 0; i < shorts.length; i += 1) {
          try { await act('short-delete', { chatKey: chatKey, userId: uid, shortId: shorts[i] }); ok += 1; }
          catch (err) { bad.push(err.message); }
        }
        appendLocalNote(bad.length ? ('已删 ' + ok + ' 条，' + bad.length + ' 条失败：' + bad[0]) : ('已删除 ' + ok + ' 条'), bad.length > 0);
        await refreshMember(root, chatKey, uid);
      } catch (err) {
        appendLocalNote('删除失败：' + err.message, true);
        bulkDel.disabled = false; bulkDel.textContent = '删除选中';
      }
    });

    var bulkPromote = pick('bulk-promote');
    if (bulkPromote) bulkPromote.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      var ids = picked('short');
      if (!ids.length) { appendLocalNote('先勾选要晋升的短期记忆', true); return; }
      bulkPromote.disabled = true; bulkPromote.textContent = '晋升中…';
      try {
        var sm = snapMember(chatKey, uid) || { short: [] };
        var items = [];
        for (var j = 0; j < ids.length; j += 1) {
          var one = (sm.short || []).filter(function (s) { return s.id === ids[j]; })[0];
          if (one) items.push(one);
        }
        if (!items.length) throw new Error('勾选的短期记忆已经不在了，刷新一下再试');
        var list = longList().map(function (x) { return x.content; });
        for (var k = 0; k < items.length; k += 1) if (list.indexOf(items[k].content) < 0) list.push(items[k].content);
        await putMember(chatKey, uid, list);
        for (var m2 = 0; m2 < items.length; m2 += 1) {
          await act('promote', { chatKey: chatKey, userId: uid, shortId: items[m2].id, reason: '控制台人工晋升' });
        }
        appendLocalNote('已把 ' + items.length + ' 条晋升为长期记忆');
        await refreshMember(root, chatKey, uid);
      } catch (err) {
        appendLocalNote('晋升失败：' + err.message, true);
        bulkPromote.disabled = false; bulkPromote.textContent = '晋升选中';
      }
    });

    var tagAdd = pick('tag-add');
    if (tagAdd) tagAdd.addEventListener('click', async function (e) {
      e.preventDefault(); e.stopPropagation();
      var input = pick('tag-in');
      var v = String((input && input.value) || '').trim();
      if (!v) return;
      try {
        await act('label-add', { chatKey: chatKey, userId: uid, tag: v });
        await refreshMember(root, chatKey, uid);
      } catch (err) { appendLocalNote('加标签失败：' + err.message, true); }
    });
    qa('[data-mp="tag-del"]', el).forEach(function (x) {
      x.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        try {
          await act('label-delete', { chatKey: chatKey, userId: uid, tag: x.getAttribute('data-tag') });
          await refreshMember(root, chatKey, uid);
        } catch (err) { appendLocalNote('删标签失败：' + err.message, true); }
      });
    });

    // 长期记忆：就地编辑（不用 prompt —— Electron 里 prompt 被禁，点了没反应）
    qa('[data-mp="long-edit"]', el).forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault(); e.stopPropagation();
        var idx = Number(btn.getAttribute('data-idx'));
        var line = q1('.mp-line[data-long-idx="' + idx + '"]', el);
        var cur = (longList()[idx] || {}).content || '';
        if (!line || line.getAttribute('data-editing') === '1') return;
        line.setAttribute('data-editing', '1');
        line.innerHTML = '<textarea class="inp mp-edit-ta"></textarea>'
          + '<span class="mp-line-a"><button class="btn btn-small btn-primary" data-mp="long-save">保存</button>'
          + '<button class="btn btn-small" data-mp="long-cancel">取消</button></span>';
        var ta = q1('.mp-edit-ta', line);
        ta.value = cur;
        ta.focus();
        try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (err) { /* ignore */ }
        q1('[data-mp="long-cancel"]', line).addEventListener('click', function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          refreshMember(root, chatKey, uid);
        });
        q1('[data-mp="long-save"]', line).addEventListener('click', async function (ev) {
          ev.preventDefault(); ev.stopPropagation();
          var next = String(ta.value || '').trim();
          if (!next) { appendLocalNote('内容不能为空（要删请点「删」）', true); return; }
          try {
            var list = longList().map(function (x) { return x.content; });
            list[idx] = next;
            await putMember(chatKey, uid, list);
            appendLocalNote('已保存');
            await refreshMember(root, chatKey, uid);
          } catch (err) { appendLocalNote('保存失败：' + err.message, true); }
        });
      });
    });

    qa('[data-mp="long-del"]', el).forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        var idx = Number(btn.getAttribute('data-idx'));
        if (!(await confirmBox('删除这条长期记忆？\n\n' + ((longList()[idx] || {}).content || '')))) return;
        try {
          var list = longList().filter(function (x, i) { return i !== idx; }).map(function (x) { return x.content; });
          await putMember(chatKey, uid, list);
          appendLocalNote('已删除');
          await refreshMember(root, chatKey, uid);
        } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
      });
    });

    // 短期 → 长期：先写长期（核心接口），再删短期
    qa('[data-mp="promote"]', el).forEach(function (btn) {
      var line = btn.closest('.mp-line');
      var shortId = line && line.getAttribute('data-short-id');
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        btn.disabled = true; btn.textContent = '晋升中…';
        try {
          var sm = snapMember(chatKey, uid) || { short: [] };
          var item = (sm.short || []).filter(function (s) { return s.id === shortId; })[0];
          if (!item) throw new Error('这条短期记忆已经不在了，刷新后可看到最新状态');
          var list = longList().map(function (x) { return x.content; });
          if (list.indexOf(item.content) < 0) list.push(item.content);
          await putMember(chatKey, uid, list);
          await act('promote', { chatKey: chatKey, userId: uid, shortId: shortId, reason: '控制台人工晋升' });
          appendLocalNote('已晋升为长期记忆' + (Number(item.hits) > 0 ? '（提及×' + item.hits + '）' : ''));
          await refreshMember(root, chatKey, uid);
        } catch (err) {
          appendLocalNote('晋升失败：' + err.message, true);
          btn.disabled = false; btn.textContent = '晋升';
        }
      });
    });

    qa('[data-mp="short-del"]', el).forEach(function (btn) {
      var line = btn.closest('.mp-line');
      var shortId = line && line.getAttribute('data-short-id');
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        try {
          await act('short-delete', { chatKey: chatKey, userId: uid, shortId: shortId });
          appendLocalNote('已删除这条短期记忆');
          await refreshMember(root, chatKey, uid);
        } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
      });
    });

    var save = async function () {
      var input = pick('add-in');
      var sel = pick('add-kind');
      var v = String((input && input.value) || '').trim();
      if (!v) return;
      try {
        var r = await act('short-save', {
          chatKey: chatKey, userId: uid, content: v,
          kind: (sel && sel.value) || 'general', name: noteOf(uid)
        });
        appendLocalNote(r.merged ? '同一件事已记过，提及次数 +1' : '已记下（手工记的从 0 开始，界面不显示提及）');
        await refreshMember(root, chatKey, uid);
      } catch (err) { appendLocalNote('记下失败：' + err.message, true); }
    };
    var addSave = pick('add-save');
    if (addSave) addSave.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); save(); });
    var addIn = pick('add-in');
    if (addIn) addIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
    });
  }

  async function putMember(chatKey, uid, contents) {
    await core('/api/memory-files/' + keyToPath(chatKey) + '/members/' + encodeURIComponent(uid), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: noteOf(uid) || '', impressions: (contents || []).slice(0, 20) })
    });
  }

  function bindDetail(detail, chatKey) {
    var on = function (name, fn) {
      qa('[data-mp="' + name + '"]', detail).forEach(function (el) {
        el.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); fn(el, e); });
      });
    };

    on('refresh-status', async function (btn) {
      btn.disabled = true; btn.textContent = '刷新中…';
      try {
        await act('snapshot', {});       // 强制重写一次快照，保证读到最新数据
        S.cfg = null; S.providers = null;
        await pollStatus(true);
        await refreshAll();
        appendLocalNote('状态已刷新（' + new Date().toLocaleTimeString('zh-CN', { hour12: false }) + '）');
      } catch (err) { appendLocalNote('刷新失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '刷新状态';
    });

    on('save-model', function () { saveModel(); });
    on('save-xc-model', function () { saveXcModel(); });

    on('extract-now', async function (btn) {
      btn.disabled = true; btn.textContent = '提取中…';
      try {
        var r = await act('extract-now', {});
        appendLocalNote(r && r.note ? r.note : '已尝试提取', !(r && r.ok));
        await refreshAll();
      } catch (err) { appendLocalNote('提取失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '立刻提取新记忆';
    });

    on('add-member', function () {
      if (typeof window.openMemberImpressModal === 'function') window.openMemberImpressModal(chatKey, null);
      else appendLocalNote('核心的添加弹窗不可用（控制台版本不匹配）', true);
    });

    on('expire', async function (btn) {
      btn.disabled = true;
      try {
        var r = await act('expire-now', {});
        appendLocalNote('已清理过期短期记忆 ' + (r.removed || 0) + ' 条');
        await refreshAll();
      } catch (err) { appendLocalNote('清理失败：' + err.message, true); }
      btn.disabled = false;
    });

    on('rescan', async function (btn) {
      btn.disabled = true; btn.textContent = '扫描中…';
      appendLocalNote('正在重新扫描插件与技能…');
      try {
        var r = await act('rescan', {});
        var note = '已重扫：' + (r.loaded || 0) + ' 个扩展';
        if (r.failed && r.failed.length) note += '，' + r.failed.length + ' 个失败';
        if (r.error) note += '（' + r.error + '）';
        appendLocalNote(note);
        await act('snapshot', {});
        S.cfg = null; S.providers = null;
        await pollStatus(true);
        await refreshAll();
      } catch (err) { appendLocalNote('重新扫描失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '重新扫描';
    });

    on('consolidate', async function () {
      appendLocalNote('已开始整理，进度显示在右侧状态区…');
      try {
        var r = await act('consolidate', { chatKey: chatKey });
        S.status = { running: true, job: r.job || { label: '准备中' }, queue: { active: false, remaining: 0, done: 0, failed: [] } };
        renderStatus();
        startPoll();
      } catch (err) { appendLocalNote('整理失败：' + err.message, true); }
    });

    on('core-consolidate', async function (btn) {
      btn.disabled = true; btn.textContent = '已提交…';
      try {
        await core('/api/memory-files/consolidate', { method: 'POST', body: JSON.stringify({ chatKey: chatKey, force: true }) });
        appendLocalNote('已提交「合并去重」，结果稍后自动刷新');
      } catch (err) { appendLocalNote('提交失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '合并去重';
    });

    // ── 交叉验证：只核对勾选的这几个人，跑完把疑点标红，一条记忆都不改 ──
    on('xc-run', async function (btn) {
      var sel = S.xcSel[chatKey] || {};
      var uids = Object.keys(sel).filter(function (k) { return !!sel[k]; });
      if (uids.length < 2) { appendLocalNote('至少勾 2 个人再点交叉验证', true); return; }
      var names = uids.map(function (u) { return nameOf(chatKey, u); });
      btn.disabled = true; btn.textContent = '核对中…';
      appendLocalNote('只核对这 ' + uids.length + ' 人：' + names.join('、') + '（同一个人长期与短期、彼此之间两两对比）…');
      try {
        var r = await act('cross-check', { chatKey: chatKey, userIds: uids });
        if (r && r.ok === false) appendLocalNote('交叉验证失败：' + (r.error || '未知原因'), true);
        else if (r && r.note) appendLocalNote(r.note);
        else if (!r || !(r.issues || []).length) appendLocalNote('这 ' + uids.length + ' 人之间没查出问题');
        else {
          var cnt = { conflict: 0, attribution: 0, duplicate: 0 };
          (r.issues || []).forEach(function (x) { if (cnt[x.type] != null) cnt[x.type] += 1; });
          appendLocalNote('查出 ' + (r.issues || []).length + ' 处疑点（重复 ' + cnt.duplicate
            + ' · 矛盾 ' + cnt.conflict + ' · 主语 ' + cnt.attribution + '），已标红，请手动改');
        }
        await refreshAll();   // 重画后带红框；不会自动改任何记忆
      } catch (err) { appendLocalNote('交叉验证失败：' + err.message, true); }
      btn.disabled = false; btn.textContent = '交叉验证';
    });

    on('xc-clear', function () {
      S.xcSel[chatKey] = {};
      qa('[data-mp="pick-member"]', q1('#memory-detail')).forEach(function (b) { b.classList.remove('mp-on'); });
      updateXcBar(chatKey);
    });

    // 刷新：重读报告 + 重画。手动改掉一条之后，红框按新内容重新匹配，改过的那条就不再标红
    on('xc-refresh', async function () {
      await loadXcReport(chatKey);
      await refreshAll();
      appendLocalNote('已重读交叉验证报告，红框按当前记忆内容重新对齐');
    });

    // 定位：点一下直接跳到下一处标红的条目，不用自己在几十个成员块里翻
    on('xc-locate', function () {
      var list = qa('#memory-detail .mp-line.mp-bad');
      if (!list.length) { appendLocalNote('现在没有标红的条目可定位', true); return; }
      var i = Number(S.xcLoc[chatKey] || 0);
      if (!Number.isFinite(i) || i >= list.length) i = 0;
      var el = list[i];
      // 收着的成员块先展开，否则滚过去了也看不见
      var fold = el.closest ? el.closest('.mem-fold') : null;
      if (fold && !fold.open) {
        fold.open = true;
        var fb = q1('[data-mp="fold-toggle"]', fold);
        if (fb) fb.textContent = '▾';
      }
      try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) { el.scrollIntoView(); }
      el.classList.remove('mp-flash');
      void el.offsetWidth;              // 强制回流，连着点两次也能重新闪
      el.classList.add('mp-flash');
      setTimeout(function () { if (el) el.classList.remove('mp-flash'); }, 2100);
      S.xcLoc[chatKey] = i + 1;
      appendLocalNote('已定位到第 ' + (i + 1) + ' / ' + list.length + ' 处标红的记忆'
        + (list.length > 1 ? '（再点「定位下一处」跳下一个）' : ''));
    });

    on('queue-start', async function (btn) {
      btn.disabled = true;
      try {
        var r = await act('queue-start', { chatKey: chatKey });
        appendLocalNote('已排队 ' + (r.queued || 0) + ' 个人，每 30 秒处理一个');
        await pollStatus(true);
      } catch (err) { appendLocalNote('排队失败：' + err.message, true); }
      btn.disabled = false;
    });

    on('queue-clear', async function () {
      try {
        await act('queue-clear', { chatKey: chatKey });
        appendLocalNote('已清空标签队列');
        await pollStatus(true);
      } catch (err) { appendLocalNote('停止失败：' + err.message, true); }
    });

    qa('.mp-q', detail).forEach(function (box) {
      var btn = q1('[data-mp="q-resolve"]', box);
      var input = q1('.mp-q-in', box);
      if (!btn) return;
      btn.addEventListener('click', async function (e) {
        e.preventDefault(); e.stopPropagation();
        var v = String((input && input.value) || '').trim();
        if (!v) { appendLocalNote('先填一句结论', true); return; }
        try {
          await act('question-resolve', { chatKey: chatKey, questionId: box.getAttribute('data-qid'), decision: v });
          appendLocalNote('已落定');
          await refreshAll();
        } catch (err) { appendLocalNote('落定失败：' + err.message, true); }
      });
    });

    // ── 存档区 ──
    var archive = q1('.mp-archive', detail);
    if (archive) {
      archive.addEventListener('toggle', function () { S.archiveOpen = archive.open; });
      var dateVal = function (name) {
        var y = q1('[data-mp="' + name + '-y"]', detail);
        var m = q1('[data-mp="' + name + '-m"]', detail);
        var d = q1('[data-mp="' + name + '-d"]', detail);
        if (!y || !y.value) return '';
        return y.value + '-' + String((m && m.value) || '1').padStart(2, '0') + '-' + String((d && d.value) || '1').padStart(2, '0');
      };
      var setRange = function (from, to) {
        var set = function (name, val) {
          var y = q1('[data-mp="' + name + '-y"]', detail);
          var m = q1('[data-mp="' + name + '-m"]', detail);
          var d = q1('[data-mp="' + name + '-d"]', detail);
          if (!y) return;
          if (!val) { y.value = ''; if (m) m.value = ''; if (d) d.value = ''; return; }
          var p = String(val).split('-');
          y.value = p[0] || '';
          if (m) m.value = String(Number(p[1] || 1));
          if (d) d.value = String(Number(p[2] || 1));
        };
        set('from', from); set('to', to);
      };

      qa('[data-mp="quick"]', archive).forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.preventDefault(); e.stopPropagation();
          var days = Number(btn.getAttribute('data-days')) || 0;
          if (!days) setRange('', '2099-12-31');
          else {
            var d = new Date(Date.now() - days * 86400000);
            var p = function (x) { return String(x).padStart(2, '0'); };
            setRange('', d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()));
          }
          appendLocalNote('已填好时间范围，点「看看命中几条」再删');
        });
      });

      qa('[data-mp="preview"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          try {
            var r = await act('prune-preview', { chatKey: chatKey, from: dateVal('from'), to: dateVal('to') });
            appendLocalNote('命中 ' + r.count + ' 条（该会话共 ' + r.total + ' 条，范围 ' + r.from + ' ~ ' + r.to + '）');
          } catch (err) { appendLocalNote('预览失败：' + err.message, true); }
        });
      });

      qa('[data-mp="prune"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          var from = dateVal('from');
          var to = dateVal('to');
          if (!(await confirmBox('删除 ' + chatKey + ' 在 ' + (from || '最早') + ' ~ ' + (to || '最新') + ' 之间的聊天记录？\n\n删前会自动备份，之后可以一键回档。'))) return;
          try {
            var r = await act('prune', { chatKey: chatKey, from: from, to: to, confirm: true });
            appendLocalNote('已删除 ' + (r.removed || 0) + ' 条，并已排队复核' + (r.backupPath ? '；备份已生成' : ''));
            await refreshAll();
          } catch (err) { appendLocalNote('删除失败：' + err.message, true); }
        });
      });

      qa('[data-mp="sweep"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          if (!(await confirmBox('按「存档保留天数」清理所有会话的过旧聊天记录？\n\n当前选中的会话会被跳过（它可能正在被机器人使用）。'))) return;
          try {
            var r = await act('sweep-now', { skipActive: chatKey });
            appendLocalNote('清理完成：' + (r.purged || 0) + ' 个会话、共 ' + (r.removed || 0) + ' 条');
            await refreshAll();
          } catch (err) { appendLocalNote('清理失败：' + err.message, true); }
        });
      });

      qa('[data-mp="backups"]', archive).forEach(function (btn) {
        btn.addEventListener('click', async function (e) {
          e.preventDefault(); e.stopPropagation();
          var box = q1('.mp-backups', detail);
          if (!box) return;
          box.innerHTML = '<span class="muted" style="font-size:12px">读取备份…</span>';
          try {
            var r = await act('backups', { chatKey: chatKey });
            var list = r.backups || [];
            if (!list.length) { box.innerHTML = '<span class="muted" style="font-size:12px">还没有备份（清理或删除存档时会自动生成）</span>'; return; }
            box.innerHTML = '<div class="mp-row"><span class="mp-row-k">回档</span><select class="inp mp-backup-sel">'
              + list.slice(0, 30).map(function (b) {
                return '<option value="' + esc(b.file) + '">' + esc(fmt(b.at)) + ' · ' + (b.count >= 0 ? b.count + ' 条' : '?') + ' · ' + (b.bytes / 1024).toFixed(0) + 'KB</option>';
              }).join('')
              + '</select><button class="btn btn-small btn-danger" data-mp="restore">一键回档</button></div>'
              + '<div class="muted" style="font-size:11px">回档会用选中那份备份覆盖当前存档（当前存档也会先备份一份）。</div>';
            var rb = q1('[data-mp="restore"]', box);
            rb.addEventListener('click', async function (ev) {
              ev.preventDefault(); ev.stopPropagation();
              var sel = q1('.mp-backup-sel', box);
              var file = sel && sel.value;
              if (!file) return;
              if (!(await confirmBox('用这份备份覆盖当前存档？'))) return;
              try {
                var rr = await act('backup-restore', { chatKey: chatKey, file: file });
                appendLocalNote('回档完成：恢复 ' + (rr.restored || 0) + ' 条记录。'
                  + '如果这个会话正在被机器人使用，建议点顶栏「重启」让它重新读盘。');
                await refreshAll();
              } catch (err) { appendLocalNote('回档失败：' + err.message, true); }
            });
          } catch (err) { box.innerHTML = '<span class="muted" style="font-size:12px">读取备份失败：' + esc(err.message) + '</span>'; }
        });
      });
    }

    qa('.mem-fold[data-uid]', detail).forEach(function (el2) {
      bindMember(el2, chatKey, el2.getAttribute('data-uid'), detail);
    });
  }

  // ── 六、挂钩核心的记忆页 ────────────────────────────────────────────
  function wrap(name, after) {
    var orig = window[name];
    if (typeof orig !== 'function') return false;
    if (orig.__mpWrapped) return true;
    var wrapped = async function () {
      var r = await orig.apply(this, arguments);
      try { await after.apply(this, arguments); } catch (e) { console.warn('[记忆优化] 接管后处理失败：', e); }
      return r;
    };
    wrapped.__mpWrapped = true;
    window[name] = wrapped;
    return true;
  }

  function decorateList() {
    var box = q1('#memory-items');
    if (!box) return;
    var chats = (S.snapshot && S.snapshot.chats) || [];
    var byKey = {};
    chats.forEach(function (c) { byKey[c.chatKey] = c; });
    qa('.chat-item', box).forEach(function (item) {
      var key = item.getAttribute('data-key');
      var sc = byKey[key];
      var sub = q1('.chat-item-sub', item);
      if (!sub || !sc) return;
      var shortN = 0;
      var tagN = 0;
      (sc.members || []).forEach(function (m) {
        shortN += (m.short || []).length;
        tagN += (m.labels || []).length;
      });
      var pend = (sc.questions || []).filter(function (q) { return q.status === 'pending'; }).length;
      var extra = [];
      if (shortN) extra.push('短期 ' + shortN);
      if (tagN) extra.push('标签 ' + tagN);
      if (pend) extra.push('待裁决 ' + pend);
      var badge = q1('.mp-badge', sub);
      if (!extra.length) { if (badge) badge.textContent = ''; return; }
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'mp-badge';
        sub.appendChild(badge);
      }
      badge.textContent = ' · ' + extra.join(' · ');
    });
  }

  async function afterList() {
    try { if (!S.snapshot) await loadSnapshot(); } catch (e) { /* ignore */ }
    decorateList();
  }
  async function afterDetail(chatKey) {
    var key = chatKey || currentChatKey();
    if (!key) return;
    var changed = lastRenderedChat !== key;   // 必须在 renderDetail 之前判断（它会更新 lastRenderedChat）
    try { await loadSnapshot(); } catch (e) { /* ignore */ }
    await loadCoreMembers(key);
    await loadProviders();
    await renderDetail(key);
    if (changed) {
      // 只有"换了一个会话"才回到顶部；同会话内的刷新一律留在原地
      var d = q1('#memory-detail');
      if (d) d.scrollTop = 0;
    }
    startPoll();
    pollStatus(true);
  }

  function install() {
    if (S.installed) return true;
    if (typeof window.loadMemoryDetail !== 'function') return false;
    var ok1 = wrap('loadMemoryView', afterList);
    var ok2 = wrap('renderMemoryList', afterList);
    var ok3 = wrap('loadMemoryDetail', afterDetail);
    if (!ok1 && !ok2 && !ok3) return false;
    S.installed = true;
    console.log('[记忆优化] 已接管「记忆」页（列表装饰 + 详情增强 + 右侧状态区）');
    return true;
  }

  function boot() {
    if (!install()) {
      var tries = 0;
      var t = setInterval(function () {
        tries += 1;
        if (install() || tries > 20) clearInterval(t);
      }, 300);
      return;
    }
    var st = coreState();
    if (st && st.tab === 'memory' && typeof window.loadMemoryView === 'function') {
      try { window.loadMemoryView(); } catch (e) { /* ignore */ }
    }
    startPoll();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  setTimeout(boot, 1000);
  setTimeout(boot, 2500);
})();
