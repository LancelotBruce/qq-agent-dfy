// reply-error-notice：模型调用失败时，给聊天里回一句人话，而不是把上游原始报错贴出来。
// 原始错误只进日志；这里只做分类 + 限流 + 固定文案。
const QUOTA_MARKS = ['insufficient', 'quota', 'rate limit', 'rate_limit', '余额', '额度', '欠费', 'exceeded your current'];
const RATE_MARKS = ['too many requests', 'rate limit', 'rate_limit'];
const AUTH_MARKS = ['401', '403', 'unauthorized', 'forbidden', 'invalid api key', 'invalid_api_key', 'authentication'];
const NETWORK_MARKS = ['econnrefused', 'etimedout', 'enotfound', 'eai_again', 'socket hang up', 'network', 'fetch failed'];

const TEXTS = {
  quota: '我这边模型额度用完了，先回不了话。充值或换个模型之后我就正常了。',
  auth: '我这边模型接口鉴权没过（不是余额问题，是配置或密钥有问题），得去检查一下设置。',
  network: '我这边连不上模型服务，网络不太稳定，等下再试一次。',
  generic: '我这边出了点问题，这条没回成。先记在日志里了，稍后重试一下。',
};

const QUOTA_COOLDOWN_MS = 10 * 60 * 1000;
const OTHER_COOLDOWN_MS = 5 * 60 * 1000;
const QUOTA_MAX_PER_CHAT = 3;

export function classifyModelError(error) {
  const rawStatus = error?.status ?? error?.statusCode ?? error?.response?.status ?? (typeof error?.code === 'number' ? error.code : 0);
  const status = Number(rawStatus) || 0;
  const msg = String(error?.message ?? error ?? '').toLowerCase();
  if (status === 402) return 'quota';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'quota';
  if (QUOTA_MARKS.some((mark) => msg.includes(mark))) return 'quota';
  if (RATE_MARKS.some((mark) => msg.includes(mark))) return 'quota';
  if (AUTH_MARKS.some((mark) => msg.includes(mark))) return 'auth';
  if (NETWORK_MARKS.some((mark) => msg.includes(mark))) return 'network';
  return 'generic';
}

/** 每次进程一份限流状态：按「会话 + 类别」计冷却，额度类另有总数上限。 */
export function createReplyErrorNotice({ send, log = console, now = Date.now } = {}) {
  const state = new Map();
  return async function notice(chatKey, error) {
    if (!chatKey) return { sent: false, reason: 'no-chat' };
    if (error?.__aborted || error?.name === 'AbortError') return { sent: false, reason: 'aborted' };
    const category = classifyModelError(error);
    if (typeof send?.sendTextBatch !== 'function') return { sent: false, reason: 'no-sender', category };
    const key = `${chatKey}|${category}`;
    const row = state.get(key) ?? { lastAt: 0, count: 0 };
    const cooldown = category === 'quota' ? QUOTA_COOLDOWN_MS : OTHER_COOLDOWN_MS;
    const stamp = now();
    if (row.count > 0 && stamp - row.lastAt < cooldown) return { sent: false, reason: 'cooldown' };
    if (category === 'quota' && row.count >= QUOTA_MAX_PER_CHAT) return { sent: false, reason: 'cap' };
    row.lastAt = stamp;
    row.count += 1;
    state.set(key, row);
    log.warn?.(`[reply-error] ${chatKey} ${category}：${String(error?.message ?? error).slice(0, 200)}`);
    try {
      await send?.sendTextBatch?.(chatKey, [TEXTS[category] ?? TEXTS.generic], {
        textFormat: 'prepared',
        source: { type: 'system', reason: 'model-error-' + category },
      });
      return { sent: true, category };
    } catch (sendError) {
      log.warn?.(`[reply-error] 提示发送失败：${sendError?.message ?? sendError}`);
      return { sent: false, reason: 'send-failed', category };
    }
  };
}

export const replyErrorTexts = TEXTS;
