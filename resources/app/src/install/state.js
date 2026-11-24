// Installer-owned relative paths. Stored outside program files so upgrades keep
// both the user's migration decision and the chosen data/extension locations.
import fs from 'node:fs';
import path from 'node:path';

export const INSTALL_STATE_FILE = '.qq-agent-install.json';
export function installationPath(root, relative) {
  if (typeof relative !== 'string' || !relative || path.isAbsolute(relative) || relative.includes(':') || /[\0\r\n]/.test(relative)) throw new Error('安装数据路径无效');
  const target = path.resolve(root, relative);
  const rel = path.relative(path.resolve(root), target);
  if (!rel || rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) throw new Error('安装数据路径超出了安装目录');
  let current = target;
  while (true) {
    if (fs.existsSync(current) && (fs.lstatSync(current).isSymbolicLink() || path.relative(current, fs.realpathSync(current)) !== '')) throw new Error('安装数据路径不能经过链接');
    if (current === path.dirname(current)) break;
    current = path.dirname(current);
  }
  return target;
}
export function readInstallationState(root) {
  const file = path.join(root, INSTALL_STATE_FILE);
  if (!fs.existsSync(file)) return null;
  installationPath(root, INSTALL_STATE_FILE);
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (value.schema !== 1 || !['accepted', 'declined', 'not-needed'].includes(value.legacyMigration)) throw new Error('安装记录损坏，请修复安装后重试');
  const dataRoot = installationPath(root, value.dataDirectory);
  const extensionRoot = installationPath(root, value.extensionDirectory);
  if (dataRoot === extensionRoot || dataRoot.startsWith(extensionRoot + path.sep) || extensionRoot.startsWith(dataRoot + path.sep)) throw new Error('数据和扩展目录不能重合');
  return { ...value, dataRoot, extensionRoot };
}
