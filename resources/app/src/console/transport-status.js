// Generic presentation only. Providers own protocol discovery and readiness.
export function safeTransportText(value) {
  return String(value ?? '').slice(0, 2048)
    .replace(/\b(Bearer\s+)\S+/gi, '$1[REDACTED]')
    .replace(/((?:access[_-]?token|token|api[_-]?key|password|secret)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&#)]+)/gi, '$1[REDACTED]')
    .replace(/(https?:\/\/|wss?:\/\/)[^\s/@]+@/gi, '$1[REDACTED]@');
}

// 每个阶段一句"结论"、一句"下一步"。
// 为什么分阶段：0.4 时代所有断线在控制台里都显示"未连接"，
// 实际可能是四种完全不同的故障（配置错／没登录／连错号／真断了），该动的动作也完全不同。
const STAGE_TEXT = {
  configuration_error: ['接入配置有问题：地址或令牌无效', '去「设置 → 协议接入」核对地址与令牌'],
  awaiting_login: ['协议端在跑，但这个 QQ 号还没登录', '去协议端面板扫码登录'],
  account_mismatch: ['连上的不是配置里绑定的那个 QQ 号', '要么登录对号，要么改绑定账号'],
  disconnected: ['和协议端的连接断了', '先看协议端进程在不在，再看端口'],
  http_unauthorized: ['HTTP 侧令牌被拒', '核对 HTTP 访问令牌'],
  http_unavailable: ['HTTP 侧连不上', '核对 HTTP 地址的端口'],
  stopped: ['已手动停止', '需要时手动启动'],
};

export function transportDiagnosis(status) {
  if (status.connected && status.transportReady === true) return null;
  const stage = status.stage;
  const pair = STAGE_TEXT[stage];
  const error = safeTransportText(status.error || (typeof status.diagnosis === 'string' ? status.diagnosis : ''));
  // 先给阶段结论（人能看懂该干什么），再把原始报错缩到 120 字挂在后面当证据。
  if (pair) return error ? `${pair[0]}｜${pair[1]}（${error.slice(0, 120)}）` : `${pair[0]}｜${pair[1]}`;
  if (error) {
    if (/401|unauthor|令牌不匹配/i.test(error)) return '接入认证失败，请核对对应协议的令牌';
    if (/ECONNREFUSED/i.test(error)) return `连接地址或端口未监听：${error.slice(0, 120)}`;
    if (/ENOTFOUND|EAI_AGAIN/i.test(error)) return `连接地址无法解析：${error.slice(0, 120)}`;
    if (/timeout|超时|ETIMEDOUT/i.test(error)) return `连接超时：${error.slice(0, 120)}`;
    return error;
  }
  if (status.connected && status.transportReady === false) return '服务连接已建立，正在验证账号与收发通道';
  return status.connected ? null : '尚未连接协议服务，请检查接入地址与服务状态';
}

// 控制台红条用的一句短话：断了多久 / 试了几次 / 是否降级。
export function transportDowntimeLabel(status, now = Date.now()) {
  if (status.connected && status.transportReady === true) return null;
  const since = Number(status.stageSince);
  if (!Number.isFinite(since) || since <= 0) return null;
  const minutes = Math.floor(Math.max(0, now - since) / 60000);
  const attempts = Number(status.attempts) || 0;
  const parts = [`已断${minutes < 1 ? '不到 1 分钟' : ` ${minutes} 分钟`}`];
  if (attempts > 0) parts.push(`重连 ${attempts} 次`);
  if (status.degraded === true) parts.push('已降级（2 分钟一次）');
  return parts.join('，');
}

export function copyTransportReadiness(source, target) {
  for (const key of ['transportReady', 'identityBound', 'degraded']) if (typeof source[key] === 'boolean') target[key] = key === 'transportReady' ? !!source.connected && source[key] : source[key];
  for (const key of ['stage', 'errorCode', 'diagnosis']) if (typeof source[key] === 'string' || source[key] === null) target[key] = source[key] === null ? null : safeTransportText(source[key]);
  for (const key of ['stageSince', 'lastReadyAt', 'attempts']) if (Number.isFinite(source[key])) target[key] = Number(source[key]);
  if (source.connection && typeof source.connection === 'object') {
    target.connection = {};
    for (const key of ['mode', 'accountId', 'wsUrl', 'httpUrl']) {
      if (typeof source.connection[key] === 'string') target.connection[key] = safeTransportText(source.connection[key]);
    }
  }
  return target;
}
