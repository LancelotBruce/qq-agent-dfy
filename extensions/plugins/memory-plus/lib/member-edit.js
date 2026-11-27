// 主人一句话改某人档案：改称呼、记一条确定的事实。
//
// 这里只做「谁 → 写什么」这两件事，不解析口令、不拦截消息：
// 由模型判断主人意图后调工具（听得懂"以后叫他蜥蜴哥哥""把某用户改成老木"），
// 靠表单式的参数落盘，写错主人在下一句就能纠正。
import { addLongTerm, addTrait, listProfiles, readProfile, writeProfile } from './profile.js';

function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

/**
 * 把「谁」解析成 QQ 号：纯 QQ 号 > 档案里的名字/别名完全匹配 > 唯一近似匹配。
 * @returns {{ok:true,uid:string,how:string}|{ok:false,error:string}}
 */
export function resolveMember(pdir, who) {
  const raw = String(who || '').trim()
    .replace(/^@+/, '').replace(/^[@「『“"']+/, '').replace(/[」』”"']+$/, '').trim();
  if (!raw) return { ok: false, error: '没说是谁' };
  if (/^\d{5,12}$/u.test(raw)) return { ok: true, uid: raw, how: 'QQ 号' };
  const digits = raw.replace(/\D/g, '');
  // 形如「1000000004(某用户)」也算给了号
  if (digits.length >= 5 && digits.length <= 12 && raw.length - digits.length <= 6) {
    return { ok: true, uid: digits, how: 'QQ 号' };
  }

  const w = norm(raw);
  const hits = [];
  for (const p of listProfiles(pdir)) {
    if (!p || p.self) continue;
    const names = [p.name, ...(Array.isArray(p.aliases) ? p.aliases : [])].map(norm).filter(Boolean);
    if (names.includes(w)) { hits.push({ p, exact: true }); continue; }
    if (w.length >= 2 && names.some((n) => (n.length >= 2 && n.includes(w)) || (w.includes(n) && n.length >= 2))) {
      hits.push({ p, exact: false });
    }
  }
  const exact = hits.filter((h) => h.exact);
  const pick = exact.length ? exact : hits;
  if (pick.length === 1) return { ok: true, uid: String(pick[0].p.userId), how: exact.length ? '档案名字' : '近似名字' };
  if (pick.length > 1) {
    const list = pick.slice(0, 6).map((h) => `${h.p.name || h.p.userId}（${h.p.userId}）`).join('、');
    return { ok: false, error: `「${raw}」对上了好几个人：${list}。要改哪个？请补上 QQ 号。` };
  }
  return { ok: false, error: `档案里没有「${raw}」。要么直接给 QQ 号，要么先让他在这说过话、被记进档案。` };
}

/** 改称呼：写 name + 保留旧名到 aliases + 画像加「称呼：xx」+ 长期留一条出处。 */
export function applyRename(pdir, { uid, name, chatKey = '' } = {}) {
  try {
    const id = String(uid || '').replace(/\D/g, '');
    const next = String(name || '').trim().replace(/[「」『』“”"']/gu, '').trim();
    if (!id) return { ok: false, error: '没识别到 QQ 号' };
    if (!next) return { ok: false, error: '新称呼是空的' };
    if (next.length > 20) return { ok: false, error: '称呼太长（超过 20 字），换个短点的' };

    addLongTerm(pdir, id, chatKey, {
      content: `主人指定叫他「${next}」`, kind: 'fact', confidence: 95, source: 'owner'
    });
    addTrait(pdir, id, chatKey, { text: `称呼：${next}`, dim: '关系', confidence: 92 });

    const d = readProfile(pdir, id);
    let old = '';
    if (d) {
      old = String(d.name || '').trim();
      d.aliases = Array.isArray(d.aliases) ? d.aliases : [id];
      if (old && old !== id && old !== next && !d.aliases.includes(old)) d.aliases.push(old);
      d.name = next;
      if (!d.aliases.includes(next)) d.aliases.push(next);
      d.updatedAt = Date.now();
      writeProfile(pdir, d);
    }
    return {
      ok: true,
      uid: id,
      oldName: old,
      text: `已改：QQ ${id}${old && old !== id ? `（原「${old}」）` : ''} 以后叫「${next}」，旧名字已进别名。`
        + '以后提到他就用这个称呼，不用再解释"谁是谁"。'
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/** 记一条确定的事实：直进长期结论层（source=owner，提示词里置顶、不吃时效、不参与自动降级）。 */
export function applyFact(pdir, { uid, text, kind = 'fact', chatKey = '' } = {}) {
  try {
    const id = String(uid || '').replace(/\D/g, '');
    const body = String(text || '').trim().replace(/[。.!！]+$/u, '').trim();
    if (!id) return { ok: false, error: '没识别到 QQ 号' };
    if (!body) return { ok: false, error: '要记的内容是空的' };
    const k = ['fact', 'appointment', 'relation', 'preference', 'correction'].includes(kind) ? kind : 'fact';
    const r = addLongTerm(pdir, id, chatKey, {
      content: body.slice(0, 200), kind: k, confidence: 95, source: 'owner'
    });
    return {
      ok: true,
      uid: id,
      merged: !!(r && r.merged),
      text: `已记进长期记忆（主人交代，提示词里置顶、不吃时效）：QQ ${id} — ${body}`
    };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
