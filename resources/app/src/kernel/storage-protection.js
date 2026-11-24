import { createWindowsPasswordProtector } from '../protocols/password-store.js';

const prefix = 'qqa-secret-v1:';
const limit = 64 * 1024;

export function createStorageProtection({ namespace, protector = null, platform = process.platform, current = () => true }) {
  const codec = protector ?? (platform === 'win32' ? createWindowsPasswordProtector() : null);
  function check(scope) {
    if (!current()) throw new Error('插件实例已失效');
    if (typeof scope !== 'string' || !scope || scope.length > 256) throw new Error('私密数据范围无效');
    if (!codec) throw new Error('当前系统未提供安全登录存储');
  }
  async function protect(scope, value) {
    check(scope);
    const plain = Buffer.from(JSON.stringify({ version: 1, namespace, scope, value }), 'utf8');
    try {
      if (plain.length > limit) throw new Error();
      const encrypted = await codec.protect(plain);
      check(scope);
      if (!Buffer.isBuffer(encrypted) || !encrypted.length || encrypted.length > limit * 2) throw new Error();
      return prefix + encrypted.toString('base64');
    } catch {
      throw new Error('系统加密失败，登录信息未保存');
    } finally {
      plain.fill(0);
    }
  }
  async function unprotect(scope, encrypted) {
    check(scope);
    if (typeof encrypted !== 'string' || !encrypted.startsWith(prefix) || encrypted.length > limit * 3
        || !/^[A-Za-z0-9+/]+={0,2}$/.test(encrypted.slice(prefix.length))) throw new Error('已保存的登录信息无效，请重新绑定');
    let plain;
    try {
      plain = await codec.unprotect(Buffer.from(encrypted.slice(prefix.length), 'base64'));
      check(scope);
      if (!Buffer.isBuffer(plain) || plain.length > limit) throw new Error();
      const data = JSON.parse(plain.toString('utf8'));
      if (data.version !== 1 || data.namespace !== namespace || data.scope !== scope) throw new Error();
      return data.value;
    } catch {
      throw new Error('已保存的登录信息无法解密，请重新绑定');
    } finally {
      plain?.fill(0);
    }
  }
  return { protect, unprotect, supported: Boolean(codec) };
}
