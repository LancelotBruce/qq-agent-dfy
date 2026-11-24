import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256File } from './files.js';
import { migrateFrom04 } from '../kernel/migrator.js';
import { INSTALL_STATE_FILE, installationPath, readInstallationState } from './state.js';

const json = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const digest = sha256File;
const write = (file, value) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fs.writeFileSync(temporary, JSON.stringify(value, null, 2)); fs.renameSync(temporary, file); }
  finally { fs.rmSync(temporary, { force: true }); }
};

export function finishInstallation({ installRoot, planFile, version } = {}) {
  installRoot = path.resolve(installRoot);
  if (installRoot === path.parse(installRoot).root) throw new Error('不能在磁盘根目录执行安装迁移');
  const plan = json(planFile);
  if (plan.schema !== 1 || path.resolve(plan.installRoot) !== installRoot || !['legacy', 'current', 'fresh'].includes(plan.kind) || !['accepted', 'declined', 'not-needed'].includes(plan.decision) || plan.kind === 'legacy' && !['accepted', 'declined'].includes(plan.decision)) throw new Error('安装迁移计划无效');
  const existing = readInstallationState(installRoot);
  if (existing) {
    if (plan.kind === 'legacy') throw new Error('目标已有 0.5 数据，不能再用 0.4 覆盖');
    write(path.join(installRoot, INSTALL_STATE_FILE), { ...existing, dataRoot: undefined, extensionRoot: undefined, version });
    return { ok: true, migrated: false, reused: true };
  }
  const state = {
    schema: 1, version, dataDirectory: plan.kind === 'current' ? 'data' : 'data-v05',
    extensionDirectory: plan.kind === 'current' ? 'resources/app' : 'extensions',
    legacyMigration: plan.decision, installedAt: new Date().toISOString(),
    ...(plan.sourceVersion ? { sourceVersion: plan.sourceVersion } : {}),
  };
  const dataRoot = installationPath(installRoot, state.dataDirectory);
  const extensionRoot = installationPath(installRoot, state.extensionDirectory);
  const reports = [];
  if (plan.kind !== 'current') {
    // This must stay empty on refusal too: stale legacy data cannot become the
    // new account merely because it happens to occupy the chosen pathname.
    for (const directory of [dataRoot, extensionRoot]) {
      if (fs.existsSync(directory) && fs.readdirSync(directory).length) throw new Error('新版本的数据目标已有内容，已停止以免覆盖');
    }
  }
  const staging = installationPath(installRoot, `.migration-${randomUUID()}`);
  const committed = [];
  try {
    if (plan.kind === 'legacy' && plan.decision === 'accepted') {
      const backupRoot = path.dirname(path.resolve(planFile));
      const manifest = json(path.join(backupRoot, 'manifest.json'));
      if (manifest.Version !== 1 || path.resolve(manifest.InstallRoot) !== installRoot) throw new Error('恢复副本不属于本次安装');
      const payload = installationPath(backupRoot, 'payload');
      // Do not execute extensions or launch any protocol during import.
      for (const entry of manifest.Entries) {
        const file = installationPath(payload, entry.Relative);
        if (entry.Kind === 'File' && (!fs.lstatSync(file).isFile() || digest(file) !== entry.Sha256.toLowerCase())) throw new Error('恢复副本校验失败');
      }
      fs.mkdirSync(staging);
      let profiles = fs.readdirSync(payload).filter(name => /^data(?:-\d+)?$/.test(name) && fs.existsSync(path.join(payload, name, 'config.json')));
      if (!profiles.length && plan.appDataSnapshot) profiles = ['legacy-appdata'];
      for (const name of profiles) {
        const suffix = name.startsWith('data-') ? name.slice(4) : '';
        const relative = state.dataDirectory + suffix;
        const source = installationPath(payload, name);
        const finalData = installationPath(installRoot, relative);
        const sourceData = name === 'legacy-appdata' ? plan.appDataSource : path.join(plan.sourceRoot, name);
        const report = migrateFrom04({ source, targetDataDir: path.join(staging, relative), relocate: [[sourceData, finalData], [plan.sourceRoot, installRoot]] });
        reports.push(report);
        if (!report.ok) throw new Error(`旧版数据迁移失败（${name}），恢复副本已保留`);
      }
      const extensionStage = path.join(staging, state.extensionDirectory);
      fs.mkdirSync(extensionStage, { recursive: true });
      for (const kind of ['plugins', 'skills']) {
        const source = path.join(payload, 'resources', 'app', kind);
        if (fs.existsSync(source)) {
          // Walk first: cpSync must not dereference links from an extension.
          const validate = directory => {
            installationPath(payload, path.relative(payload, directory));
            for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
              const file = path.join(directory, entry.name);
              installationPath(payload, path.relative(payload, file));
              if (entry.isDirectory()) validate(file);
              else if (!entry.isFile()) throw new Error('扩展包含链接或特殊文件，不能迁移');
            }
          };
          validate(source);
          fs.cpSync(source, path.join(extensionStage, kind), { recursive: true, errorOnExist: true, force: false });
        }
      }
      // All profiles and both extension categories must succeed before any of
      // them becomes active. Existing 0.4 files remain untouched/recoverable.
      for (const name of fs.readdirSync(staging)) {
        const destination = installationPath(installRoot, name);
        if (fs.existsSync(destination)) {
          if (fs.readdirSync(destination).length) throw new Error('提交目标出现新数据，已停止迁移');
          fs.rmdirSync(destination);
        }
        fs.renameSync(path.join(staging, name), destination); committed.push(destination);
      }
    }
    write(path.join(installRoot, INSTALL_STATE_FILE), state);
    return { ok: true, migrated: plan.kind === 'legacy' && plan.decision === 'accepted', profiles: reports.length, reports };
  } catch (error) {
    for (const target of committed.reverse()) {
      installationPath(installRoot, path.relative(installRoot, target));
      fs.rmSync(target, { recursive: true, force: true });
    }
    throw error;
  } finally {
    installationPath(installRoot, path.relative(installRoot, staging));
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
