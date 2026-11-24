// 协议端断线通知：只在"真断了"时打扰主人，恢复时补一条。
// 设计取舍：
//   · 边沿触发 + 宽限期（默认 60s）——一次闪断不该响；
//   · 同一次断线只发首条和恢复条，不重复刷；
//   · 通知要走发送通道，"能收不能发"时发不出去，所以日志里那条 [TRANSPORT-ALERT] 才是保底，
//     私聊只是尽力而为。这一点写在这里，免得以后误以为"没收到通知 = 没断线"。
const STAGE_LABEL = {
  configuration_error: '接入配置有误',
  awaiting_login: 'QQ 号未登录',
  account_mismatch: '连到了别的 QQ 号',
  disconnected: 'WS 连接断开',
  http_unauthorized: 'HTTP 令牌被拒',
  http_unavailable: 'HTTP 连不上',
  stopped: '已停止',
  verifying: '正在验证账号',
};

const pad = (n) => String(n).padStart(2, '0');
const clock = (ts) => { const d = new Date(ts); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function createTransportNotice({ bus, cfg, send, log = console, now = Date.now }) {
  const state = { inAlert: false, alertAt: 0, lastNoticeAt: 0, timer: null };
  let latest = null;

  const settings = () => {
    const source = cfg()?.notify?.transport ?? {};
    const owners = cfg()?.allow?.private ?? [];
    return {
      enabled: source.enabled !== false,
      graceMs: Math.max(5_000, Number(source.graceMs) || 60_000),
      cooldownMs: Math.max(60_000, (Number(source.cooldownMin) || 30) * 60_000),
      owner: String(source.ownerId ?? '').trim() || String(owners[0] ?? '').trim(),
    };
  };

  const ready = (status) => status?.connected === true && status?.transportReady === true;
  const clearTimer = () => { if (state.timer) { clearTimeout(state.timer); state.timer = null; } };

  function detail(status) {
    const label = STAGE_LABEL[status?.stage] || status?.stage || '状态未知';
    const code = status?.errorCode ? `（${status.errorCode}）` : '';
    const attempts = Number(status?.attempts) || 0;
    return `${label}${code}${attempts ? `，已重连 ${attempts} 次` : ''}`;
  }

  async function notify(text) {
    const { owner } = settings();
    if (!owner) {
      log.warn?.('[transport-notice] 没有配置主人号，只写日志不发私聊');
      return;
    }
    try {
      const result = await send.sendTextBatch(`private:${owner}`, [text], { transportNotice: true });
      if (result?.ok === false) log.warn?.(`[transport-notice] 私聊通知未发出：${JSON.stringify(result.failed?.[0]?.error ?? result)}`);
    } catch (error) {
      // 断线时发送通道本身就可能是坏的，这里只记日志，绝不再往外抛。
      log.warn?.(`[transport-notice] 私聊通知失败：${error?.message ?? error}`);
    }
  }

  function observe(status) {
    latest = status;
    const s = settings();
    if (!s.enabled) return;
    if (ready(status)) {
      clearTimer();
      if (!state.inAlert) return;
      const downMs = Math.max(0, now() - state.alertAt);
      const minutes = Math.floor(downMs / 60_000);
      state.inAlert = false;
      state.alertAt = 0;
      log.info?.(`[TRANSPORT-RECOVERED] 断了 ${minutes} 分钟`);
      void notify(`【协议端】${clock(now())} 已恢复，断了${minutes < 1 ? '不到 1 分钟' : ` ${minutes} 分钟`}`);
      return;
    }
    if (state.inAlert || state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      // 宽限期结束时再看一眼实时状态：已经恢复的闪断不再告警。
      if (ready(latest)) return;
      const t = now();
      const stage = latest?.stage || 'disconnected';
      const cooling = t - state.lastNoticeAt < settings().cooldownMs;
      const lastReady = Number(latest?.lastReadyAt) || 0;
      const line = `【协议端】${clock(t)} 断开：${detail(latest)}${lastReady ? `，上次正常 ${clock(lastReady)}` : ''}`;
      // 保底：日志一定写，私聊按冷却决定发不发。
      log.warn?.(`[TRANSPORT-ALERT] ${stage} ${latest?.errorCode ?? ''} attempts=${Number(latest?.attempts) || 0}`);
      state.inAlert = true;
      state.alertAt = t;
      if (cooling) return;
      state.lastNoticeAt = t;
      void notify(line);
    }, s.graceMs);
    state.timer.unref?.();
  }

  const off = bus.on('transport.status', observe, { internal: true });
  return {
    observe,
    stop() { off?.(); clearTimer(); },
  };
}
