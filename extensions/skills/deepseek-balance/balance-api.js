// DeepSeek 余额查询核心逻辑（与 QQ Agent 插件 API 解耦，可独立测试）。
// 用法：
//   import { createBalanceClient } from './balance-api.js';
//   const client = createBalanceClient({ apiKey, baseUrl });
//   const info = await client.getBalance();          // 强制请求
//   const info = await client.getBalanceCached();    // 带缓存（默认 10 分钟）

const DEFAULT_BASE_URL = 'https://api.deepseek.com';
const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 分钟
const DEFAULT_TIMEOUT_MS = 20000;

export function createBalanceClient({
  apiKey,
  baseUrl = DEFAULT_BASE_URL,
  ttlMs = DEFAULT_TTL_MS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  now = Date.now,
} = {}) {
  let cache = { at: 0, data: null };

  function normalizedBaseUrl() {
    return String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  async function getBalance(force = false) {
    const ttl = Math.max(0, Number(ttlMs) || DEFAULT_TTL_MS);
    const at = now();
    if (!force && cache.data && at - cache.at < ttl) return cache.data;

    const key = String(apiKey || '').trim();
    if (!key) {
      throw new Error('未配置 DeepSeek API Key（插件设置 apiKey 或核心 config.json 的 api.apiKey）');
    }

    const url = `${normalizedBaseUrl()}/user/balance`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${body ? `：${body.slice(0, 200)}` : ''}`);
    }
    const data = await res.json();
    cache = { at: now(), data };
    return data;
  }

  /** 格式化成人话，供工具结果 / 口令回执共用。 */
  function format(info) {
    const lines = ['DeepSeek 余额：'];
    if (info && typeof info === 'object') {
      lines.push(`账户${info.is_available === false ? '不可用' : '可用'}。`);
      const infos = Array.isArray(info.balance_infos) ? info.balance_infos : [];
      if (!infos.length) lines.push('（接口未返回余额明细）');
      for (const b of infos) {
        const cur = String(b?.currency ?? 'CNY');
        const total = b?.total_balance ?? '--';
        const topped = b?.topped_up_balance ?? '0.00';
        const granted = b?.granted_balance ?? '0.00';
        lines.push(`${cur} 总额 ${total}（充值 ${topped} / 赠送 ${granted}）`);
      }
    } else {
      lines.push('（接口返回异常）');
    }
    return lines.join('\n');
  }

  return { getBalance, format };
}

// ── 独立自检入口：node balance-api.js [apiKey] ─────────────────────────────
// 不传 apiKey 时尝试读宿主数据目录下 config.json 的 api.apiKey（跟着 QQ_AGENT_DATA_DIR 走，不写死机器路径）。
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href) {
  import('node:fs').then((fs) => {
    let key = process.argv[2] || '';
    if (!key) {
      try {
        const dir = String(process.env.QQ_AGENT_DATA_DIR || process.cwd()).replace(/\\/g, '/');
        const core = JSON.parse(fs.readFileSync(dir + '/config.json', 'utf8'));
        key = String(core?.api?.apiKey || '').trim();
      } catch { /* 读不到就让它报错 */ }
    }
    const client = createBalanceClient({ apiKey: key });
    client.getBalance(true)
      .then((info) => { console.log(client.format(info)); })
      .catch((err) => { console.error('查询失败：', err.message || err); process.exitCode = 1; });
  });
}
