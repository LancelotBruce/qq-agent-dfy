import fs from 'node:fs';
import path from 'node:path';

// A bundled compatibility provider can project modules into ONE immutable
// import generation. Never write through a source-directory junction.
export function importAliasFiles(files = {}) {
  const entries = Object.entries(files);
  if (entries.length > 32) throw Error('兼容模块数量超出限制');
  let bytes = 0;
  for (const [name, source] of entries) {
    if (!/^(?:src|\.compat-04)\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.js$/.test(name)
        || typeof source !== 'string' || (bytes += Buffer.byteLength(source)) > 256 * 1024) throw Error('兼容模块声明无效');
  }
  return new Map(entries);
}

export function projectImportAliases({ sourceRoot, mirror, files, link }) {
  const roots = new Set([...files.keys()].map(name => name.split('/')[0]));
  function project(relative) {
    const target = path.join(mirror, relative), source = path.join(sourceRoot, relative);
    if (files.has(relative)) {
      fs.writeFileSync(target, files.get(relative), { flag: 'wx' });
      return;
    }
    const prefix = relative + '/';
    const descendants = [...files.keys()].filter(name => name.startsWith(prefix));
    if (!descendants.length) {
      try { link(source, target); } catch (error) {
        if (process.platform === 'win32' && /EPERM|EACCES/.test(error?.code ?? '') && fs.statSync(source).isFile()) fs.copyFileSync(source, target);
        else throw error;
      }
      return;
    }
    if (fs.existsSync(source) && (!fs.lstatSync(source).isDirectory() || fs.lstatSync(source).isSymbolicLink())) throw Error('兼容模块投影源必须是普通目录');
    fs.mkdirSync(target);
    const children = new Set(descendants.map(name => name.slice(prefix.length).split('/')[0]));
    if (fs.existsSync(source)) for (const name of fs.readdirSync(source)) children.add(name);
    for (const name of children) project(relative + '/' + name);
  }
  for (const root of roots) project(root);
  return roots;
}
