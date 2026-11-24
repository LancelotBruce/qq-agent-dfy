// 封版时把条目写进「长期记忆」（核心 data/memory，也就是控制台「记忆」页里的印象）。
// 记在事件链发起人的名下 —— 以后这个人再说话，这条会被当成对他的印象注入，正好补上下文。
// 发起人是机器人自己（或取不到人）时，落到「群事件」这个会话级桶里，不挂在具体群友头上。
import { clockOf, chainTitle } from './state.js';

const CONTENT_MAX = 295;
// 判断一条 pending 是不是「有事要办」的未决，而不是闲聊里没聊明白的疑问。
const ACTIONISH = /待|等|明天|后天|下周|回头|到时候|问问|问一下|确认|决定|答应/;

export function memoryText(chain, label) {
  const date = String(label || '').slice(5).replace('-', '·');
  const head = `[${date} ${clockOf(chain.startTs)}] ${chainTitle(chain)}`;
  // 长期记忆只留「以后还有用」的东西：要兑现的约定、还悬着的未决。
  // 已定结论和过程事实属于过去，塞进来只会把记忆池填成流水账。
  const promises = chain.promises || [];
  const pending = chain.pending || [];
  const keep = [];
  if (promises.length) keep.push('答应过还没办：' + promises.slice(0, 2).join('；'));
  if (pending.length && (promises.length || ACTIONISH.test(pending.join('')))) {
    // 没有约定的链，只有 pending 里出现「待/等/明天/问一下」这类动作词才当未决保留，
    // 否则多半是闲聊里没聊明白的疑问（「这梗啥意思」），不该进长期记忆。
    keep.push('还没结果：' + pending.slice(0, 1).join('；'));
  }
  let out;
  if (keep.length) {
    out = `${head}｜${keep.join('｜')}`;
  } else {
    // 纯闲聊：一句话带过，不写细节。
    const one = (chain.facts || []).find((x) => String(x || '').trim().length >= 6) || '';
    out = one ? `${head}｜${String(one).slice(0, 60)}` : head;
  }
  if (out.length > CONTENT_MAX) out = out.slice(0, CONTENT_MAX - 1) + '…';
  return out;
}

/**
 * 写一条长期记忆。
 * @returns {{ok:boolean, target:string, error?:string, deduped?:boolean}}
 */
export function writeMemory(api, chain, label) {
  const content = memoryText(chain, label);
  if (!content) return { ok: false, target: '', error: '空条目' };
  const starter = chain.starter || {};
  const isSelf = !starter.uid || chain.msgs?.every((m) => m.self);
  const payload = isSelf
    ? { name: '群事件', content }
    : { userId: starter.uid, name: starter.name || `QQ${starter.uid}`, content };
  try {
    const mem = api && typeof api.capability === 'function' ? api.capability('data.memory') : null;
    if (!mem || typeof mem.append !== 'function') {
      return { ok: false, target: payload.name, error: '核心记忆服务不可用（data.memory 未就绪）' };
    }
    const r = mem.append(chain.chatKey, payload);
    return { ok: true, target: payload.name, deduped: Boolean(r?.deduped) };
  } catch (error) {
    return { ok: false, target: payload.name, error: String(error?.message ?? error) };
  }
}
