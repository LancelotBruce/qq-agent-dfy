// persona-detail —— 人设细节库
//
// 思路：角色卡（persona.roleText）只留"我是谁、怎么说话"的骨架，特别细节的内容
// （家人、习惯、经历、外号、小秘密等）存到本技能的独立档案里。
// 系统提示词里只出现一句指引；被问到具体细节时模型先调 query_persona_detail，
// 按需调取，查不到就说记不清、不许编。
//
// 存档位置由 settings.storeDir 决定：配了就写到该目录（方便直接打开查看），
// 没配则落 DATA_DIR/persona-detail/。写时先留 store.json.bak。
// 平常不读盘，只有工具被调用时才读。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig, updateConfig } from '../../src/config.js';
import { logger as appLogger } from '../../src/logger.js';

const SKILL_ID = 'persona-detail';
const STORE_NAME = 'store.json';
const DEFAULTS = { adminQq: '', maxResults: 4, maxEntryChars: 300, maxEntries: 100, storeDir: '' };
const DIR_HINT = path.join(DATA_DIR, SKILL_ID, 'storeDir.hint');
let lastDirForHint = '';

/** 记住最近一次真正生效的存档目录（热重载/启动早期读不到配置时靠它兜住，避免另建一份空档案）。 */
function hintDir() {
  try { return fs.readFileSync(DIR_HINT, 'utf8').trim(); } catch { return ''; }
}
function rememberDir(dir) {
  if (!dir || dir === lastDirForHint) return;
  lastDirForHint = dir;
  try {
    fs.mkdirSync(path.join(DATA_DIR, SKILL_ID), { recursive: true });
    fs.writeFileSync(DIR_HINT, dir, 'utf8');
    backendLog(`记住存档目录：${dir}（配置读不到时靠它兜底）`);
  } catch (error) {
    backendLog(`记住存档目录失败：${error?.message || error}`);
  }
}

let api = null;

function settings() {
  let raw = {};
  let ready = false;
  try {
    raw = (typeof api?.config === 'function' ? api.config() : null) || {};
    ready = Object.keys(raw).length > 0;
  } catch { raw = {}; ready = false; }
  const n = (v, d, lo, hi) => {
    const x = Number(v);
    return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d;
  };
  // 配置还没就绪（刚启动/刚热重载）时不能当"没配 storeDir"，否则会在数据目录另建一份空档案
  const configured = String(raw.storeDir ?? '').trim();
  return {
    adminQq: String(raw.adminQq ?? DEFAULTS.adminQq),
    maxResults: n(raw.maxResults, DEFAULTS.maxResults, 1, 10),
    maxEntryChars: n(raw.maxEntryChars, DEFAULTS.maxEntryChars, 50, 1000),
    maxEntries: n(raw.maxEntries, DEFAULTS.maxEntries, 10, 1000),
    storeDir: configured || (ready ? '' : hintDir()),
  };
}

// 每次调用现算路径，配置改了不用重启
function paths() {
  const dir = settings().storeDir || path.join(DATA_DIR, SKILL_ID);
  if (dir !== path.join(DATA_DIR, SKILL_ID)) rememberDir(dir);
  return {
    dir,
    storeFile: path.join(dir, STORE_NAME),
    bakFile: path.join(dir, `${STORE_NAME}.bak`),
  };
}

function backendLog(msg) {
  try { appLogger.info(SKILL_ID, String(msg)); } catch { /* 日志失败不影响功能 */ }
}

function errorResult(text) {
  return { content: `错误：${text}`, isError: true };
}

function norm(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// ─────────────────────────────────────────────── 档案读写
function readStore() {
  const empty = { version: 1, entries: [] };
  try {
    const { storeFile } = paths();
    if (!fs.existsSync(storeFile)) return empty;
    const raw = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    return { version: 1, entries: Array.isArray(raw?.entries) ? raw.entries : [] };
  } catch (e) {
    backendLog(`档案读取失败，按空档案处理：${e?.message || e}`);
    return empty;
  }
}

function writeStore(store) {
  const { dir, storeFile, bakFile } = paths();
  fs.mkdirSync(dir, { recursive: true });
  try { if (fs.existsSync(storeFile)) fs.copyFileSync(storeFile, bakFile); } catch { /* 备份失败不挡写入 */ }
  const tmp = `${storeFile}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, storeFile);
}

/**
 * 首次安装自举：档案不存在就在存档目录建一个空骨架。
 * 用户原话里的"第二步：在文件夹里新建档案文件"就是这一步——不能等第一次写入才建，
 * 否则装到别人机器上打开文件夹是空的，会以为插件没装上。
 */
function ensureStore() {
  const { dir, storeFile } = paths();
  const fallback = path.join(DATA_DIR, SKILL_ID);
  const hint = hintDir();
  if (dir === fallback && hint) {
    // 明明记过一个自定义目录，却算回了默认目录 = 配置还没读到，此时建档会建出第二份空档案
    backendLog('配置尚未就绪，本次跳过建档（存档目录稍后按配置生效）');
    return { created: false, file: storeFile, skipped: true };
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const stagingFile = path.join(dir, 'staging.json');
    if (!fs.existsSync(stagingFile)) {
      fs.writeFileSync(stagingFile, `${JSON.stringify({ version: 1, items: [] }, null, 2)}\n`, 'utf8');
    }
    if (!fs.existsSync(storeFile)) {
      writeStore({ version: 1, entries: [] });
      backendLog(`存档不存在，已新建空档案：${storeFile}`);
      return { created: true, file: storeFile };
    }
    return { created: false, file: storeFile };
  } catch (error) {
    backendLog(`档案初始化失败：${error?.message || error}`);
    return { created: false, file: storeFile, failed: true };
  }
}

/** 读全局角色卡正文（自举整理人设的输入）。 */
function roleText() {
  try { return String(getConfig()?.persona?.roleText ?? '').trim(); } catch { return ''; }
}

/** 档案现状快照：给管理页与自举工具共用。 */
function snapshot() {
  const store = readStore();
  const entries = store.entries
    .slice()
    .sort((a, b) => (parseInt(a.id, 10) || 0) - (parseInt(b.id, 10) || 0))
    .map((e) => ({
      id: String(e.id ?? ''),
      category: String(e.category ?? ''),
      title: String(e.title ?? ''),
      text: String(e.text ?? ''),
      keywords: parseKeywords(e.keywords),
      source: String(e.source ?? ''),
      at: Number.isFinite(e.at) ? e.at : 0,
    }));
  const cats = new Map();
  let chars = 0;
  for (const e of entries) {
    chars += e.text.length;
    cats.set(e.category || '(未分类)', (cats.get(e.category || '(未分类)') || 0) + 1);
  }
  return {
    ok: true,
    file: paths().storeFile,
    count: entries.length,
    chars,
    categories: [...cats.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count),
    entries,
  };
}

// ─────────────────────────────────────────────── 备份与回退
// 要求：整理或改动之前先把「原人设」存成带时间戳的备份，落在存档目录（和 store.json 同一个文件夹），
// 面板上点一个按钮就能退回去。分两类：
//   ① persona-backup-*.json —— 角色卡 roleText + 人设模板列表（整份人设）
//   ② store-backup-*.json  —— 整份细节档案
const BAK_KEEP = 30;

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function backupFileList(prefix) {
  const { dir } = paths();
  try {
    return fs.readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).sort().reverse();
  } catch { return []; }
}

function pruneBackups(prefix) {
  const { dir } = paths();
  for (const f of backupFileList(prefix).slice(BAK_KEEP)) {
    try { fs.unlinkSync(path.join(dir, f)); } catch { /* 删不掉就留着 */ }
  }
}

function writeBackupFile(prefix, payload) {
  const { dir } = paths();
  fs.mkdirSync(dir, { recursive: true });
  const at = new Date(Number(payload.at) || Date.now());
  const name = `${prefix}${stamp(at)}-${Math.random().toString(36).slice(2, 6)}.json`;
  fs.writeFileSync(path.join(dir, name), JSON.stringify(payload, null, 2), 'utf8');
  pruneBackups(prefix);
  return name;
}

/** 备份当前人设：角色卡正文 + 模板列表。 */
function createPersonaBackup(reason = '手动备份') {
  const cfg = getConfig() || {};
  const roleText = String(cfg?.persona?.roleText ?? '');
  const customPersonas = Array.isArray(cfg?.customPersonas)
    ? cfg.customPersonas.map((p) => ({
      name: String(p?.name ?? ''),
      text: String(p?.text ?? ''),
      ...(p?.customRules ? { customRules: String(p.customRules) } : {}),
    }))
    : [];
  const at = Date.now();
  const file = writeBackupFile('persona-backup-', {
    at,
    atText: new Date(at).toLocaleString('zh-CN'),
    reason,
    roleText,
    roleTextChars: roleText.length,
    customPersonas,
    storeCount: readStore().entries.length,
  });
  backendLog(`人设备份：${file}（roleText ${roleText.length} 字，模板 ${customPersonas.length} 个）`);
  return { file, roleTextChars: roleText.length, templates: customPersonas.length, atText: new Date(at).toLocaleString('zh-CN') };
}

/** 备份当前档案（整份 store.json）。 */
function createStoreBackup(reason = '自动备份') {
  const store = readStore();
  const at = Date.now();
  const chars = store.entries.reduce((s, e) => s + String(e.text || '').length, 0);
  const file = writeBackupFile('store-backup-', {
    at,
    atText: new Date(at).toLocaleString('zh-CN'),
    reason,
    version: store.version ?? 1,
    entries: store.entries,
    count: store.entries.length,
    chars,
  });
  backendLog(`档案备份：${file}（${store.entries.length} 条）`);
  return { file, count: store.entries.length, chars, atText: new Date(at).toLocaleString('zh-CN') };
}

function readBackup(file, prefix) {
  const { dir } = paths();
  const safe = path.basename(String(file || ''));
  if (!safe.startsWith(prefix) || !safe.endsWith('.json')) throw new Error('不是备份文件');
  const full = path.join(dir, safe);
  if (!fs.existsSync(full)) throw new Error(`备份不存在：${safe}`);
  return { safe, data: JSON.parse(fs.readFileSync(full, 'utf8')) };
}

/** 列出两类备份（给面板用，只回传摘要字段，不回传全文）。 */
function listBackups() {
  const { dir } = paths();
  const persona = [];
  for (const f of backupFileList('persona-backup-').slice(0, BAK_KEEP)) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      persona.push({
        file: f,
        at: Number(d.at) || 0,
        atText: String(d.atText || ''),
        reason: String(d.reason || ''),
        roleTextChars: Number(d.roleTextChars ?? String(d.roleText || '').length),
        templates: Array.isArray(d.customPersonas) ? d.customPersonas.length : 0,
        storeCount: Number(d.storeCount) || 0,
      });
    } catch { /* 坏文件跳过 */ }
  }
  const archive = [];
  for (const f of backupFileList('store-backup-').slice(0, BAK_KEEP)) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      archive.push({
        file: f,
        at: Number(d.at) || 0,
        atText: String(d.atText || ''),
        reason: String(d.reason || ''),
        count: Number(d.count ?? (Array.isArray(d.entries) ? d.entries.length : 0)),
        chars: Number(d.chars) || 0,
      });
    } catch { /* 坏文件跳过 */ }
  }
  return { ok: true, dir, persona, store: archive, keep: BAK_KEEP };
}

/** 退回人设：先给当前版本做一份保险，再写回 roleText 与模板列表。 */
function restorePersonaBackup(file) {
  const { safe, data } = readBackup(file, 'persona-backup-');
  const roleText = String(data?.roleText ?? '');
  if (!roleText.trim()) throw new Error('这份备份里没有角色卡正文，不敢回退');
  createPersonaBackup('回退前的当前版本（保险）');
  const patch = { persona: { roleText } };
  if (Array.isArray(data?.customPersonas)) {
    patch.customPersonas = data.customPersonas
      .map((p) => ({
        name: String(p?.name ?? '').trim(),
        text: String(p?.text ?? ''),
        ...(p?.customRules ? { customRules: String(p.customRules) } : {}),
      }))
      .filter((p) => p.name && p.text);
  }
  updateConfig(patch);
  backendLog(`已回退人设到 ${safe}（roleText ${roleText.length} 字，模板 ${patch.customPersonas?.length ?? '未动'} 个）`);
  return {
    ok: true, file: safe,
    roleTextChars: roleText.length,
    templates: Array.isArray(patch.customPersonas) ? patch.customPersonas.length : null,
    note: '设置页需要刷新（Ctrl+R）才能看到新正文',
  };
}

/** 退回档案：先给当前档案做一份保险，再把备份整体写回。 */
function restoreStoreBackup(file) {
  const { safe, data } = readBackup(file, 'store-backup-');
  if (!Array.isArray(data?.entries)) throw new Error('这份备份里没有条目数组，不敢回退');
  createStoreBackup('回退前的当前档案（保险）');
  writeStore({ version: Number(data.version) || 1, entries: data.entries });
  backendLog(`已回退档案到 ${safe}（${data.entries.length} 条）`);
  return { ok: true, file: safe, count: data.entries.length };
}

// ─────────────────────────────────────────────── 来源标签与待确认队列
/**
 * 机器整理出来的东西不能直接进档案：先在 staging.json 排队，等主人逐条签字。
 * 每条带 source，面板按来源着色，「推断」一眼能挑出来。
 */
function normSource(v) {
  const s = String(v ?? '').trim();
  if (!s) return '未标注';
  const low = s.toLowerCase();
  if (['roletext', '角色卡', '角色卡原文', '原文'].includes(low)) return '角色卡原文';
  if (['chat', '聊天记录', '聊天'].includes(low)) return '聊天记录';
  if (['owner', '主人', '主人手写', '主人设定'].includes(low)) return '主人手写';
  if (['inferred', '推断', '推测'].includes(low)) return '推断';
  return s.slice(0, 40);
}

const STAGING_MAX = 300;

function readStaging() {
  const { dir } = paths();
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'staging.json'), 'utf8'));
    return { version: 1, items: Array.isArray(data?.items) ? data.items : [] };
  } catch { return { version: 1, items: [] }; }
}

function writeStaging(data) {
  const { dir } = paths();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'staging.json');
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, items: data.items.slice(0, STAGING_MAX) }, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function stagingKey(title, text) {
  return `${String(title || '').replace(/\s+/g, '')}|${String(text || '').replace(/\s+/g, '').slice(0, 40)}`;
}

/** 把校验过的条目放进待确认队列，同标题同正文的自动跳过。 */
function addToStaging(accepted, mode = 'append') {
  const staging = readStaging();
  const store = readStore();
  const seen = new Set([
    ...store.entries.map((e) => stagingKey(e.title, e.text)),
    ...staging.items.map((e) => stagingKey(e.title, e.text)),
  ]);
  let seq = staging.items.length;
  let added = 0;
  let duplicate = 0;
  for (const item of accepted) {
    const k = stagingKey(item.title, item.text);
    if (seen.has(k)) { duplicate += 1; continue; }
    seen.add(k);
    seq += 1;
    staging.items.push({ sid: String(seq), ...item, mode: String(mode) === 'replace' ? 'replace' : 'append', at: Date.now() });
    added += 1;
  }
  writeStaging(staging);
  backendLog(`待确认队列：+${added} 条，重复跳过 ${duplicate} 条，现有 ${staging.items.length} 条`);
  return { added, duplicate, total: staging.items.length };
}

function listStaging() {
  const staging = readStaging();
  return { ok: true, count: staging.items.length, items: staging.items };
}

/** 主人点「入库」：真正写入档案，被拒的条目退回队列不丢。 */
function acceptStaging(ids) {
  const staging = readStaging();
  const want = Array.isArray(ids) ? ids.map((x) => String(x)) : [];
  const picked = want.length ? staging.items.filter((e) => want.includes(String(e.sid))) : staging.items.slice();
  const missing = want.filter((w) => !staging.items.some((e) => String(e.sid) === w));
  if (want.length && !picked.length) {
    return {
      ok: false, accepted: 0, pending: staging.items.length, missing,
      error: `队列里没有编号 ${missing.join('、')} 的条目，可能已被入库或丢弃了，刷新一下面板再看`,
    };
  }
  if (!picked.length) return { ok: true, accepted: 0, pending: staging.items.length, note: '没有待确认条目' };
  const result = importEntries(picked, 'append', { direct: true });
  if (!result.added) {
    return { ok: false, accepted: 0, pending: staging.items.length, missing, error: result.error || '写入档案失败' };
  }
  let rest = want.length ? staging.items.filter((e) => !want.includes(String(e.sid))) : [];
  if (result.rejected?.length) {
    const badTitles = new Set(result.rejected.map((r) => String(r.title || '')));
    for (const item of picked) if (badTitles.has(String(item.title))) rest.push(item);
  }
  staging.items = rest;
  writeStaging(staging);
  backendLog(`待确认入库：+${result.added} 条，队列剩 ${rest.length} 条`);
  const out = { ok: true, accepted: result.added, pending: rest.length, rejected: (result.rejected || []).slice(0, 5) };
  if (missing.length) out.missing = missing;
  return out;
}

function rejectStaging(ids) {
  const staging = readStaging();
  const want = Array.isArray(ids) ? ids.map((x) => String(x)) : [];
  const before = staging.items.length;
  const missing = want.filter((w) => !staging.items.some((e) => String(e.sid) === w));
  if (want.length && before === staging.items.filter((e) => !want.includes(String(e.sid))).length) {
    return {
      ok: false, rejected: 0, pending: before, missing,
      error: `队列里没有编号 ${missing.join('、')} 的条目，可能已被入库或丢弃了，刷新一下面板再看`,
    };
  }
  staging.items = want.length ? staging.items.filter((e) => !want.includes(String(e.sid))) : [];
  writeStaging(staging);
  backendLog(`待确认丢弃：${before - staging.items.length} 条，队列剩 ${staging.items.length} 条`);
  return { ok: true, rejected: before - staging.items.length, pending: staging.items.length };
}

/** 批量导入：聊天里的 manage 与网页面板共用一套校验。 */
function importEntries(rawList, mode = 'append', options = {}) {
  const conf = settings();
  const store = readStore();
  const replace = String(mode) === 'replace';
  const base = replace ? [] : store.entries.slice();
  const accepted = [];
  const rejected = [];
  for (const item of Array.isArray(rawList) ? rawList : []) {
    const title = norm(item?.title);
    const text = String(item?.text ?? '').trim();
    if (!title) { rejected.push({ title: '', why: 'title 为空' }); continue; }
    if (!text) { rejected.push({ title, why: 'text 为空' }); continue; }
    if (text.length > conf.maxEntryChars) {
      rejected.push({ title, why: `正文 ${text.length} 字，超过单条上限 ${conf.maxEntryChars}` });
      continue;
    }
    if (base.length + accepted.length >= conf.maxEntries) {
      rejected.push({ title, why: `超出条目上限 ${conf.maxEntries}` });
      continue;
    }
    accepted.push({
      category: String(item?.category ?? '').trim() || '人设背景',
      title,
      text,
      keywords: parseKeywords(item?.keywords),
      source: normSource(item?.source),
      at: Date.now(),
    });
  }
  if (!accepted.length) {
    return { added: 0, rejected, total: base.length, error: rejected[0]?.why || '没有可写入的条目' };
  }
  // 默认不落盘：先进待确认队列，等主人签字（面板里逐条 ✓/✗）
  if (options.direct !== true) {
    const staged = addToStaging(accepted, mode);
    return {
      added: 0, staged: staged.added, duplicate: staged.duplicate,
      rejected, total: base.length, pending: staged.total, stagedOnly: true,
    };
  }
  let seq = 0;
  for (const e of base) {
    const x = parseInt(e.id, 10);
    if (Number.isFinite(x)) seq = Math.max(seq, x);
  }
  for (const item of accepted) {
    seq += 1;
    base.push({ id: String(seq), ...item });
  }
  store.entries = base;
  try { createStoreBackup('导入前自动备份'); } catch (error) {
    backendLog(`导入前备份失败：${error?.message || error}`);
  }
  writeStore(store);
  backendLog(`批量导入：写入 ${accepted.length} 条，跳过 ${rejected.length} 条（mode=${replace ? 'replace' : 'append'}）`);
  return { added: accepted.length, rejected, total: base.length };
}

// ─────────────────────────────────────────────── 检索打分
function splitTerms(q) {
  return norm(q).split(/[\s,，；;、]+/).filter(Boolean);
}

/**
 * 中文相邻二元组：整词没命中时做模糊匹配。
 * 短英文/数字整体作为一个词，不拆二元组。
 */
function bigrams(term) {
  if (/^[a-z0-9._-]+$/.test(term)) return [term];
  const out = [];
  for (let i = 0; i < term.length - 1; i += 1) {
    const bg = term.slice(i, i + 2);
    if (/[\u4e00-\u9fff]{2}/.test(bg)) out.push(bg);
  }
  return out;
}

function scoreEntry(entry, terms) {
  const title = norm(entry.title);
  const category = norm(entry.category);
  const text = norm(entry.text);
  const kws = (Array.isArray(entry.keywords) ? entry.keywords : []).map(norm);
  let score = 0;
  let strongTerms = 0;
  const hits = [];

  for (const t of terms) {
    let best = 0;
    if (kws.some((k) => k === t)) best = Math.max(best, 5);
    if (kws.some((k) => k.includes(t))) best = Math.max(best, 2);
    if (title.includes(t)) best = Math.max(best, 4);
    if (category.includes(t)) best = Math.max(best, 2);
    if (text.includes(t)) best = Math.max(best, 3);
    if (best) {
      score += best;
      hits.push(t);
      // 只有标题/关键词命中，或长词（≥4 字）命中正文，才算"强证据"，
      // 免得「大学生日常感」里恰好连着「生日」两个字这种巧合把不相关的条目捞出来。
      if (best >= 4 || (best === 3 && t.length >= 4)) strongTerms += 1;
      continue;
    }

    let bgHits = 0;
    for (const bg of bigrams(t)) {
      if (title.includes(bg) || text.includes(bg) || kws.some((k) => k.includes(bg))) bgHits += 1;
    }
    if (bgHits) {
      score += Math.min(3, bgHits);
      hits.push(`${t}~`);
      if (bgHits >= 2) strongTerms += 1;
    }
  }
  return { score, hits, strongTerms };
}

// ─────────────────────────────────────────────── 借阅台账（主人能看出模型查了什么、哪些查空了）
const QUERY_LOG_MAX = 100;

function queryLogPath() {
  return path.join(paths().dir, 'query-log.json');
}

function readQueryLog() {
  const empty = { version: 1, items: [] };
  try {
    const file = queryLogPath();
    if (!fs.existsSync(file)) return empty;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, items: Array.isArray(raw?.items) ? raw.items : [] };
  } catch { return empty; }
}

function logQuery(entry) {
  try {
    const log = readQueryLog();
    log.items.unshift(entry);
    if (log.items.length > QUERY_LOG_MAX) log.items = log.items.slice(0, QUERY_LOG_MAX);
    fs.mkdirSync(paths().dir, { recursive: true });
    fs.writeFileSync(queryLogPath(), `${JSON.stringify(log, null, 2)}\n`, 'utf8');
  } catch (error) {
    backendLog(`查询台账写入失败：${error?.message || error}`);
  }
}

function queryStats(limit = 20) {
  const log = readQueryLog();
  const n = Math.max(1, Math.min(100, Number(limit) || 20));
  const emptyCount = new Map();
  let emptyTotal = 0;
  for (const it of log.items) {
    if (it.count === 0) {
      emptyTotal += 1;
      emptyCount.set(it.query, (emptyCount.get(it.query) || 0) + 1);
    }
  }
  const topEmpty = [...emptyCount.entries()]
    .map(([query, times]) => ({ query, times }))
    .sort((a, b) => b.times - a.times)
    .slice(0, 8);
  return { total: log.items.length, emptyTotal, items: log.items.slice(0, n), topEmpty };
}

// ─────────────────────────────────────────────── 工具一：查询（模型可随时调）
async function queryDetail(ctx, args, opts) {
  const q = norm(args?.query);
  if (!q) return errorResult('query 不能为空，写具体名词');

  const conf = settings();
  const store = readStore();
  let entries = store.entries;

  const cat = norm(args?.category);
  if (cat) entries = entries.filter((e) => norm(e.category) === cat);

  const terms = splitTerms(q);
  const scored = entries
    .map((e) => ({ e, ...scoreEntry(e, terms) }))
    // 弱命中（只在正文里撞上短词）不算数，否则问「生日」会把「大学生日常感」那条捞出来
    .filter((x) => x.score > 0 && (x.strongTerms > 0 || x.score >= 6))
    .sort((a, b) => b.score - a.score);

  const lx = Number(args?.limit);
  const limit = Number.isFinite(lx) ? Math.min(10, Math.max(1, lx)) : conf.maxResults;
  // 相对阈值：只借跟最佳命中同量级的书，勉强沾边的留在架子上
  const bestScore = scored.length ? scored[0].score : 0;
  const floor = Math.max(4, Math.round(bestScore * 0.5));
  const top = scored.filter((x, i) => i === 0 || x.score >= floor).slice(0, limit);
  const storeCount = store.entries.length;

  // 每次返回都带使用说明：图书馆只借一页，不是把整本书倒出来
  const HOW_TO_USE = '只用自己的口吻说一两句，别念条目、别列清单、别把整条读出来，也别提「档案/设定/资料库」这些词；查一次不够可以换词再查。';
  const TEXT_CAP = 160;

  let result;
  if (!top.length) {
    result = storeCount
      ? {
        query: q,
        count: 0,
        nothing: true,
        hint: '档案里没有这条。用角色自己的口气搪塞过去（「这事儿我哪记得」「你听谁说的」），不许编，也别对主人说「我的档案里没有」「我没这个设定」——那出戏。',
      }
      : {
        query: q,
        count: 0,
        nothing: true,
        hint: '档案还是空的（0 条），可能是刚装好的环境。这一轮先用角色自己的口气说记不清；有机会就提醒主人一句「让我整理一下我的人设细节」，那会走引导流程（bootstrap_persona_detail）。',
      };
  } else {
    result = {
      query: q,
      count: top.length,
      hint: HOW_TO_USE,
      entries: top.map((x) => {
        const full = String(x.e.text || '');
        const cut = full.length > TEXT_CAP;
        return {
          id: x.e.id,
          category: x.e.category,
          title: x.e.title,
          text: cut ? full.slice(0, TEXT_CAP) : full,
          ...(cut ? { truncated: true } : {}),
          keywords: x.e.keywords || [],
          ...(x.e.source ? { source: x.e.source } : {}),
          ...(x.e.source === '推断' ? { note: '这条是推测出来的，不是确定事实，说的时候带「好像是」「大概」' } : {}),
        };
      }),
    };
  }

  if (!opts?.silent) {
    logQuery({
      at: Date.now(),
      query: q,
      category: cat || '',
      count: result.count || 0,
      ids: (result.entries || []).map((e) => e.id),
      empty: !!result.nothing,
      chat: String(ctx?.chatKey || ctx?.sessionKey || ''),
    });
  }
  return result;
}

// ─────────────────────────────────────────────── 管理员识别
function parseQqList(s) {
  return String(s || '').split(/[,，;；\s]+/).map((x) => x.trim()).filter(Boolean);
}

// 工具 ctx 里没有发送者 QQ，照 persona-self-edit 的成熟做法：
// before-context 钩子把本轮触发者按会话缓存（30 分钟 TTL）。
const senderCache = new Map();

function isAdmin(chatKey) {
  const admins = parseQqList(settings().adminQq);
  if (!admins.length) return { ok: false, why: '未配置管理员 QQ 号' };
  const c = senderCache.get(String(chatKey));
  if (!c) return { ok: false, why: '无法确认发送者身份，请重新发一条' };
  const hit = [...c.ids].some((id) => admins.includes(id));
  return hit ? { ok: true, why: '' } : { ok: false, why: '只有管理员能管理细节档案' };
}

function nextId(entries) {
  let max = 0;
  for (const e of entries) {
    const x = parseInt(e.id, 10);
    if (Number.isFinite(x)) max = Math.max(max, x);
  }
  return String(max + 1);
}

function parseKeywords(s) {
  return [...new Set(parseQqList(s))].slice(0, 10);
}

// ─────────────────────────────────────────────── 工具二：管理（管理员专用）
async function manageDetail(ctx, args) {
  const chatKey = String(ctx?.chatKey || '');
  const adm = isAdmin(chatKey);
  if (!adm.ok) return errorResult(adm.why);

  const action = String(args?.action || '').trim();
  const conf = settings();
  const store = readStore();

  if (action === 'list') {
    return {
      count: store.entries.length,
      entries: store.entries.map((e) => ({ id: e.id, category: e.category, title: e.title })),
    };
  }

  // 批量导入：给自举（整理人设后一次写入）与网页面板用。entries 可传数组或 JSON 字符串。
  if (action === 'import') {
    let list = args?.entries;
    if (typeof list === 'string') {
      try { list = JSON.parse(list); } catch { return errorResult('entries 是字符串但不是合法 JSON'); }
    }
    if (!Array.isArray(list) || !list.length) return errorResult('entries 必须是非空数组');
    const result = importEntries(list, args?.mode, { direct: args?.direct === true });
    if (result.error) return errorResult(`一条都没写入：${result.error}`);
    if (result.stagedOnly) {
      return {
        done: true,
        action: 'import',
        staged: result.staged,
        duplicate: result.duplicate,
        pending: result.pending,
        rejected: result.rejected.slice(0, 5),
        note: '已放进待确认队列，还没有进档案。请主人在面板「待确认」区块逐条确认后才真正入库（面板地址见技能设置里的 storeDir 说明）。主人明确说「直接写进去」时可以加 direct=true 跳过这一步。',
      };
    }
    return {
      done: true,
      action: 'import',
      added: result.added,
      rejected: result.rejected.slice(0, 5),
      total: result.total,
      note: '已写入细节档案，下一轮查询可取',
    };
  }

  if (action === 'add' || action === 'replace') {
    const category = norm(args?.category) || '未分类';
    const title = norm(args?.title);
    const text = norm(args?.text);
    if (!title) return errorResult('title 不能为空');
    if (!text) return errorResult('text 不能为空');
    if (text.length > conf.maxEntryChars) {
      return errorResult(`正文 ${text.length} 字，超过上限 ${conf.maxEntryChars}，拆短或拆成多条`);
    }
    const keywords = parseKeywords(args?.keywords);

    if (action === 'add') {
      if (store.entries.length >= conf.maxEntries) {
        return errorResult(`档案已满 ${conf.maxEntries} 条，先删旧条目`);
      }
      const entry = { id: nextId(store.entries), category, title, text, keywords, source: normSource(args?.source), at: Date.now() };
      store.entries.push(entry);
      writeStore(store);
      backendLog(`新增 #${entry.id}【${category}】${title}`);
      return { done: true, action: 'add', id: entry.id, note: '已存入细节档案，下一轮查询可取' };
    }

    const id = String(args?.id || '').trim();
    const idx = store.entries.findIndex((e) => String(e.id) === id);
    if (idx < 0) return errorResult(`找不到 id=${id}，先 list 确认`);
    const prev = store.entries[idx];
    store.entries[idx] = {
      ...prev, category, title, text, keywords, at: Date.now(),
      source: args?.source ? normSource(args.source) : prev.source,
    };
    writeStore(store);
    backendLog(`改 #${id}：${title}`);
    return { done: true, action: 'replace', id };
  }

  if (action === 'remove') {
    const id = String(args?.id || '').trim();
    if (!id) return errorResult('remove 需要 id');
    const idx = store.entries.findIndex((e) => String(e.id) === id);
    if (idx < 0) return errorResult(`找不到 id=${id}`);
    const [removed] = store.entries.splice(idx, 1);
    writeStore(store);
    backendLog(`删除 #${id}：${removed.title}`);
    return { done: true, action: 'remove', id };
  }

  return errorResult(`不认的 action：${action}（add/replace/remove/import/list）`);
}

// ─────────────────────────────────────────────── 工具三：自举（管理员专用）
/**
 * "第一步：调用模型整理人设"的落点。
 * Skill 自己发不了模型请求（只有 registerTool 能进 tools 列表），所以这一步做成
 * 一个管理员可触发的工具：模型调到它以后拿到角色卡全文和拆分规则，再由模型
 * 自己整理，最后用 manage_persona_detail action=import 一次写入。
 */
async function bootstrapDetail(ctx) {
  const chatKey = String(ctx?.chatKey || '');
  const adm = isAdmin(chatKey);
  if (!adm.ok) return errorResult(adm.why);

  const conf = settings();
  const store = readStore();
  const text = roleText();
  if (!text) {
    return errorResult('角色卡是空的：先让主人在设置页「人设 → 角色设定」写人物设定，再来整理。');
  }

  const cats = [...new Set(store.entries.map((e) => String(e.category || '')).filter(Boolean))];
  const chars = store.entries.reduce((sum, e) => sum + String(e.text || '').length, 0);

  // 整理会改动档案；先把当前人设存一份带时间戳的备份，退得回去
  let backedUp = null;
  try { backedUp = createPersonaBackup('整理人设前自动备份'); } catch (error) {
    backendLog(`整理前备份失败：${error?.message || error}`);
  }

  return {
    step: 1,
    task: '把角色卡里「被问到才用」的事实拆成档案条目',
    roleText: text,
    roleTextChars: text.length,
    backup: backedUp ? { file: backedUp.file, atText: backedUp.atText, roleTextChars: backedUp.roleTextChars } : null,
    existing: {
      count: store.entries.length,
      chars,
      categories: cats,
      file: paths().storeFile,
    },
    keepInRoleText: [
      '说话风格、行为准则、性格、喜好倾向、输出规范 —— 这些每轮都要用，留在角色卡',
    ],
    moveToArchive: [
      '外形长相：发型、五官、耳饰、尾巴、穿搭、随身物品',
      '家世与家人：爸妈弟弟、谁护着谁、家里的小动物',
      '原型 / 种族 / 生日 / 字号来历',
      '经历与来历：出身、学业、转生化形的经过',
      '外号与梗的出处、群里的黑话',
      '习惯、小癖好、口头禅的来源',
    ],
    rules: [
      '一条只讲一件事；标题 2-8 字',
      `正文用自己的口吻写，单条不超过 ${conf.maxEntryChars} 字，超了就拆两条`,
      'keywords 给 3-8 个具体名词，方便以后命中（如 生日、4月12日、蓝鲸）',
      '分类沿用现有：' + (cats.join('、') || '人设背景、家庭信息、性格喜好、习惯技能、外号与梗、外形外貌'),
      '角色卡原文别整段抄，要拆成事实；重复的先 list 查重，再 replace 按 id 改',
      '每条必须带 source：直接从角色卡拆的填 roleText，聊天记录里有的填 chat，自己推出来的填 inferred',
      'source=inferred 的条目最多 3 条，只放「从原话能推出来的倾向」，不许编新事实；主人没确认过的一律算 inferred',
    ],
    next: '整理好后调 manage_persona_detail action=import，entries 传数组（每项 {category,title,text,keywords,source}），mode=append 追加 / replace 覆盖。写进去的先进待确认队列，主人在面板逐条确认后才入档；主人明确说「直接入库」时才加 direct=true',
    pending: readStaging().items.length,
    hint: store.entries.length
      ? `档案已有 ${store.entries.length} 条，本次按增量补，别重复建同义条目`
      : '档案还是空的，本次就是初始化；写完用 query 抽查几条确认命中',
    targetCount: `建议 ${Math.min(conf.maxEntries, Math.max(8, Math.round(text.length / 40)))} 条左右，每条 40-120 字`,
  };
}

// ─────────────────────────────────────────────── 主人调试面板（自带 HTTP 路由）
function uiHtml() {
  try {
    return fs.readFileSync(new URL('./admin.html', import.meta.url), 'utf8');
  } catch (error) {
    return `<pre style="padding:20px;color:#e05555">管理页 admin.html 读取失败：${String(error?.message || error)}</pre>`;
  }
}

function registerHttpRoutes() {
  if (!api || typeof api.registerPluginRoutes !== 'function') return;

  const routes = [
    {
      method: 'GET',
      pattern: '/api/persona-detail/ui',
      handler: ({ res }) => {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(uiHtml());
      },
    },
    {
      method: 'GET',
      pattern: '/api/persona-detail/entries',
      handler: ({ res }) => api.json(res, 200, snapshot()),
    },
    {
      method: 'POST',
      pattern: '/api/persona-detail/entries',
      handler: async ({ req, res }) => {
        try {
          const body = await api.readBody(req);
          const conf = settings();
          const store = readStore();
          const title = String(body?.title ?? '').trim();
          const text = String(body?.text ?? '').trim();
          const category = String(body?.category ?? '').trim() || '人设背景';
          if (!title) throw new Error('标题不能为空');
          if (!text) throw new Error('正文不能为空');
          if (text.length > conf.maxEntryChars) {
            throw new Error(`正文 ${text.length} 字，超过单条上限 ${conf.maxEntryChars}`);
          }
          const keywords = parseKeywords(body?.keywords);
          const id = String(body?.id ?? '').trim();
          if (id) {
            const idx = store.entries.findIndex((e) => String(e.id) === id);
            if (idx < 0) throw new Error(`找不到 id=${id}，刷新后重试`);
            const prev = store.entries[idx];
            store.entries[idx] = { ...prev, category, title, text, keywords, at: Date.now(), source: body?.source ? normSource(body.source) : prev.source };
            writeStore(store);
            backendLog(`[面板] 改 #${id}：${title}`);
            return api.json(res, 200, { ok: true, id });
          }
          if (store.entries.length >= conf.maxEntries) {
            throw new Error(`档案已满 ${conf.maxEntries} 条，先删旧条目`);
          }
          const newId = nextId(store.entries);
          store.entries.push({ id: newId, category, title, text, keywords, source: normSource(body?.source), at: Date.now() });
          writeStore(store);
          backendLog(`[面板] 新增 #${newId}：${title}`);
          return api.json(res, 200, { ok: true, id: newId });
        } catch (error) {
          return api.json(res, 400, { ok: false, error: String(error?.message || '保存失败') });
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/persona-detail/delete',
      handler: async ({ req, res }) => {
        try {
          const body = await api.readBody(req);
          const id = String(body?.id ?? '').trim();
          if (!id) throw new Error('缺少 id');
          const store = readStore();
          const idx = store.entries.findIndex((e) => String(e.id) === id);
          if (idx < 0) throw new Error(`找不到 id=${id}`);
          const [removed] = store.entries.splice(idx, 1);
          try { createStoreBackup('删除条目前自动备份'); } catch (error) {
            backendLog(`删除前备份失败：${error?.message || error}`);
          }
          writeStore(store);
          backendLog(`[面板] 删除 #${id}：${removed.title}`);
          return api.json(res, 200, { ok: true, id, title: removed.title });
        } catch (error) {
          return api.json(res, 400, { ok: false, error: String(error?.message || '删除失败') });
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/persona-detail/import',
      handler: async ({ req, res }) => {
        try {
          const body = await api.readBody(req);
          const result = importEntries(body?.entries, body?.mode, { direct: body?.direct !== false });
          if (result.error) return api.json(res, 400, { ok: false, ...result });
          return api.json(res, 200, { ok: true, ...result });
        } catch (error) {
          return api.json(res, 400, { ok: false, error: String(error?.message || '导入失败') });
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/persona-detail/staging',
      handler: ({ res }) => api.json(res, 200, listStaging()),
    },
    {
      method: 'POST',
      pattern: '/api/persona-detail/staging',
      handler: async ({ req, res }) => {
        try {
          const body = await api.readBody(req);
          const action = String(body?.action || 'accept');
          const ids = Array.isArray(body?.ids) ? body.ids : undefined;
          if (action === 'reject') {
            const rej = rejectStaging(ids);
            return api.json(res, rej.ok ? 200 : 400, rej);
          }
          const result = acceptStaging(ids);
          return api.json(res, result.ok ? 200 : 400, result);
        } catch (error) {
          return api.json(res, 400, { ok: false, error: String(error?.message || '待确认操作失败') });
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/persona-detail/export',
      handler: ({ res }) => {
        const { storeFile } = paths();
        let text = '';
        try { text = fs.readFileSync(storeFile, 'utf8'); } catch { /* 没有就导出空骨架 */ }
        if (!text) text = JSON.stringify({ version: 1, entries: [] }, null, 2);
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'content-disposition': 'attachment; filename="store.json"',
          'cache-control': 'no-cache',
        });
        res.end(text);
      },
    },
    {
      method: 'GET',
      pattern: '/api/persona-detail/backups',
      handler: ({ res }) => api.json(res, 200, listBackups()),
    },
    {
      method: 'POST',
      pattern: '/api/persona-detail/backups',
      handler: async ({ req, res }) => {
        try {
          const body = await api.readBody(req);
          const type = String(body?.type || 'persona');
          const reason = String(body?.reason || '面板手动备份');
          if (type === 'store') return api.json(res, 200, { ok: true, type, ...createStoreBackup(reason) });
          return api.json(res, 200, { ok: true, type: 'persona', ...createPersonaBackup(reason) });
        } catch (error) {
          return api.json(res, 500, { ok: false, error: String(error?.message || '备份失败') });
        }
      },
    },
    {
      method: 'POST',
      pattern: '/api/persona-detail/restore',
      handler: async ({ req, res }) => {
        try {
          const body = await api.readBody(req);
          const type = String(body?.type || 'persona');
          const result = type === 'store' ? restoreStoreBackup(body?.file) : restorePersonaBackup(body?.file);
          return api.json(res, 200, result);
        } catch (error) {
          return api.json(res, 400, { ok: false, error: String(error?.message || '回退失败') });
        }
      },
    },
    {
      method: 'GET',
      pattern: '/api/persona-detail/queries',
      handler: ({ req, res }) => {
        const u = new URL(String(req?.url || '/'), 'http://localhost');
        return api.json(res, 200, queryStats(u.searchParams.get('limit') || 20));
      },
    },
    {
      method: 'GET',
      pattern: '/api/persona-detail/simulate',
      handler: async ({ req, res }) => {
        try {
          const u = new URL(String(req?.url || '/'), 'http://localhost');
          const raw = String(u.searchParams.get('q') || '').trim();
          if (!raw) return api.json(res, 400, { ok: false, error: 'q 不能为空' });
          const cat = u.searchParams.get('category') || undefined;
          // 主人手输的常是整句，先剔停用词拆成名词再查（跟模型传名词的口径对齐）
          const STOP = /(请问|帮我|我想知道|你|我|他|她|它|的|是|有|吗|呢|吧|啊|呀|几号|几岁|什么|多少|哪儿|哪里|哪个|怎么|怎样|还|会|能|了|在|跟|给|说|讲|一下|一个|记得|知道|叫啥|叫什么|哪)/g;
          const parts = raw
            .replace(STOP, ' ')
            .replace(/[，。？！、,.?!；;：:]/g, ' ')
            .split(/[\s]+/)
            .filter((x) => x.length >= 1)
            .slice(0, 4);
          const queries = parts.length ? parts : [raw];
          let merged = { query: raw, count: 0, used: queries, entries: [], hint: '' };
          for (const q of queries) {
            const r = await queryDetail({}, { query: q, category: cat }, { silent: true });
            if (r.entries?.length) {
              merged.hint = r.hint;
              for (const e of r.entries) {
                if (!merged.entries.some((x) => String(x.id) === String(e.id))) merged.entries.push(e);
              }
            } else if (!merged.hint) {
              merged.hint = r.hint;
            }
          }
          merged.count = merged.entries.length;
          if (!merged.count) merged.nothing = true;
          return api.json(res, 200, { ok: true, ...merged });
        } catch (error) {
          return api.json(res, 400, { ok: false, error: String(error?.message || '模拟失败') });
        }
      },
    },
  ];

  const result = api.registerPluginRoutes(SKILL_ID, routes);
  backendLog(`管理面板已注册 ${result?.registered ?? 0} 条路由：/api/persona-detail/ui`);
}

// ─────────────────────────────────────────────── 工具定义
const QUERY_TOOL = {
  id: 'query_persona_detail',
  name: 'query_persona_detail',
  category: 'knowledge',
  description: '查询「人设细节档案」——角色卡里没有的细节：外形长相、详细背景、家人、习惯、经历、生日、外号、群里的说法与梗。默认不主动用：只有被问到，或聊天里出现的人/物/时间/经历/称呼/说法/梗，角色卡确实没写时才调。角色卡已写明的（姓名、身份、性格规则、喜好、禁令）不用查。query 只写具体名词（多个空格分开），可填 category 限分类。结果自带用法：只用角色口吻说一两句，别念条目、别列清单；查不到就用角色口气搪塞，绝不提「档案/设定/资料库」。',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要查的具体名词，如「头发 围裙」「弟弟 小皇子」「生日」「鲸币」；别用整句和泛词' },
      category: { type: 'string', description: '可选：限定分类，如 人设背景/家庭信息/外形外貌/性格喜好/习惯技能/外号与梗/群内黑话' },
      limit: { type: 'number', description: '可选：返回条数，默认按技能设置' },
    },
    required: ['query'],
  },
  execute: queryDetail,
};

const MANAGE_TOOL = {
  id: 'manage_persona_detail',
  name: 'manage_persona_detail',
  category: 'system',
  description: '管理员专用：管理「人设细节档案」。action=list 看全部条目编号；add 新增（category/title/text/keywords/source）；replace 改条目（需 id）；remove 删条目（需 id）；import 批量写入（entries 传数组或 JSON 字符串，mode=append/replace）。每条都建议带 source（roleText / chat / inferred）。注意 import 默认只进待确认队列、不直接落盘，主人在面板逐条确认后才生效；主人明确说「直接写进去」时才加 direct=true。非管理员调用会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'replace', 'remove', 'import', 'list'], description: '管理动作' },
      id: { type: 'string', description: 'replace/remove 时的条目编号' },
      category: { type: 'string', description: 'add/replace 的分类' },
      title: { type: 'string', description: 'add/replace 的条目标题' },
      text: { type: 'string', description: 'add/replace 的条目正文' },
      keywords: { type: 'string', description: '可选：关键词，逗号或空格分隔，最多 10 个' },
      entries: {
        type: 'array',
        description: 'import 用：条目数组，每项 {category, title, text, keywords}',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', description: '分类，默认人设背景' },
            title: { type: 'string', description: '标题，2-8 字' },
            text: { type: 'string', description: '正文，单条不超过设置上限' },
            keywords: { type: 'string', description: '关键词，逗号或空格分隔' },
          },
          required: ['title', 'text'],
        },
      },
      mode: { type: 'string', enum: ['append', 'replace'], description: 'import 用：append 追加（默认）/ replace 覆盖全部' },
    },
    required: ['action'],
  },
  execute: manageDetail,
};

const BOOTSTRAP_TOOL = {
  id: 'bootstrap_persona_detail',
  name: 'bootstrap_persona_detail',
  category: 'system',
  description: '管理员专用：首次安装、档案被清空、或要从头整理人设时先调这个。返回角色卡全文 + 该拆什么/该留什么 + 现有分类，按规则整理成条目后，用 manage_persona_detail action=import 批量写入。非管理员调用会被拒绝。',
  parameters: {
    type: 'object',
    properties: {
      focus: { type: 'string', description: '可选：只整理某一块，如「外形」「家人」「生日」' },
    },
    required: [],
  },
  execute: bootstrapDetail,
};

// ─────────────────────────────────────────────── 钩子：缓存本轮触发者
export const hooks = {
  'before-context': ({ chatKey, triggerEntries } = {}) => {
    try {
      if (!chatKey) return;
      const ids = new Set();
      for (const e of triggerEntries || []) {
        const sid = String(e?.senderId ?? '').trim();
        if (sid && !e?.self) ids.add(sid);
      }
      if (ids.size) senderCache.set(String(chatKey), { ids, at: Date.now() });
      const now = Date.now();
      for (const [k, v] of senderCache) {
        if (now - v.at > 30 * 60 * 1000) senderCache.delete(k);
      }
    } catch { /* 钩子失败不影响功能 */ }
  },
};

export function setup(skillApi) {
  api = skillApi;
  const boot = ensureStore();          // 第二步：装好就把档案文件建出来，别等第一次写入
  api.registerTool(QUERY_TOOL);
  api.registerTool(MANAGE_TOOL);
  api.registerTool(BOOTSTRAP_TOOL);    // 第一步：管理员触发，模型读角色卡整理
  registerHttpRoutes();                // 主人主动调试面板
  backendLog('人设细节库已加载：细节按需查询，不进角色卡正文');
  backendLog(`存档：${boot.file}${boot.created ? '（本次新建空档案）' : ''}`);
}

// 测试/排障用：不经过 setup 也能直接驱动各环节
export const internals = {
  queryDetail, manageDetail, bootstrapDetail, scoreEntry, readStore, writeStore, isAdmin, senderCache, settings,
  ensureStore, snapshot, importEntries,
  createPersonaBackup, createStoreBackup, listBackups, restorePersonaBackup, restoreStoreBackup,
  readStaging, addToStaging, listStaging, acceptStaging, rejectStaging, normSource,
  readQueryLog, queryStats, queryLogPath,
  registerHttpRoutes,
  setApi: (a) => { api = a; },
};
