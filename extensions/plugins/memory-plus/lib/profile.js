/**
 * 档案层（profile-v1）：一人一份，按 QQ 号跨会话合并。
 *
 * 与旧的「按会话 store」并存：旧 store 继续管短期/标签/面板，
 * 这里只管长期档案 —— 人物画像、个性标签、长期记忆（外加事件卡与候选层，不进提示词）。
 *
 * 文件：<profilesDir>/<uid>.json
 */
import fs from 'node:fs';
import path from 'node:path';

const CACHE = new Map();          // uid -> { mtimeMs, data }
const SENSITIVE = ['黄油', '黄游', '小黄游', '成人游戏', '隆胸', '黄图', '色情', '本子', '约炮', '裸聊'];
const MAX_CACHE = 400;

export const DEFAULT_DIR = 'D:\\QQAgent\\记忆\\profiles';

export function profileDir(dir) {
  const d = String(dir || '').trim();
  return d || DEFAULT_DIR;
}

function isSensitive(text) {
  const t = String(text || '');
  return SENSITIVE.some((k) => t.includes(k));
}

function bigrams(s) {
  const t = String(s || '').replace(/\s+/g, '');
  if (t.length < 2) return t ? new Set([t]) : new Set();
  const out = new Set();
  for (let i = 0; i < t.length - 1; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

export function sim(a, b) {
  const A = bigrams(a); const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const g of A) if (B.has(g)) n += 1;
  return n / (A.size + B.size - n);
}

function uidOf(uid) {
  return String(uid ?? '').replace(/\D/g, '');
}

function nowMs() {
  return Date.now();
}

function emptyProfile(uid) {
  return {
    schema: 'profile-v1', userId: String(uid), name: String(uid), aliases: [String(uid)],
    scopes: [], updatedAt: nowMs(), persona: { traits: [], tags: [] },
    longTerm: [], state: [], candidates: [], events: [], audit: []
  };
}

export function readProfile(dir, uid) {
  const u = uidOf(uid);
  if (!u) return null;
  const file = path.join(profileDir(dir), `${u}.json`);
  try {
    const st = fs.statSync(file);
    const hit = CACHE.get(u);
    if (hit && hit.mtimeMs === st.mtimeMs) return hit.data;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    CACHE.set(u, { mtimeMs: st.mtimeMs, data });
    if (CACHE.size > MAX_CACHE) CACHE.delete(CACHE.keys().next().value);
    return data;
  } catch {
    return null;
  }
}

export function listProfiles(dir) {
  const d = profileDir(dir);
  try {
    return fs.readdirSync(d).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
      .map((f) => readProfile(d, f.slice(0, -5))).filter(Boolean);
  } catch {
    return [];
  }
}

export function writeProfile(dir, data) {
  const d = profileDir(dir);
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* 已存在 */ }
  const file = path.join(d, `${data.userId}.json`);
  const tmp = `${file}.tmp${nowMs()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
  try {
    const st = fs.statSync(file);
    CACHE.set(String(data.userId), { mtimeMs: st.mtimeMs, data });
  } catch { CACHE.delete(String(data.userId)); }
  return file;
}

function touch(data, chatKey) {
  data.updatedAt = nowMs();
  const ck = String(chatKey || '');
  if (ck && Array.isArray(data.scopes) && !data.scopes.includes(ck)) data.scopes.push(ck);
}

function audit(data, op, target, detail) {
  data.audit = Array.isArray(data.audit) ? data.audit : [];
  data.audit.unshift({ at: nowMs(), op, target: String(target || ''), detail: String(detail || '').slice(0, 200) });
  data.audit = data.audit.slice(0, 50);
}

/**
 * 上游提取到一条观察 -> 进候选层（同义合并，累加 hits）。
 * 命中已稳定的长期/画像 -> 只加 hits，不新增。
 * 返回 { status: 'duplicate'|'candidate'|'promoted' }
 */
export function ingestObservation(dir, uid, chatKey, { content, kind = 'general', confidence = 60, name = '', evidence = '', minHits = 3 } = {}) {
  const u = uidOf(uid);
  const text = String(content || '').trim();
  if (!u || !text) return { status: 'skip' };
  const data = readProfile(dir, u) || emptyProfile(u);
  if (name && String(name).trim() && String(name).trim() !== u) {
    if (!data.aliases.includes(String(name).trim())) data.aliases.push(String(name).trim());
  }
  touch(data, chatKey);
  const conf = Number(confidence) || 60;

  const hitLong = data.longTerm.find((it) => it.text === text || sim(it.text, text) >= 0.78);
  if (hitLong) {
    hitLong.hits = (hitLong.hits || 1) + 1;
    hitLong.lastVerified = nowMs();
    if (conf > (hitLong.confidence || 0)) hitLong.confidence = conf;
    audit(data, 'hit', 'longTerm', text.slice(0, 60));
    writeProfile(dir, data);
    return { status: 'duplicate', id: hitLong.id };
  }

  const hitCand = data.candidates.find((it) => it.text === text || sim(it.text, text) >= 0.78);
  if (hitCand) {
    hitCand.hits = (hitCand.hits || 1) + 1;
    hitCand.lastSeen = nowMs();
    hitCand.kind = kind || hitCand.kind;
    hitCand.confidence = Math.max(Number(hitCand.confidence) || 0, conf);
  } else {
    data.candidates.push({
      id: `cd_${Math.random().toString(36).slice(2, 10)}`, text, kind,
      confidence: conf, hits: 1, createdAt: nowMs(), lastSeen: nowMs(), evidence: evidence || ''
    });
  }
  const cand = data.candidates.find((it) => it.text === text || sim(it.text, text) >= 0.78);
  // 转正门槛：同一件事被提到 minHits 次（默认 3）才变长期；约定类带时刻，单次就收，不等重复。
  const min = Math.max(2, Number(minHits) || 3);
  const shouldPromote = cand && (cand.hits >= min || cand.kind === 'appointment');
  if (shouldPromote) {
    data.longTerm.push({
      id: `lt_${Math.random().toString(36).slice(2, 10)}`, text: cand.text, kind: cand.kind || 'general',
      confidence: Math.max(conf, 70), status: '稳定', createdAt: cand.createdAt,
      lastVerified: nowMs(), hits: cand.hits, source: 'candidate', flag: isSensitive(cand.text) ? 'sensitive' : '',
      promoted: false, evidence: cand.evidence || '', chats: chatKey ? [String(chatKey)] : []
    });
    data.candidates = data.candidates.filter((it) => it !== cand);
    audit(data, 'promote', 'longTerm', cand.text.slice(0, 60));
    writeProfile(dir, data);
    return { status: 'promoted', id: data.longTerm[data.longTerm.length - 1].id };
  }
  writeProfile(dir, data);
  return { status: 'candidate' };
}

/** 人工/整理确认的一条长期结论（直接写长期，做同义合并）。pinned=红线豁免，不参与 stale 下沉。 */
export function addLongTerm(dir, uid, chatKey, { content, kind = 'general', confidence = 75, source = 'consolidate', name = '', pinned = false } = {}) {
  const u = uidOf(uid);
  const text = String(content || '').trim();
  if (!u || !text) return null;
  const data = readProfile(dir, u) || emptyProfile(u);
  if (name && String(name).trim() && String(name).trim() !== u && !data.aliases.includes(String(name).trim())) {
    data.aliases.push(String(name).trim());
  }
  touch(data, chatKey);
  const hit = data.longTerm.find((it) => it.text === text || sim(it.text, text) >= 0.78);
  if (hit) {
    hit.hits = (hit.hits || 1) + 1;
    hit.lastVerified = nowMs();
    hit.confidence = Math.max(Number(hit.confidence) || 0, Number(confidence) || 0);
    if (source === 'owner') hit.source = 'owner';   // 主人后来亲口确认过的，升级成 owner
    if (pinned) hit.pinned = true;
    if (!hit.chats.includes(String(chatKey))) hit.chats.push(String(chatKey));
    data.candidates = (data.candidates || []).filter((c) => !(c.text === text || sim(c.text, text) >= 0.78));
    writeProfile(dir, data);
    return hit;
  }
  const item = {
    id: `lt_${Math.random().toString(36).slice(2, 10)}`, text, kind, confidence: Number(confidence) || 75,
    status: '稳定', createdAt: nowMs(), lastVerified: nowMs(), hits: 1, source,
    flag: isSensitive(text) ? 'sensitive' : '', promoted: false, pinned: !!pinned,
    chats: chatKey ? [String(chatKey)] : []
  };
  data.longTerm.push(item);
  data.candidates = (data.candidates || []).filter((c) => !(c.text === text || sim(c.text, text) >= 0.78));
  audit(data, 'add', 'longTerm', text.slice(0, 60));
  writeProfile(dir, data);
  return item;
}

/** 一批标签（模型压缩出来的）写入档案，同义合并、去碎片、上限 12。 */
export function setTags(dir, uid, chatKey, tags = [], { name = '', limit = 12 } = {}) {
  const u = uidOf(uid);
  const data = readProfile(dir, u) || emptyProfile(u);
  if (name && String(name).trim() && String(name).trim() !== u && !data.aliases.includes(String(name).trim())) {
    data.aliases.push(String(name).trim());
  }
  touch(data, chatKey);
  for (const raw of tags || []) {
    const tag = String(raw || '').trim();
    if (!tag || tag.length < 2 || tag.length > 10) continue;
    const hit = data.persona.tags.find((t) => t.tag === tag
      || sim(t.tag, tag) >= 0.62
      || (new Set([...t.tag].filter((c) => tag.includes(c))).size >= 2 && Math.abs(t.tag.length - tag.length) <= 2));
    if (hit) {
      hit.hits = (hit.hits || 1) + 1;
      // 保留更完整的词形（「说话简短」不能被截成「话简短」）
      if (tag.length > hit.tag.length) hit.tag = tag;
      if (chatKey && !hit.scopes.includes(String(chatKey))) hit.scopes.push(String(chatKey));
    } else {
      data.persona.tags.push({ tag, hits: 1, scopes: chatKey ? [String(chatKey)] : [], confidence: 60, source: 'consolidate' });
    }
  }
  data.persona.tags.sort((a, b) => (b.hits || 0) - (a.hits || 0) || a.tag.length - b.tag.length);
  data.persona.tags = data.persona.tags.slice(0, limit);
  writeProfile(dir, data);
  return data.persona.tags.map((t) => t.tag);
}

/** 画像结论（模型判定稳定的人格/关系句）。 */
export function addTrait(dir, uid, chatKey, { text, dim = '人格', confidence = 70, name = '' } = {}) {
  const u = uidOf(uid);
  const body = String(text || '').trim();
  if (!u || !body) return null;
  const data = readProfile(dir, u) || emptyProfile(u);
  if (name && String(name).trim() && String(name).trim() !== u && !data.aliases.includes(String(name).trim())) {
    data.aliases.push(String(name).trim());
  }
  touch(data, chatKey);
  const hit = data.persona.traits.find((t) => t.text === body || sim(t.text, body) >= 0.78);
  if (hit) {
    hit.hits = (hit.hits || 1) + 1;
    hit.lastVerified = nowMs();
    hit.confidence = Math.max(Number(hit.confidence) || 0, Number(confidence) || 0);
    writeProfile(dir, data);
    return hit;
  }
  const item = { id: `pt_${Math.random().toString(36).slice(2, 10)}`, dim, text: body,
    confidence: Number(confidence) || 70, status: '稳定', hits: 1, firstSeen: nowMs(), lastVerified: nowMs(), evidence: [] };
  data.persona.traits.push(item);
  writeProfile(dir, data);
  return item;
}

/** 把一条长期结论升级进人物画像（同一个人的最高层）。升级后长期条目打 promoted 标记，提示词里不再重复。 */
export function promoteLongToTrait(dir, uid, { id = '', text = '', dim = '人格' } = {}) {
  const u = uidOf(uid);
  const data = readProfile(dir, u);
  if (!data) return null;
  const item = id
    ? (data.longTerm || []).find((it) => String(it.id) === String(id))
    : (data.longTerm || []).find((it) => it.text === String(text || '').trim());
  if (!item) return null;
  if (item.promoted) return { already: true, item };
  const trait = addTrait(dir, u, '', {
    text: item.text, dim: dim || '人格', confidence: Number(item.confidence) || 70, name: data.name || ''
  });
  const d2 = readProfile(dir, u);
  const it2 = d2 && (d2.longTerm || []).find((x) => String(x.id) === String(item.id));
  if (it2) {
    it2.promoted = true;
    it2.promotedAt = nowMs();
    it2.traitId = (trait && trait.id) || '';
    audit(d2, 'promote-trait', 'persona', String(it2.text || '').slice(0, 60));
    writeProfile(dir, d2);
  }
  return { item: it2 || item, trait };
}

function label(data) {
  const nm = String(data.name || '').trim();
  return nm && nm !== data.userId ? `${data.userId}（${nm}）` : `QQ:${data.userId}`;
}

function clip(s, n) {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

/** 去掉句末标点，避免拼接出「。。；」这种。 */
function tidy(s, n) {
  return clip(s, n).replace(/[。；;，、]+$/u, '');
}

/** 长期条目排序权重：约定最前，其次硬事实（病/钱/家/工作/日程），性格类垫底。 */
function kindWeight(it) {
  if (!it) return 0;
  if (it.kind === 'appointment') return 3;
  if (it.kind === 'fact') return 2;
  return 1;
}


/** 调试：改一条画像结论（文字 / 维度 / 置信度 / 状态）。只改点名的字段。 */
export function updateTrait(dir, uid, { id = '', text, dim, confidence, status } = {}) {
  const u = uidOf(uid);
  const data = readProfile(dir, u);
  if (!data) return null;
  const t = (data.persona?.traits || []).find((x) => String(x.id) === String(id));
  if (!t) return null;
  if (text != null && String(text).trim()) t.text = String(text).trim().slice(0, 300);
  if (dim != null && String(dim).trim()) t.dim = String(dim).trim().slice(0, 20);
  if (confidence != null && Number.isFinite(Number(confidence))) t.confidence = Math.max(0, Math.min(100, Number(confidence)));
  if (status && ['稳定', '观察', '废弃'].includes(String(status))) t.status = String(status);
  t.lastVerified = nowMs();
  audit(data, 'trait-edit', 'persona', String(t.text || '').slice(0, 60));
  writeProfile(dir, data);
  return t;
}

/** 调试：删掉一条画像结论。 */
export function removeTrait(dir, uid, id = '') {
  const u = uidOf(uid);
  const data = readProfile(dir, u);
  if (!data) return 0;
  const list = data.persona?.traits || [];
  const keep = list.filter((x) => String(x.id) !== String(id));
  if (keep.length === list.length) return 0;
  data.persona.traits = keep;
  audit(data, 'trait-del', 'persona', String(id));
  writeProfile(dir, data);
  return 1;
}

/** 降级一：画像 → 长期（从最高层拿下来，回到可读层，longTerm 里重新占一位）。 */
export function demoteTraitToLong(dir, uid, id = '') {
  const u = uidOf(uid);
  const data = readProfile(dir, u);
  if (!data) return null;
  const t = (data.persona?.traits || []).find((x) => String(x.id) === String(id));
  if (!t) return null;
  data.persona.traits = data.persona.traits.filter((x) => String(x.id) !== String(id));
  const hit = (data.longTerm || []).find((x) => x.text === t.text || sim(x.text, t.text) >= 0.78);
  if (hit) {
    hit.hits = (Number(hit.hits) || 1) + 1;
    hit.lastVerified = nowMs();
    hit.promoted = false;
  } else {
    data.longTerm.push({
      id: `lt_${Math.random().toString(36).slice(2, 10)}`, text: t.text, kind: 'general',
      confidence: Number(t.confidence) || 70, status: '稳定', createdAt: Number(t.firstSeen) || nowMs(),
      lastVerified: nowMs(), hits: Math.max(1, Number(t.hits) || 1), source: 'demote-trait',
      dim: t.dim || '人格', flag: isSensitive(t.text) ? 'sensitive' : '', promoted: false, chats: []
    });
  }
  audit(data, 'demote-trait', 'longTerm', String(t.text || '').slice(0, 60));
  writeProfile(dir, data);
  return { text: t.text };
}

/** 降级二：长期 → 候选（不再进提示词，得重新攒够提及次数才转正）。 */
export function demoteLongToCandidate(dir, uid, id = '') {
  const u = uidOf(uid);
  const data = readProfile(dir, u);
  if (!data) return null;
  const it = (data.longTerm || []).find((x) => String(x.id) === String(id));
  if (!it) return null;
  data.longTerm = data.longTerm.filter((x) => String(x.id) !== String(id));
  const hit = (data.candidates || []).find((x) => x.text === it.text || sim(x.text, it.text) >= 0.78);
  if (hit) {
    hit.hits = Math.max(Number(hit.hits) || 1, Number(it.hits) || 1);
    hit.lastSeen = nowMs();
  } else {
    data.candidates.push({
      id: `cd_${Math.random().toString(36).slice(2, 10)}`, text: it.text, kind: it.kind || 'general',
      confidence: Number(it.confidence) || 60, hits: 1, createdAt: Number(it.createdAt) || nowMs(),
      lastSeen: nowMs(), evidence: it.evidence || '', aspect: it.aspect || ''
    });
  }
  audit(data, 'demote-long', 'candidate', String(it.text || '').slice(0, 60));
  writeProfile(dir, data);
  return { text: it.text };
}

/** 自动降级（遗忘曲线）：长期 N 天没再被复核 → 回候选；画像 M 天没再被复核 → 回长期。0 = 不动这一层。 */
export function demoteStale(dir, { longDays = 0, traitDays = 0 } = {}) {
  const out = { scanned: 0, long: 0, trait: 0 };
  const now = nowMs();
  const cutLong = longDays > 0 ? now - longDays * 86400000 : 0;
  const cutTrait = traitDays > 0 ? now - traitDays * 86400000 : 0;
  for (const p of listProfiles(dir)) {
    out.scanned += 1;
    const data = readProfile(dir, p.userId);
    if (!data || data.self) continue;
    let changed = false;
    if (cutLong) {
      for (const it of (data.longTerm || []).slice()) {
        if (it.kind === 'event' || it.kind === 'appointment' || it.promoted || it.pinned) continue;
        if (it.source === 'owner') continue;   // 主人亲口交代的，不自动往下沉
        const ref = Math.max(Number(it.lastVerified) || 0, Number(it.createdAt) || 0);
        if (!ref || ref >= cutLong) continue;
        data.longTerm = data.longTerm.filter((x) => x !== it);
        data.candidates.push({
          id: `cd_${Math.random().toString(36).slice(2, 10)}`, text: it.text, kind: it.kind || 'general',
          confidence: Number(it.confidence) || 60, hits: 1, createdAt: Number(it.createdAt) || now,
          lastSeen: now, evidence: it.evidence || '', aspect: it.aspect || ''
        });
        out.long += 1; changed = true;
      }
    }
    if (cutTrait) {
      for (const t of (data.persona?.traits || []).slice()) {
        if (t.pinned) continue;
        const ref = Math.max(Number(t.lastVerified) || 0, Number(t.firstSeen) || 0);
        if (!ref || ref >= cutTrait) continue;
        data.persona.traits = data.persona.traits.filter((x) => x !== t);
        const hit = (data.longTerm || []).find((x) => x.text === t.text || sim(x.text, t.text) >= 0.78);
        if (hit) {
          hit.hits = (Number(hit.hits) || 1) + 1;
          hit.promoted = false;
        } else {
          data.longTerm.push({
            id: `lt_${Math.random().toString(36).slice(2, 10)}`, text: t.text, kind: 'general',
            confidence: Number(t.confidence) || 70, status: '稳定', createdAt: Number(t.firstSeen) || now,
            lastVerified: now, hits: Math.max(1, Number(t.hits) || 1), source: 'demote-stale',
            dim: t.dim || '人格', flag: isSensitive(t.text) ? 'sensitive' : '', promoted: false, chats: []
          });
        }
        out.trait += 1; changed = true;
      }
    }
    if (changed) {
      audit(data, 'demote-stale', 'mix', `long-${out.long} trait-${out.trait}`);
      writeProfile(dir, data);
    }
  }
  return out;
}

/** 把画像分主题桶：同一个人「自称孤」写三遍时，同桶只留信息量最大的一条。 */
function bucketOf(text) {
  const t = String(text || '');
  if (/说话|语气|口吻|腔|自称|称呼|文白/.test(t)) return 'speech';
  if (/关系|扮演|父皇|母后|姐姐|弟弟|一家|视作|称呼/.test(t)) return 'social';
  if (/情绪|脾气|性格|稳|激动|丧|敏感/.test(t)) return 'mood';
  if (/游戏|吃|爱|喜欢|偏好|玩|技术|插件/.test(t)) return 'hobby';
  return 'other';
}

/**
 * 生成给模型的记忆块：只有三段 —— 人物画像 / 个性标签 / 长期记忆。
 * 敏感项、机器人本体、过期短期一律不出现。
 */
export function buildProfileBlock({ dir, chatKey = '', userIds = null, limits = {} } = {}) {
  const people = [];
  for (const uid of (userIds || [])) {
    const data = readProfile(dir, uid);
    if (!data || data.self) continue;
    people.push(data);
  }
  if (!people.length) return { text: '', members: 0, portrait: 0, tags: 0, long: 0 };
  const maxPortrait = Math.max(1, Number(limits.portrait) || 3);
  const maxTags = Math.max(1, Number(limits.tags) || 8);
  const maxLong = Math.max(1, Number(limits.long) || 5);
  const tagLines = [];
  const portraitLines = [];
  const longLines = [];
  let portraitN = 0; let tagN = 0; let longN = 0;

  const byScore = (a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0) || (Number(b.hits) || 0) - (Number(a.hits) || 0);

  for (const p of people) {
    const traits = (p.persona?.traits || []).filter((t) => t.status !== '废弃' && !isSensitive(t.text)).sort(byScore);
    if (traits.length) {
      // 同主题只留一条：优先置信度高、文本长（信息全）
      const buckets = new Map();
      for (const t of traits) {
        const k = bucketOf(t.text);
        const cur = buckets.get(k);
        if (!cur) { buckets.set(k, t); continue; }
        const tConf = Number(t.confidence) || 0;
        const cConf = Number(cur.confidence) || 0;
        if (tConf > cConf || (tConf === cConf && String(t.text).length > String(cur.text).length)) buckets.set(k, t);
      }
      const order = ['speech', 'social', 'mood', 'hobby', 'other'];
      const picked = order.map((k) => buckets.get(k)).filter(Boolean).slice(0, maxPortrait);
      portraitN += picked.length;
      portraitLines.push(`- ${label(p)}：${picked.map((t) => tidy(t.text, 110)).join('；')}`);
    }
    const tags = (p.persona?.tags || []).filter((t) => !isSensitive(t.tag)).map((t) => t.tag).slice(0, maxTags);
    if (tags.length) {
      tagN += tags.length;
      tagLines.push(`- ${label(p)}：${tags.join(' · ')}`);
    }
    // 长期记忆一层：结论优先；事件流水留在档案里备查，不往提示词里塞（避免设备码、刷屏流水污染语境）
    const conclusions = (p.longTerm || [])
      .filter((it) => it.status !== '废弃' && it.flag !== 'sensitive' && !isSensitive(it.text))
      .filter((it) => it.kind !== 'event')
      // 已升级进画像的，画像里已经在说，别在长期段重复一遍
      .filter((it) => !it.promoted)
      .filter((it) => {
        if (it.kind !== 'appointment') return true;
        const due = Number(it.dueAt) || 0;
        return !due || due > nowMs();
      })
      // 长期时效：只带最近 N 天内出现过/复核过的结论（话题换得快的群，三天前的旧结论基本没用）；
      // 约定不吃时效，留到约定时刻之后由过期清理处理。N=0 表示不限。
      .filter((it) => {
        if (it.kind === 'appointment') return true;
        const days = Number(limits.longTtlDays) || 0;
        if (!days) return true;
        const ref = Math.max(Number(it.lastVerified) || 0, Number(it.createdAt) || 0);
        return !ref || ref >= nowMs() - days * 86400000;
      })
      // 排序：关键事实优先，其次「被提到几次 → 最近一次」
      .sort((a, b) => (b.source === 'owner' ? 1 : 0) - (a.source === 'owner' ? 1 : 0)
        || kindWeight(b) - kindWeight(a)
        || (Number(b.hits) || 0) - (Number(a.hits) || 0)
        || (Math.max(Number(b.lastVerified) || 0, Number(b.createdAt) || 0)) - (Math.max(Number(a.lastVerified) || 0, Number(a.createdAt) || 0))
        || (Number(b.confidence) || 0) - (Number(a.confidence) || 0));
    const picked = conclusions.slice(0, maxLong);
    if (picked.length) {
      longN += picked.length;
      longLines.push(`- ${label(p)}：${picked.map((it) => (it.kind === 'appointment'
        ? `〔约定·原文〕${tidy(it.text, 120)}`
        : tidy(it.text, 110))).join('；')}`);
    }
  }

  const parts = [];
  if (portraitLines.length) parts.push('【人物画像】', ...portraitLines);
  if (tagLines.length) parts.push('【个性标签】', ...tagLines);
  if (longLines.length) parts.push('【长期记忆】', ...longLines);
  if (!parts.length) return { text: '', members: people.length, portrait: 0, tags: 0, long: 0 };
  return { text: parts.join('\n'), members: people.length, portrait: portraitN, tags: tagN, long: longN };
}

/** 面板用：某人档案摘要。 */
export function profileSummary(dir, uid) {
  const p = readProfile(dir, uid);
  if (!p) return null;
  return {
    userId: p.userId, name: p.name, aliases: p.aliases, scopes: p.scopes, self: !!p.self,
    portrait: (p.persona?.traits || []).length, tags: (p.persona?.tags || []).map((t) => t.tag),
    long: (p.longTerm || []).filter((it) => it.kind !== 'event').length,
    events: (p.longTerm || []).filter((it) => it.kind === 'event').length,
    shortTerm: (p.state || p.shortTerm || []).length,
    candidates: (p.candidates || []).length, updatedAt: p.updatedAt
  };
}
