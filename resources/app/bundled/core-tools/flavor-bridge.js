// flavor-bridge：把"去 AI 味"插件的发送前改写能力接进 core-tools。
// 插件缺失 / 停用 / 抛错时一律原样返回，绝不阻断发送。
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// <实例根>\resources\app\bundled\core-tools → 上推四级得到实例根
const instanceRoot = path.resolve(here, '..', '..', '..', '..');
// 目录名可能被扩展管理改名（ai-flavor / ai-flavor_1），逐个试
const pluginEntries = ['ai-flavor', 'ai-flavor_1'].map((name) =>
  path.join(instanceRoot, 'extensions', 'plugins', name, 'index.js')
);

let cache = { mtime: 0, size: 0, mod: null };

async function loadModule() {
  const fs = await import('node:fs/promises');
  let stat = null;
  let entry = '';
  for (const candidate of pluginEntries) {
    try {
      stat = await fs.stat(candidate);
      entry = candidate;
      break;
    } catch { /* 试下一个目录名 */ }
  }
  if (!stat) return null;
  const key = stat.mtimeMs + ':' + stat.size;
  const stamp = stat.mtimeMs + ':' + stat.size;
  if (cache.mod && cache.stampKey === stamp) return cache.mod;
  try {
    const mod = await import(pathToFileURL(entry).href + '?v=' + encodeURIComponent(key));
    cache = { mod, stampKey: stamp, mtime: stat.mtimeMs, size: stat.size };
    return mod;
  } catch { return cache.mod ?? null; }
}

export async function rewriteOutgoing(texts, cfg) {
  try {
    const settings = cfg?.skills?.['ai-flavor']?.settings ?? {};
    if (settings.enabled === false) return texts;
    const mod = await loadModule();
    if (!mod || typeof mod.rewriteOutgoingTexts !== 'function') return texts;
    const out = await mod.rewriteOutgoingTexts(texts, settings);
    return Array.isArray(out) && out.length === texts.length ? out : texts;
  } catch { return texts; }
}
