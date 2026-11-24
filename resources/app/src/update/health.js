import fs from 'node:fs';
import path from 'node:path';
import { applicationVersion } from './layout.js';

// Called only after a real root kernel has started (and the desktop window was
// created). The external helper also checks this process is still alive.
export function acknowledgeUpdateBoot({ appRoot, env = process.env, pid = process.pid } = {}) {
  if (!env.QQ_AGENT_UPDATE_JOB || env.QQ_AGENT_ACCOUNTS_CHILD === '1') return false;
  const jobFile = path.resolve(env.QQ_AGENT_UPDATE_JOB), directory = path.dirname(jobFile);
  if (path.basename(jobFile) !== 'job.json' || fs.lstatSync(directory).isSymbolicLink() || fs.lstatSync(jobFile).isSymbolicLink()) throw Error('更新启动凭据位置无效');
  const job = JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  if (job.schema !== 1 || path.resolve(job.appRoot) !== path.resolve(appRoot) || !/^[a-f0-9]{64}$/.test(job.nonce) || !['upgrade', 'rollback'].includes(job.bootMode)) throw Error('更新启动凭据不匹配');
  const expected = job.bootMode === 'rollback' ? job.oldVersion : job.version;
  if (applicationVersion(appRoot) !== expected) throw Error('更新后实际启动的版本与预期不符');
  const filename = path.join(directory, 'health.json'), temp = filename + '.' + pid + '.tmp';
  fs.writeFileSync(temp, JSON.stringify({ nonce: job.nonce, version: expected, pid, mode: job.bootMode }), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temp, filename);
  return true;
}
