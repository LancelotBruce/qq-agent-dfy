// QQ 开机自启开关（组合层）
// 只做三件事：写一个延迟启动 QQ 的 VBS、在 HKCU Run 里挂/摘一个值、报告状态。
// 不碰 DaFeiYuWatchdog 自启链，也不碰 SnowLuma 的 autoStart；默认关闭，只有用户显式保存才创建。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { APP_ROOT, resolveDataDir } from '../../src/kernel/env.js';

const RUN_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const RUN_NAME = 'QQAgentQQAutoStart';
const DEFAULT_DELAY = 45;
const REG_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
const WSCRIPT_EXE = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'wscript.exe');

function installRoot() {
  return path.resolve(APP_ROOT, '..', '..');
}
function scriptPath() {
  return path.join(installRoot(), 'tools', 'start-qq.vbs');
}
function statePath() {
  try { return path.join(resolveDataDir(), 'qq-autostart.json'); }
  catch { return path.join(installRoot(), 'data-v05', 'qq-autostart.json'); }
}
function readState() {
  try { return JSON.parse(fs.readFileSync(statePath(), 'utf8')) || {}; } catch { return {}; }
}
function writeState(value) {
  try { fs.mkdirSync(path.dirname(statePath()), { recursive: true }); } catch { /* 已存在 */ }
  fs.writeFileSync(statePath(), JSON.stringify(value, null, 2), 'utf8');
}
function reg(args) {
  return execFileSync(REG_EXE, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
}
function runValue() {
  try {
    const out = reg(['query', RUN_KEY, '/v', RUN_NAME]);
    return out.includes(RUN_NAME) ? true : false;
  } catch { return false; }
}
function cleanPath(value) {
  return String(value || '').trim().replace(/^"(.*)"$/, '$1').replace(/,\d+$/, '').trim();
}
function findQq() {
  const candidates = [
    'D:\\PTencent\\QQNT\\QQ.exe',
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tencent', 'QQNT', 'QQ.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tencent', 'QQNT', 'QQ.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Programs', 'QQNT', 'QQ.exe'),
    'C:\\Program Files\\Tencent\\QQ\\Bin\\QQ.exe',
    'C:\\Program Files (x86)\\Tencent\\QQ\\Bin\\QQ.exe',
  ];
  for (const candidate of candidates) {
    try { if (candidate && fs.statSync(candidate).isFile()) return candidate; } catch { /* 下一个 */ }
  }
  const keys = [
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQ',
  ];
  for (const key of keys) {
    try {
      const out = reg(['query', key, '/v', 'DisplayIcon']);
      const line = out.split(/\r?\n/).find((item) => /DisplayIcon/i.test(item));
      if (!line) continue;
      const icon = cleanPath(line.replace(/^.*?DisplayIcon\s+REG_\w+\s+/i, ''));
      if (icon && fs.statSync(icon).isFile()) return icon;
    } catch { /* 下一个 */ }
  }
  return '';
}
function writeLauncher(qq, delaySec) {
  if (/[^\x00-\x7F]/.test(qq)) throw Object.assign(new Error('QQ 路径含非 ASCII 字符，无法安全写入 VBS'), { status: 400 });
  const body = [
    'Set sh = CreateObject("WScript.Shell")',
    `WScript.Sleep ${delaySec * 1000}`,
    `sh.Run """${qq}""", 1, False`,
    '',
  ].join('\r\n');
  fs.writeFileSync(scriptPath(), body, 'ascii');
}
function status() {
  const state = readState();
  const delaySec = Number.isFinite(+state.delaySec) ? Math.min(300, Math.max(5, Math.round(+state.delaySec))) : DEFAULT_DELAY;
  const scriptOk = fs.existsSync(scriptPath());
  return {
    ok: true,
    enabled: runValue() && scriptOk,
    delaySec,
    qqPath: findQq(),
    scriptPath: scriptPath(),
    note: runValue() && !scriptOk
      ? '启动项还在，但 start-qq.vbs 丢了；重新保存一次可修复。'
      : '只拉起 QQ，不代填密码；QQ 未设置自动登录时，开机后仍需手动扫码。',
  };
}
function setEnabled(body = {}) {
  if (process.platform !== 'win32') throw Object.assign(new Error('仅支持 Windows'), { status: 400 });
  const enabled = Boolean(body.enabled);
  const delaySec = Number.isFinite(+body.delaySec) ? Math.min(300, Math.max(5, Math.round(+body.delaySec))) : DEFAULT_DELAY;
  if (!enabled) {
    try { reg(['delete', RUN_KEY, '/v', RUN_NAME, '/f']); } catch { /* 本来就没开 */ }
    try { fs.rmSync(scriptPath(), { force: true }); } catch { /* 忽略 */ }
    writeState({ enabled: false, delaySec, updatedAt: Date.now() });
    return status();
  }
  const qq = findQq();
  if (!qq) throw Object.assign(new Error('没找到 QQ.exe，先确认 QQ 已安装（当前只支持 Windows）'), { status: 400 });
  writeLauncher(qq, delaySec);
  const command = `"${WSCRIPT_EXE}" "${scriptPath()}"`;
  reg(['add', RUN_KEY, '/v', RUN_NAME, '/t', 'REG_SZ', '/d', command, '/f']);
  writeState({ enabled: true, delaySec, qqPath: qq, updatedAt: Date.now() });
  return status();
}

export function register(http) {
  http.route('GET', '/api/qq-autostart', () => status());
  http.route('POST', '/api/qq-autostart', ({ body }) => setEnabled(body || {}));
}
