import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

export function updateHome(installRoot,env=process.env){
  const identity=crypto.createHash('sha256').update(path.resolve(installRoot).toLowerCase()).digest('hex').slice(0,24);
  return path.resolve(path.join(env.LOCALAPPDATA||os.tmpdir(),'QQAgentUpdates',identity));
}

export const SOURCE_UNITS = ['package.json', 'package-lock.json', 'electron', 'src', 'ui', 'bundled', 'assets', 'scripts', 'docs', 'node_modules'];
export const DESKTOP_UNITS = [
  'QQ Agent.exe', 'chrome_100_percent.pak', 'chrome_200_percent.pak', 'd3dcompiler_47.dll', 'ffmpeg.dll', 'icudtl.dat',
  'libEGL.dll', 'libGLESv2.dll', 'resources.pak', 'snapshot_blob.bin', 'v8_context_snapshot.bin', 'vk_swiftshader.dll',
  'vk_swiftshader_icd.json', 'vulkan-1.dll', 'LICENSE', 'LICENSE.electron.txt', 'LICENSES.chromium.html', 'locales', 'swiftshader',
  'resources/elevate.exe', 'resources/app-update.yml', 'resources/default_app.asar', ...SOURCE_UNITS.map(name => 'resources/app/' + name),
];
export const programUnits = kind => [...(kind === 'desktop' ? DESKTOP_UNITS : SOURCE_UNITS)];
export function within(child, root) {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return !relative || relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}
export function assertOrdinaryDirectory(value, { exists = true } = {}) {
  const full = path.resolve(value);
  if (full === path.parse(full).root) throw Error('不能将磁盘根目录作为更新或数据目录');
  let current = full;
  while (current !== path.dirname(current)) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw Error('更新目录不能经过符号链接或目录联接'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    current = path.dirname(current);
  }
  if (exists && !fs.statSync(full).isDirectory()) throw Error('更新目录不存在');
  return full;
}
export function applicationVersion(appRoot, fallback = '0.5.1') {
  try { const data = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')); return typeof data.version === 'string' ? data.version : fallback; }
  catch { return fallback; }
}
