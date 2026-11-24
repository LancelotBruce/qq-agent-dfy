import crypto from 'node:crypto';

export const APP_UPDATE_ID = 'cn.kondius.qq-agent';
export const MAX_UPDATE_BYTES = 1024 * 1024 * 1024;
export const MAX_UNPACKED_BYTES = 3 * 1024 * 1024 * 1024;
const fail = message => Object.assign(new Error(message), { status: 400, expose: true });
const object = value => value && typeof value === 'object' && !Array.isArray(value);

export function versionParts(value) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(value));
  if (!match || String(value).length > 128) throw fail('更新版本号无效');
  const numbers = match.slice(1, 4).map(Number);
  if (numbers.some(n => !Number.isSafeInteger(n))) throw fail('更新版本号过大');
  return { numbers, pre: match[4]?.split('.') ?? [] };
}
export function compareUpdateVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < 3; i++) if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] > y.numbers[i] ? 1 : -1;
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !y.pre.length ? 0 : !x.pre.length ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined || y.pre[i] === undefined) return x.pre[i] === undefined ? -1 : 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]), yn = /^\d+$/.test(y.pre[i]);
    return xn && yn ? (BigInt(x.pre[i]) > BigInt(y.pre[i]) ? 1 : -1) : xn !== yn ? (xn ? -1 : 1) : x.pre[i] > y.pre[i] ? 1 : -1;
  }
  return 0;
}
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
export function manifestPayload(manifest) {
  const { signature, ...payload } = manifest;
  return Buffer.from(canonicalJson(payload));
}
export function signUpdateManifest(manifest, privateKey) {
  const unsigned = structuredClone(manifest); delete unsigned.signature;
  return { ...unsigned, signature: crypto.sign(null, manifestPayload(unsigned), privateKey).toString('base64') };
}
export function httpsUpdateUrl(value) {
  let url; try { url = new URL(value); } catch { throw fail('更新包地址无效'); }
  if (typeof value !== 'string' || value.length > 2000 || url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('更新包必须使用不含凭据的 HTTPS 地址');
  return url.href;
}
export function verifyUpdateManifest(manifest, { publicKey, currentVersion, platform = process.platform, arch = process.arch, kind = 'desktop', channel = 'stable' } = {}) {
  if (!object(manifest) || Buffer.byteLength(JSON.stringify(manifest)) > 65536) throw fail('更新清单无效或过大');
  if (!publicKey) throw fail('此版本未配置更新签名公钥');
  if (typeof manifest.signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(manifest.signature)) throw fail('更新清单缺少有效签名');
  let verified = false; try { verified = crypto.verify(null, manifestPayload(manifest), publicKey, Buffer.from(manifest.signature, 'base64')); } catch {}
  if (!verified) throw fail('更新签名校验失败，已拒绝执行');
  if (manifest.schema !== 1 || manifest.appId !== APP_UPDATE_ID || !['stable', 'preview'].includes(manifest.channel) || manifest.channel !== channel) throw fail('更新清单不属于当前应用或发布通道');
  versionParts(manifest.version); versionParts(currentVersion);
  if (manifest.channel === 'stable' && versionParts(manifest.version).pre.length) throw fail('正式通道不能发布预览版本');
  if (typeof manifest.notes !== 'string' || manifest.notes.length > 12000 || !Array.isArray(manifest.packages) || !manifest.packages.length || manifest.packages.length > 16) throw fail('更新说明或更新包列表无效');
  const identities = new Set();
  for (const item of manifest.packages) {
    if (!object(item) || !['win32'].includes(item.platform) || !['x64', 'arm64'].includes(item.arch) || !['desktop', 'source'].includes(item.kind)) throw fail('更新包平台或类型无效');
    const identity = [item.platform, item.arch, item.kind].join(':'); if (identities.has(identity)) throw fail('更新包类型重复'); identities.add(identity);
    httpsUpdateUrl(item.url);
    if (!Number.isSafeInteger(item.size) || item.size < 1 || item.size > MAX_UPDATE_BYTES || !/^[a-f0-9]{64}$/.test(item.sha256)) throw fail('更新包大小或校验值无效');
    if (!Number.isSafeInteger(item.unpackedSize) || item.unpackedSize < 1 || item.unpackedSize > MAX_UNPACKED_BYTES) throw fail('更新包解压大小无效');
  }
  const asset = manifest.packages.find(item => item.platform === platform && item.arch === arch && item.kind === kind);
  if (!asset) throw fail('此版本尚未提供适用于当前客户端的自动更新包');
  return { version: manifest.version, notes: manifest.notes, channel: manifest.channel,
    newer: compareUpdateVersions(manifest.version, currentVersion) > 0, asset: structuredClone(asset),
    identity: crypto.createHash('sha256').update(manifestPayload(manifest)).digest('hex') };
}
