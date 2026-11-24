// 插件装载器：两型（plugin 确定性 / skill LLM 型）清单规范化、装载、启停、SDK ctx 缝。
// 出处：SPEC §7（扩展系统全节）；DSH §4（插件模型与 SDK）。
// 关键行为（全部 SPEC §7.1 取证）：
// - 目录锚点由宿主指定（默认 APP_ROOT），绝不用 process.cwd()
// - 串行加载；单个失败带 loadError 注册（UI 可见），不拖垮启动
// - stale-but-working：新版本 setup 抛错 → 沿用旧实例（优于 down）
// - 两段闸：setup 前 deactivate 旧实例（不清注册）→ setup 成功后清旧注册 + register 新
// - entry 防穿越：path.relative + realpathSync
// - 孤儿工具清扫：新版注册后，上一版独有工具对账清理
// - 清单剥 BOM；id 正则；apiVersion>1 → problem
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { safeFetch } from './safe-fetch.js';
import { normalizeServiceNetwork } from './service-network.js';
import { commandReplyToEntry } from './plugin-commands.js';
import { createStorageProtection } from './storage-protection.js';
import {normalizeUpdateSource} from './extension-update-source.js';
import { sanitizeSdkValue, sanitizeProviderArguments, CORE_FUNCTIONAL_CAPABILITIES } from './sdk-services.js';
import {removeCreatedInstallTree} from '../install/files.js';
import {importAliasFiles, projectImportAliases} from './import-aliases.js';
import {extensionLoadDiagnostic, dependencyLoadMessage} from './extension-load-diagnostics.js';

import {pluginFingerprint} from './extension-fingerprint.js';
export {pluginFingerprint};

const SKILL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/i; // SPEC §17.2：Skill id 合法性
const CATEGORIES = ['model', 'message', 'knowledge', 'media', 'utility'];
const sanitize = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, '_'); // SPEC §7.4
// ESM 缓存跨 loader 实例共享；URL query 不会传播到相对依赖。
const importedGraphs = new Map();
const graphImports = new Map();
const MAX_GRAPH_IMPORTS = 32;

function plainCallbackData(value, depth = 0) {
  if (depth > 32) return false;
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(item => plainCallbackData(item, depth + 1));
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  return Object.keys(value).every(key => !['__proto__', 'prototype', 'constructor'].includes(key) && plainCallbackData(value[key], depth + 1));
}

function callbackMessage(original, edited) {
  if (!edited || typeof edited !== 'object' || Array.isArray(edited)) throw new Error('after-response message 必须是消息对象');
  const next = { ...original }; let changedBytes = 0;
  // A response hook may change model text and requested tool calls, not role,
  // accounting, vendor metadata, raw requests or arbitrary host objects.
  for (const key of ['content', 'tool_calls']) {
    if (!Object.hasOwn(edited, key)) { delete next[key]; continue; }
    if (Object.hasOwn(original, key) && JSON.stringify(original[key]) === JSON.stringify(edited[key])) continue;
    if (edited[key] === undefined) { delete next[key]; continue; }
    if (!plainCallbackData(edited[key])) throw new Error(`after-response ${key} 必须是纯数据`);
    if (key === 'tool_calls' && edited[key] !== null && (!Array.isArray(edited[key]) || edited[key].length > 128 || edited[key].some(call => !call || typeof call !== 'object'
      || typeof call.id !== 'string' || call.type !== 'function' || typeof call.function?.name !== 'string' || typeof call.function?.arguments !== 'string'))) {
      throw new Error('after-response tool_calls 必须是不超过 128 项的标准函数调用列表');
    }
    changedBytes += Buffer.byteLength(JSON.stringify(edited[key]), 'utf8');
    if (changedBytes > 4 * 1024 * 1024) throw new Error('after-response 修改超过 4MiB 上限');
    next[key] = structuredClone(edited[key]);
  }
  return next;
}

// Extension/code/cache anchors are host inputs. Reject ancestor junctions as
// well as links at the leaf; a worker must not inherit another account's tree.
export function assertExtensionDirectory(directory, { create = false } = {}) {
  const absolute = path.resolve(directory), parsed = path.parse(absolute);
  let current = parsed.root;
  for (const part of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    if (create && !fs.existsSync(current)) fs.mkdirSync(current);
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('扩展目录及父路径不接受符号链接或非普通目录');
  }
  return fs.realpathSync(absolute);
}

function directExtensionDirectory(root, directory) {
  const anchor = assertExtensionDirectory(root), absolute = path.resolve(directory);
  if (path.dirname(absolute) !== path.resolve(root)) throw new Error('扩展必须位于所属根的直接子目录');
  const original = assertExtensionDirectory(absolute);
  if (path.dirname(original) !== anchor) throw new Error('扩展目录真实路径越界');
  return original;
}

// 新 URL 来自不可变目录，而不是改写源码或依赖 Node22 loader hook。
// 插件外依赖映射回原路径（Node 默认 realpath），共享内核/包身份且不热更新。
// import.meta.url 指向副本；插件应经 ctx.storage 写数据。--preserve-symlinks 不支持。
function snapshotGraph(appRoot, extensionRoot, runtimeCacheRoot, roots, rootKind, dir, entryPath, fingerprint, generation, legacyDataDir = null, aliases = {}, detachedRoots = []) {
  const root = assertExtensionDirectory(appRoot), original = directExtensionDirectory(roots[rootKind], dir);
  const relative = path.relative(assertExtensionDirectory(roots[rootKind]), original);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !relative || relative.includes(path.sep)) {
    throw new Error('热重载只支持扩展根下的直接插件目录');
  }
  if (process.execArgv.some((arg) => arg.startsWith('--preserve-symlinks'))) throw new Error('热重载不支持 --preserve-symlinks，请重启并移除该参数');
  const cache = assertExtensionDirectory(runtimeCacheRoot, { create: true });
  const runtime = fs.mkdtempSync(path.join(cache, `${generation}-`));
  const mirror = path.join(runtime, 'app');
  const copy = path.join(mirror, rootKind, relative);
  const link = (source, target) => fs.symlinkSync(source, target, fs.statSync(source).isDirectory() ? (process.platform === 'win32' ? 'junction' : 'dir') : 'file');
  try {
    fs.mkdirSync(path.dirname(copy), { recursive: true });
    fs.cpSync(original, copy, { recursive: true });
    // 摘要绑定原目录身份；复制期间改动不能被授权成一致的模块图。
    if (pluginFingerprint(copy, { identityRoot: original }) !== fingerprint || pluginFingerprint(original) !== fingerprint) throw new Error('插件在创建热重载副本时发生变化，请重试');
    if(legacyDataDir){
      const privateData=assertExtensionDirectory(legacyDataDir,{create:true}),copiedData=path.join(copy,'data');
      if(fs.existsSync(copiedData)){if(!fs.statSync(copiedData).isDirectory())throw new Error('插件 data 必须是目录');removeCreatedInstallTree(copiedData,copy);}
      link(privateData,copiedData);
    }
    const aliasRoots = projectImportAliases({sourceRoot: root, mirror, files: importAliasFiles(aliases), link});
    const detached = new Set(detachedRoots);
    for (const name of detached) {
      if (!['ui', 'electron'].includes(name)) throw Error('兼容代码投影目录无效');
      fs.mkdirSync(path.join(mirror, name));
    }
    for (const name of fs.readdirSync(root)) {
      if (aliasRoots.has(name) || detached.has(name)) continue;
      if (Object.hasOwn(roots, name) || name === 'data-plugin-runtime' || path.resolve(root, name) === path.resolve(runtimeCacheRoot)) continue;
      // Separated workers obtain writable state via their own SDK/storage.
      // Do not mirror the primary app's data roots into their module graph.
      if (path.resolve(extensionRoot) !== path.resolve(appRoot) && /^data(?:-|$)/.test(name)) continue;
      const source = path.join(root, name), target = path.join(mirror, name);
      if (fs.statSync(source).isDirectory()) link(source, target);
      else if (name === 'package.json') fs.copyFileSync(source, target);
      // package-lock contains no runtime imports and cannot be symlinked on a non-elevated
      // Windows fixture; omit it from the snapshot rather than failing every bundled plugin.
      else if (name === 'package-lock.json') continue;
      else if (/\.(?:[cm]?js|json|node)$/.test(name)) {
        try { link(source, target); } catch (error) {
          if (process.platform === 'win32' && /EPERM|EACCES/.test(error?.code ?? '')) fs.copyFileSync(source, target);
          else throw error;
        }
      }
    }
    for (const [kind, domainRoot] of Object.entries(roots)) {
      if (!fs.existsSync(domainRoot)) continue;
      assertExtensionDirectory(domainRoot);
      if (kind !== rootKind) { link(domainRoot, path.join(mirror, kind)); continue; }
      for (const name of fs.readdirSync(domainRoot)) {
        if (name !== relative) {
          const source = path.join(domainRoot, name);
          if (fs.lstatSync(source).isSymbolicLink()) throw new Error('扩展根不接受符号链接目录');
          link(source, path.join(mirror, kind, name));
        }
      }
    }
    // 无 package.json 的手工插件仍按 SDK 的 ESM 入口约定加载（Node20）。
    if (!fs.existsSync(path.join(mirror, 'package.json'))) fs.writeFileSync(path.join(mirror, 'package.json'), '{"type":"module"}');
    return { runtime, mirror, entryPath: path.join(copy, path.relative(original, entryPath)) };
  } catch (err) {
    removeCreatedInstallTree(runtime, cache);
    throw err;
  }
}

// manifest 规范化（SPEC §7.3 字段全表）。返回 {manifest, problems[]}
export function normalizeManifest(raw, fallbackId, { defaultKind = 'skill' } = {}) {
  const problems = [];
  const m = raw && typeof raw === 'object' ? raw : {};
  let serviceNetwork=[];
  try{serviceNetwork=normalizeServiceNetwork(m.serviceNetwork);}catch(error){problems.push({level:'error',msg:error.message});}
  let update=null,updateError=null;
  try{update=normalizeUpdateSource(m.update);}catch(error){updateError=error.message;problems.push({level:'warn',msg:`${updateError}；保留手动重新加载`});}
  const id = typeof m.id === 'string' && m.id ? m.id : fallbackId;
  if (!SKILL_ID_RE.test(id)) problems.push({ level: 'error', msg: `id 非法：${id}` });
  let apiVersion = typeof m.apiVersion === 'number' ? m.apiVersion : 1;
  if (apiVersion > 1) { problems.push({ level: 'error', msg: `apiVersion ${apiVersion} 高于 1，不支持` }); apiVersion = 1; }
  let category = typeof m.category === 'string' ? m.category : 'utility';
  if (!CATEGORIES.includes(category)) category = 'utility'; // 非法回落 utility（不阻断）
  let requires = Array.isArray(m.requires) ? [...new Set(m.requires)] : [];
  requires = requires.filter((r) => r !== id); // 自依赖剔除
  // 旧形态 prompt:{when,examples,instruction} → prompt.sections（否则静默失效，SPEC §7.1）
  let prompt = m.prompt ?? null;
  if (prompt && !Array.isArray(prompt.sections) && (prompt.when || prompt.instruction || Array.isArray(prompt.examples))) {
    prompt = {
      sections: [{
        id: 'legacy', title: prompt.when ?? '', content: prompt.instruction ?? '',
        priority: Math.min(99, typeof prompt.priority === 'number' ? prompt.priority : 50),
      }],
    };
  }
  if (prompt?.sections) {
    for (const s of prompt.sections) {
      if (typeof s.priority === 'number' && s.priority > 99) s.priority = 99; // priority 上限 99（SPEC §7.3）
    }
  }
  return {
    manifest: {
      id, name: typeof m.name === 'string' && m.name ? m.name : id, update, updateError,
      version: typeof m.version === 'string' ? m.version : '0.0.0',
      apiVersion, kind: m.kind === 'plugin' || (m.kind == null && defaultKind === 'plugin') ? 'plugin' : 'skill',serviceNetwork,
      enabledByDefault: m.enabledByDefault !== false,
      category, description: m.description ?? '', author: m.author ?? '',
      requires, capabilities: Array.isArray(m.capabilities) ? m.capabilities : [],
      configSchema: m.configSchema && typeof m.configSchema === 'object' ? m.configSchema : {},
      settings: m.settings && typeof m.settings === 'object' ? m.settings : {},
      prompt, deprecated: m.deprecated === true,
      entry: typeof m.entry === 'string' && m.entry ? m.entry : 'index.js',
      permissions: Array.isArray(m.permissions) ? m.permissions : [],
      // legacyTrusted 不采用：清单不是管理员授权。
      legacyTrusted: false,
      panels: Array.isArray(m.panels) ? m.panels : [], // 面板声明（原样透传，校验在 console/panel-adapters.js）
      legacy: m.apiVersion === 0 || m.compat === '04' || m.compat04 === true || m.legacyApi === '0.4' || Boolean(m.prompt && !Array.isArray(m.prompt.sections) && (m.prompt.when || m.prompt.instruction || Array.isArray(m.prompt.examples))),
      tools: Array.isArray(m.tools) ? m.tools : [], // 元数据，不自动注册
      hostConfig: Array.isArray(m.hostConfig) ? [...new Set(m.hostConfig.filter((key) => typeof key === 'string'))] : [],
    },
    problems,
  };
}

export function readManifest(dir) {
  // 优先 skill.json → plugin.json；剥 BOM（Windows 编辑器默认写 BOM，SPEC §7.1）
  for (const name of ['skill.json', 'plugin.json']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    try {
      const raw = fs.readFileSync(f, 'utf8');
      return { raw: JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw), file: name };
    } catch (err) {
      return { raw: null, file: name, error: `${name} 解析失败：${err.message}` };
    }
  }
  return { raw: null, file: null };
}

// entry 安全：锁死在插件目录内（path.relative + realpathSync 防符号链接穿越，SPEC §7.1）
export function resolveEntrySafe(dir, entry) {
  const p = path.resolve(dir, entry);
  const rel = path.relative(dir, p);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { error: 'entry 越界（安全拒绝）' };
  try {
    const real = fs.realpathSync(p);
    const realDir = fs.realpathSync(dir);
    if (!real.startsWith(realDir + path.sep)) return { error: 'entry 符号链接穿越（安全拒绝）' };
    return { path: real };
  } catch {
    return { error: `entry 文件不存在：${entry}` };
  }
}

// 代码指纹校验会照盘重算整目录 sha256（扩展目录带素材，单个 2~3 秒）。
// 权限/能力访问路径按"工具 × 提供者"逐次校验，一次 /api/tools/availability
// 会被放大成 8~15 秒，控制台（设置页）整队列堵死（2026-11-14 定性）。
// 同一指纹 1.5s 内复用结果：内容真变了 fs-watch 会重载实例，晚一个窗口无害。
const freshFingerprintMemo = new Map();
function freshFingerprint(dir, fingerprint) {
  const key = `${dir}\u0000${fingerprint ?? ''}`;
  const hit = freshFingerprintMemo.get(key);
  if (hit && Date.now() - hit.at < 30000) return hit.ok;
  let ok = false;
  try { ok = pluginFingerprint(dir) === fingerprint; } catch { ok = false; }
  freshFingerprintMemo.set(key, { at: Date.now(), ok });
  if (freshFingerprintMemo.size > 128) for (const k of [...freshFingerprintMemo.keys()].slice(0, 64)) freshFingerprintMemo.delete(k);
  return ok;
}

export function createPluginLoader({
  log = console, bus = null, appRoot,
  extensionRoot = appRoot,
  runtimeCacheRoot = path.join(extensionRoot, 'data-plugin-runtime'),
  sharedExtensions = false,
  registry,        // 工具注册表
  capabilityRegistry,
  permissions,
  scheduler,
  storage,
  config,
  secretProtector = null, // Host-only codec injection for native storage tests.
  watch = fs.watch, // Host-only native watcher injection; never exposed in plugin SDK.
  kernelDeps = null, // 保留旧构造参数；不交给任何插件。
  sdkHost = {},    // 窄的宿主操作，不暴露内核对象。
} = {}) {
  // entries: Map<id, { manifest, dir, status, loadError, instance, ctx, tools:[] }>
  const entries = new Map();
  const isShared=()=>typeof sharedExtensions==='function'?sharedExtensions():sharedExtensions===true;
  const watchHandles = new Map();
  const watchTimers = new Map();
  const watchIdentities = new Map();
  const watchRecoveryDelays = new Map();
  let watchStarted = false;
  let watchRequested = false;
  let releaseWatchPreference = null;
  let watchBusy = false;
  let watchPending = false;
  let watchEpoch = 0;
  let stopped = false;
  let loadQueue = Promise.resolve();
  const ownerEpochs = new Map();
  const loadingEntries = new Set();
  const roots = {
    bundled: path.join(appRoot, 'bundled'),
    plugins: path.join(extensionRoot, 'plugins'), // 用户确定性型（出厂空）
    skills: path.join(extensionRoot, 'skills'),   // 用户 LLM 型（出厂空）
  };
  assertExtensionDirectory(extensionRoot, { create: true });
  const graphScope = JSON.stringify([path.resolve(extensionRoot), path.resolve(runtimeCacheRoot)]);

  const isLoaded = (id) => entries.has(id);
  // SPEC §5.1：skills[<id>].enabled 是开关唯一来源（只存用户改过的值）；
  // 未配置时回落 manifest.enabledByDefault（§7.3）。
  const isEnabledFor = (manifest) => {
    const stored = config.get().skills?.[manifest.id];
    if (stored && typeof stored === 'object' && typeof stored.enabled === 'boolean') return stored.enabled;
    return manifest.enabledByDefault !== false;
  };
  const isEnabled = (id) => {
    const e = entries.get(id);
    return e ? isEnabledFor(e.manifest) : true;
  };
  // 权限侧的 isCurrent 一律走 30s 共享指纹缓存（见文件顶部 freshFingerprint）：
  // 照盘重算整目录 sha256 在"工具 × 提供者"放大会把 /api/tools/availability 拖到 8~15 秒。
  const fingerprintChecker = (dir, fingerprint) => () => freshFingerprint(dir, fingerprint);
  const isActive = (id) => {
    const e = entries.get(id);
    return Boolean(e && e.status === 'active');
  };
  // 能力注册表的 owner 活性判定从这里取（capability.has 与 providers 同口径，SPEC §7.5）
  if (capabilityRegistry) {
    // 注入活性回调（构造后补挂——capability 构造时拿不到 loader）
    capabilityRegistry._setActiveProbe?.(isActive);
  }

  function skillSettings(manifest) {
    const stored = config.get().skills?.[manifest.id] ?? {};
    return { ...manifest.settings, ...(stored.settings ?? {}) };
  }

  // 工具 id 生成（SPEC §7.4）：用户域 <skillId>__<toolId>（sanitize 24+38、总长 ≤64）；
  // 捆绑域裸 id（用户已批 A-2：SPEC §7.4 "核心工具无前缀"语义扩展到捆绑插件——
  // 出厂人设直接点名裸 id，带前缀会破坏行为等价）。
  function toolIdFor(manifest, rawToolId, bundled) {
    if (bundled) return rawToolId;
    return `${sanitize(manifest.id).slice(0, 24)}__${sanitize(rawToolId).slice(0, 38)}`.slice(0, 64);
  }

  function reclaimResources(entry) {
    for (const stop of entry.resources ?? []) { try { stop(); } catch (err) { log.warn?.(`[loader] 资源回收异常：${err}`); } }
    entry.resources?.clear();
  }

  function deactivate(entry, reason = 'stopped') {
    if (entry.suspended || entry.disposed) return;
    entry.suspended = true;
    entry.controller?.abort(new Error('插件实例已停止'));
    try { entry.instance?.deactivate?.(...(entry.legacyLifecycle ? [{ reason }] : [])); } catch (err) { log.warn?.(`[loader] ${entry.manifest.id} deactivate 异常：${err}`); }
  }

  function disposeEntry(entry) {
    if (entry.disposed) return;
    entry.disposed = true;
    try { entry.instance?.dispose?.(); } catch (err) { log.warn?.(`[loader] ${entry.manifest.id} dispose 异常：${err}`); }
    reclaimResources(entry);
    if (entry.runtime) { try { removeCreatedInstallTree(entry.runtime, runtimeCacheRoot); } catch (err) { log.warn?.(`[loader] 热重载副本清理失败：${err}`); } }
  }

  function makeCtx(entry, bundled) {
    const manifest = entry.manifest;
    const srcLog = log.child(`plugin:${manifest.id}`);
    const declared = new Set(Object.keys(manifest.configSchema ?? {}));
    const ns = storage.namespace(manifest.id);
    entry.controller ??= new AbortController();
    const current = () => !stopped && !entry.disposed && !entry.suspended && isEnabledFor(manifest)
      && ownerEpochs.get(manifest.id) === entry.ownerEpoch
      && (entry.status === 'loading' || entries.get(manifest.id) === entry);
    const guard = () => { if (!current()) throw new Error('插件实例已失效'); };
    const protectedStorage = createStorageProtection({ namespace: ns.dir, protector: secretProtector, current });
    const track = (stop) => {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true; entry.resources.delete(cleanup);
        const result = stop();
        if (result && typeof result.then === 'function') Promise.resolve(result).catch((error) => srcLog.warn?.(`异步资源回收异常：${error?.message ?? error}`));
        return result;
      };
      entry.resources.add(cleanup);
      return cleanup;
    };
    const ownConfig = () => {
      const settings = skillSettings(manifest);
      return structuredClone(Object.fromEntries([...declared].filter((key) => Object.hasOwn(settings, key)).map((key) => [key, settings[key]])));
    };
    const diskCurrent = () => {
      if (!current()) return false;
      try { return freshFingerprint(entry.dir, entry.fingerprint) && (bundled || permissions.isCurrent(manifest.id, entry.fingerprint)); }
      catch { return false; }
    };
    const permittedOperation = async (scope, options, action) => {
      if (!diskCurrent()) throw new Error('插件实例或代码指纹已失效');
      const scopes = new Set(manifest.permissions.map((value) => value === 'web_fetch' ? 'net.outbound' : value));
      if (!scopes.has(scope)) throw new Error(`插件未声明权限 ${scope}`);
      if (options?.signal?.aborted) throw options.signal.reason ?? new Error('操作已中止');
      const controller = new AbortController();
      const signals = [entry.controller.signal, options?.signal].filter(Boolean);
      const abort = (signal) => controller.abort(signal.reason ?? new Error('操作已中止'));
      const listeners = signals.map((signal) => {
        const fn = () => abort(signal);
        if (signal.aborted) fn(); else signal.addEventListener('abort', fn, { once: true });
        return () => signal.removeEventListener('abort', fn);
      });
      let removeAbort, off;
      const cancelled = new Promise((_, reject) => {
        const rejectAbort = () => reject(controller.signal.reason ?? new Error('操作已中止'));
        removeAbort = () => controller.signal.removeEventListener('abort', rejectAbort);
        if (controller.signal.aborted) rejectAbort(); else controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const verdict = await Promise.race([(permissions.checkAsync ?? permissions.check).call(permissions, manifest.id, scope, {
          kind: bundled ? 'bundled' : 'user', fingerprint: bundled ? null : entry.fingerprint, detail: `SDK ${scope}`,
        }), cancelled]);
        const valid = () => diskCurrent() && verdict.decision === 'allow' && (!verdict.isValid || verdict.isValid());
        if (!valid()) throw new Error(`权限不足或插件已失效：${verdict.reason ?? scope}`);
        off = bus?.on?.('permission.decision', (event) => {
          if (event?.pluginId === manifest.id && event.scope === scope && !valid()) controller.abort(new Error('插件授权已失效'));
        }, { internal: true });
        const result = await Promise.race([Promise.resolve().then(() => {
          if (!valid() || controller.signal.aborted) throw controller.signal.reason ?? new Error('插件授权已失效');
          return action({ ...options, signal: controller.signal });
        }), cancelled]);
        if (!valid() || controller.signal.aborted) throw controller.signal.reason ?? new Error('插件授权已失效');
        return result;
      } finally { off?.(); removeAbort?.(); for (const release of listeners) release(); }
    };
    const fetchResponse = async (url, options) => {
      const result = sdkHost.fetch
        ? await sdkHost.fetch(url, options, entry)
        : await safeFetch(url, { method: options.method, headers: options.headers, body: options.body, signal: options.signal, maxBytes: options.maxBytes, timeoutMs: options.timeoutMs, followRedirects: options.redirect !== 'manual', expectBinary: true });
      if (result && typeof result.text === 'function' && typeof result.arrayBuffer === 'function') return result;
      const response = new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status, headers: result.headers });
      Object.defineProperties(response, { url: { value: result.finalUrl ?? String(url) }, redirected: { value: (result.hops?.length ?? 0) > 1 }, truncated: { value: result.truncated === true } });
      return response;
    };
    const schedule = (method, time, fn, opts) => {
      guard();
      const handle = scheduler[method](time, (...args) => {
        if (current() && !entry.suspended) return fn(...args);
      }, { ...opts, ownerId: manifest.id });
      return { stop: track(() => handle.stop()) };
    };
    const ctx = {
      id: manifest.id,
      kind: manifest.kind,
      bundled,
      log: srcLog,
      // 只能读自己 configSchema 声明过的键（DSH §4.2；schema 外读不到）
      config: {
        get: (key) => {
          guard();
          if (!declared.has(key)) return undefined;
          return structuredClone(skillSettings(manifest)[key]);
        },
        // Keep the full own-settings/defaults view for the 0.4 config() shim,
        // but never return references into the live configuration store.
        all: () => {
          guard();
          const settings = skillSettings(manifest);
          // The 0.4 config() API included its sole enabled switch. Do not let a
          // migrated/default option with the same name become a second switch.
          return structuredClone(entry.compatibility.mode === '04' ? { ...settings, enabled: isEnabledFor(manifest) } : settings);
        },
        onChange: (fn) => {
          guard();
          if (typeof fn !== 'function') throw new Error('config.onChange 需要函数');
          return track(config.onChange?.(() => { if (current()) fn(ownConfig()); }) ?? (() => {}));
        },
      },
      storage: {
        get: (k) => { guard(); return ns.get(k); },
        set: (k, v) => { guard(); return ns.set(k, v); },
        delete: (k) => { guard(); return ns.delete(k); },
        protect: protectedStorage.protect,
        unprotect: protectedStorage.unprotect,
        protectionSupported: protectedStorage.supported,
        get dir() { guard(); return ns.dir; },
      },
      registerCommand: (name, handler, { privateFromAllowedGroups = [] } = {}) => {
        guard();
        if (typeof name !== 'string' || !/^\/[\p{L}\p{N}_-]{1,48}$/u.test(name) || typeof handler !== 'function') throw new Error('聊天指令需要 /名称 和处理函数');
        if (!Array.isArray(privateFromAllowedGroups) || privateFromAllowedGroups.length > 16
            || privateFromAllowedGroups.some(value => typeof value !== 'string' || !/^[\p{L}\p{N}_-]{1,24}$/u.test(value))) throw new Error('群成员私聊指令范围无效');
        if (!manifest.permissions.includes('qq.send')) throw new Error('聊天指令需要声明 qq.send 权限');
        if (entry.commands.has(name) || [...entries.values()].some(other => other.manifest.id !== manifest.id && other.status === 'active' && other.commands.has(name))) throw new Error(`指令 ${name} 已被使用`);
        const command = (input, canReply, entryId) => permittedOperation('qq.send', { signal: input.signal }, async ({ signal }) => {
          if (!canReply()) return;
          let reply;
          try {
            reply = await handler({ ...input, signal });
            if (typeof reply !== 'string' || !reply.trim()) throw new Error('empty reply');
          } catch {
            if (signal.aborted || !canReply()) return;
            srcLog.warn?.(`指令 ${name} 未能完成`);
            reply = `${name} 执行失败，请查看插件状态。`;
          }
          if (signal.aborted || !canReply()) return;
          return ctx.send(input.chatKey, [{ type: 'text', text: reply }], { signal, [commandReplyToEntry]: entryId, beforeSend: () => {
            if (!canReply()) throw new Error('指令回复已取消');
          } });
        });
        Object.defineProperty(command, 'privateFromAllowedGroups', { value: Object.freeze([...new Set(privateFromAllowedGroups)]) });
        entry.commands.set(name, command);
      },
      registerTool: (def) => {
        guard();
        if (!def || typeof def !== 'object') throw new Error('工具定义必须是对象');
        const finalId = toolIdFor(manifest, def.id ?? def.name, bundled);
        const execute = def.execute ?? def.handler;
        if (typeof execute !== 'function') throw new Error(`工具 ${finalId} 缺 execute/handler 函数`);
        registry.register({
          ...def, id: finalId, ownerId: manifest.id,
          execute: async (args, execCtx) => {
            guard();
            const context = sdkHost.toolContext ? await sdkHost.toolContext(execCtx, entry) : execCtx;
            guard();
            return execute(args, context);
          },
          bundled, // 权限闸走 bundled 策略
          fingerprint: bundled ? null : entry.fingerprint,
        });
        entry.tools.push(finalId);
        return finalId;
      },
      registerCapability: (name, provider, options = {}) => {
        guard();
        const metadata = structuredClone(options);
        const exposed = typeof provider === 'function' && CORE_FUNCTIONAL_CAPABILITIES.has(name) ? (...args) => {
          const valid = () => {
            if (!diskCurrent()) throw new Error('插件实例或代码指纹已失效');
            for (const arg of args) if (arg?.signal?.aborted) throw arg.signal.reason ?? new Error('能力调用已中止');
          };
          valid();
          const prepared = sdkHost.providerContext?.(name, args, entry) ?? { args: sanitizeProviderArguments(name, args, ownConfig()) };
          const finish = (result) => { valid(); prepared.commit?.(); return result; };
          const result = provider(...prepared.args);
          if (!result || typeof result.then !== 'function') return finish(result);
          const signal = entry.controller.signal;
          let onAbort;
          const cancelled = new Promise((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error('插件实例已失效'));
            if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
          });
          return Promise.race([Promise.resolve(result).then(finish), cancelled]).finally(() => signal.removeEventListener('abort', onAbort));
        } : provider;
        if (exposed !== provider) for (const method of ['create', 'start', 'stop']) {
          if (typeof provider[method] === 'function') Object.defineProperty(exposed, method, { value: (...args) => provider[method](...args) });
        }
        entry.registeredCapabilities.push({ name, provider: exposed, options: metadata });
        capabilityRegistry.register(name, manifest.id, exposed, metadata);
      },
      registerTransport: (def) => {
        if (!def || typeof def !== 'object' || typeof def.id !== 'string' || !def.id) throw new Error('传输提供者需要 id');
        ctx.registerCapability('transport.provider', def, { lifecycle: true, default: Boolean(def.default), scopes: [...new Set(['net.outbound', ...(Array.isArray(def.scopes) ? def.scopes : [])])] });
        return def.id;
      },
      capability: (name, ...args) => {
        // 软依赖：有就调没有静默 undefined（SPEC §7.2 createSkillApi）
        guard();
        if (name === 'compat-04.prepareImport') throw new Error('兼容模块投影仅供宿主装载器使用');
        if (name === 'compat-04.transformSticker') {
          if (!bundled || manifest.id !== 'transport-onebot') throw new Error('兼容发送转换仅供捆绑传输使用');
          const owner = entries.get('compat-04');
          const transform = owner?.rootKind === 'bundled' && isActive('compat-04')
            ? capabilityRegistry.providers(name).find(row => row.ownerId === 'compat-04')?.provider : null;
          return typeof transform === 'function' ? transform(...args) : undefined;
        }
        if (!sdkHost.capabilityAccess && !capabilityRegistry.has(name)) return undefined;
        const provider = capabilityRegistry.providers(name)[0]?.provider;
        const accessible = sdkHost.capabilityAccess ? sdkHost.capabilityAccess(name, provider, { manifest, bundled, entry }) : provider;
        if (name === 'compat04.http' && typeof accessible?.fetchFor === 'function') return {
          fetchFor: (url, init = {}, detail = {}) => permittedOperation('net.outbound', init, (options) => accessible.fetchFor(String(url), options, {
            ...detail, pluginId: manifest.id, fingerprint: entry.fingerprint, authorized: true,
          })),
        };
        return typeof accessible === 'function' ? accessible(...args) : accessible;
      },
      hasCapability: (name) => capabilityRegistry.has(name),
      requireCapability: (name) => {
        if (!capabilityRegistry.has(name)) {
          throw new Error(`硬依赖能力未就绪：${name}（插件 ${manifest.id} 不激活）`);
        }
      },
      hooks: {
        on: (name, fn) => {
          entry.hooks[name] = entry.hooks[name] ?? [];
          entry.hooks[name].push(fn);
        },
      },
      prompt: {
        add: (sec) => {
          const priority = Math.min(99, sec.priority ?? 50); // ≤99 硬约束（DSH §3.1 模块 11）
          entry.promptSections.push({ ...sec, priority, owner: manifest.id });
        },
      },
      scheduler: {
        every: (ms, fn, opts = {}) => schedule('every', ms, fn, opts),
        at: (when, fn, opts = {}) => schedule('at', when, fn, opts),
      },
      send: (chatKey, segments, options = {}) => permittedOperation('qq.send', options, (opts) => {
        if (typeof sdkHost.send !== 'function') throw new Error('发送宿主未就绪');
        return sdkHost.send(chatKey, segments, { ...opts, source: { type: 'plugin', id: manifest.id, name: manifest.name ?? manifest.id } });
      }),
      http: { fetch: (url, options = {}) => permittedOperation('net.outbound', options, (opts) => fetchResponse(String(url), opts)) },
      lifecycle: {
        onStop: (fn) => { guard(); if (typeof fn !== 'function') throw new Error('lifecycle.onStop 需要函数'); return track(fn); },
        get signal() { return entry.controller.signal; },
      },
      ui: { panel: { register: async (definition = {}) => permittedOperation('ui.panel', {}, () => {
        const { title, size } = definition;
        const panelEntry = definition.entry ?? 'index.html';
        if (typeof title !== 'string' || !title.trim()) throw new Error('面板需要标题');
        if (typeof panelEntry !== 'string' || panelEntry.length >= 512 || /[\\:%\x00-\x1f?#]/.test(panelEntry) || !panelEntry.endsWith('.html') || !panelEntry.split('/').every((part) => part && part !== '.' && part !== '..' && !part.startsWith('.'))) throw new Error('面板 entry 必须是 ui/ 内的相对 HTML 路径');
        const root = fs.realpathSync(path.join(entry.dir, 'ui'));
        const filename = fs.realpathSync(path.join(root, panelEntry));
        if (fs.lstatSync(path.join(entry.dir, 'ui')).isSymbolicLink() || !filename.startsWith(root + path.sep) || !fs.statSync(filename).isFile()) throw new Error('面板 entry 不在受控 ui/ 目录中');
        const id = definition.id ?? `${sanitize(manifest.id).slice(0, 40)}_panel_${manifest.panels.length + 1}`;
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(id) || manifest.panels.some((panel) => panel.id === id)) throw new Error('面板 id 非法或重复');
        const panel = { id, title: title.trim(), entry: panelEntry, size, permissions: ['ui.panel'], api: [], ownerId: manifest.id };
        manifest.panels.push(panel);
        const dispose = track(() => { const index = manifest.panels.indexOf(panel); if (index >= 0) manifest.panels.splice(index, 1); });
        return { id, dispose };
      }) } },
      permissions: {
        status: (scope) => permissions.status(manifest.id, scope),
        request: async (scope, detail = null) => {
          const authorized = () => current() && !entry.suspended
            && (bundled || permissions.isCurrent(manifest.id, entry.fingerprint));
          if (!authorized()) return { decision: 'deny', reason: '插件实例已失效' };
          const verdict = await (permissions.checkAsync ?? permissions.check).call(permissions, manifest.id, scope, {
            kind: bundled ? 'bundled' : 'user', fingerprint: bundled ? null : entry.fingerprint, detail,
          });
          if (!authorized()) return { decision: 'deny', reason: '等待授权时插件已失效' };
          return verdict;
        },
      },
      events: {
        on: (name, fn) => {
          guard();
          return track(bus.on(name, (...args) => {
            if (current() && !entry.suspended) return fn(...args.map((value) => sanitizeSdkValue(value)));
          }));
        }, // bus 白名单已挡写操作类事件
        emit: (name, payload) => {
          if (!diskCurrent()) throw new Error('插件实例或代码指纹已失效');
          if (name !== 'blocklist-sync') throw new Error(`插件不能发布事件 ${name}`);
          if (typeof sdkHost.emit !== 'function') throw new Error('事件发布宿主未就绪');
          return sdkHost.emit(name, payload, { manifest, bundled, entry });
        },
      },
      unregisterTool: (id) => {
        if (!current() || !entry.tools.includes(id)) return false;
        const removed = registry.unregister(id, manifest.id);
        if (removed) entry.tools.splice(entry.tools.indexOf(id), 1);
        return removed;
      },
      isSkillActive: (id) => isActive(id),
      unregisterCapability: (name) => current() && capabilityRegistry.unregister(name, manifest.id),
    };
    return ctx;
  }

  // 所有入口共用串行队列，避免 watch、手动更新、启用互相覆盖注册。
  function loadDir(rootKind, dir, options = {}) {
    const requestedEpochs = new Map(ownerEpochs);
    const run = loadQueue.then(() => loadDirectory(rootKind, dir, { ...options, requestedEpochs }));
    loadQueue = run.catch(() => {});
    return run;
  }
  // Stage downloads outside the queue. Only the final swap and reload hold this
  // queue, so filesystem watchers cannot load a half-replaced directory.
  function withDirectoryUpdate(id,task){
    const run=loadQueue.then(()=>{
      if(stopped)throw Error('扩展加载器已停止');
      const entry=entries.get(id);if(!entry)throw Error('扩展已不存在');
      return task({entry,reload:()=>loadDirectory(entry.rootKind,entry.dir,{hot:true,requestedEpochs:new Map(ownerEpochs)})});
    });loadQueue=run.catch(()=>{});return run;
  }

  async function loadDirectory(rootKind, dir, { hot = false, skipUnchanged = false, watchToken = null, requestedEpochs } = {}) {
    if (stopped || (watchToken !== null && (!watchStarted || watchEpoch !== watchToken))) return;
    if (!Object.hasOwn(roots, rootKind)) throw new Error('未知的扩展根');
    directExtensionDirectory(roots[rootKind], dir);
    // Startup composition source is shipped beside plugins but is not a plugin
    // and must never enter the plugin installation/hot-reload lifecycle.
    if (rootKind === 'bundled' && path.resolve(dir) === path.resolve(roots.bundled, 'runtime-defaults')) return;
    const bundled = rootKind === 'bundled';
    const { raw, file, error } = readManifest(dir);
    const dirId = path.basename(dir);
    if (error || !raw) {
      const previous = [...entries.values()].find((item) => path.resolve(item.dir) === path.resolve(dir));
      if (previous?.status === 'active') {
        previous.loadError = `新版本清单失败：${error ?? '找不到 skill.json / plugin.json'}`;
        return;
      }
      entries.set(dirId, {
        manifest: normalizeManifest({}, dirId, { defaultKind: rootKind === 'plugins' ? 'plugin' : 'skill' }).manifest, dir, rootKind,
        status: 'error', loadError: error ?? '找不到 skill.json / plugin.json',
        instance: null, ctx: null, tools: [], hooks: {}, promptSections: [],
      });
      log.error(`[loader] ${dirId} 装载失败：${error ?? '无清单'}`);
      return;
    }
    // 0.4 used the installation directory as the extension type and commonly
    // omitted `kind`. Keep that classification without rewriting the package;
    // an explicit modern kind still takes precedence.
    const { manifest, problems } = normalizeManifest(raw, dirId, { defaultKind: rootKind === 'plugins' ? 'plugin' : 'skill' });
    // Seeing a shared package is not authorization to run it in this account.
    if(!bundled&&isShared()&&config.get().skills?.[manifest.id]?.enabled===undefined)config.update({skills:{[manifest.id]:{enabled:false}}});
    if ((requestedEpochs.get(manifest.id) ?? 0) !== (ownerEpochs.get(manifest.id) ?? 0)) return;
    const fatal = problems.some((p) => p.level === 'error');
    const prev = entries.get(manifest.id);
    if (prev && path.resolve(prev.dir) !== path.resolve(dir)) {
      log.error(`[loader] 拒绝重复插件身份 ${manifest.id}：不能覆盖其它目录或捆绑插件`);
      return;
    }
    let diskFingerprint;
    try { diskFingerprint = pluginFingerprint(dir); } catch { /* 统一在装载异常分支报告 */ }
    if (skipUnchanged && prev?.status !== 'unmet' && prev?.scanFingerprint === diskFingerprint && diskFingerprint && prev.enabledAtScan === isEnabledFor(manifest)) return;
    const ownerEpoch = ownerEpochs.get(manifest.id) ?? 0;
    ownerEpochs.set(manifest.id, ownerEpoch);
    const cancelled = () => stopped || !isEnabledFor(manifest) || ownerEpochs.get(manifest.id) !== ownerEpoch
      || (watchToken !== null && (!watchStarted || watchEpoch !== watchToken));
    const entry = {
      manifest, dir, rootKind, status: 'loading', loadError: null,
      compatibility: { mode: manifest.legacy ? '04' : 'native', automatic: false, features: [] },
      fingerprint: diskFingerprint ?? null,
      resources: new Set(), ownerEpoch, scanFingerprint: diskFingerprint, enabledAtScan: isEnabledFor(manifest),
      instance: null, ctx: null, tools: [], commands: new Map(), hooks: {}, promptSections: [],
      manifestFile: file, registeredCapabilities: [],
    };
    if (fatal) {
      // 清单级错误：旧实例还在跑则沿用（stale-but-working 优于 down）
      if (prev?.status === 'active') {
        log.warn(`[loader] ${manifest.id} 新清单非法（${problems.map((p) => p.msg).join('; ')}），沿用旧实例`);
        prev.scanFingerprint = diskFingerprint;
        prev.enabledAtScan = isEnabledFor(manifest);
        prev.loadError = `新版本清单非法：${problems.map((p) => p.msg).join('; ')}`;
        return;
      }
      entry.status = 'error';
      entry.loadError = problems.map((p) => p.msg).join('; ');
      entries.set(manifest.id, entry);
      return;
    }
    for (const p of problems) log.warn(`[loader] ${manifest.id}：${p.msg}`);

    // entry 安全闸（即使旧实例在跑也不沿用——安全拒绝优先，SPEC §7.1）
    const entryCheck = resolveEntrySafe(dir, manifest.entry);
    if (!bundled && !entryCheck.error) {
      // 根目录允许普通目录，不接受由 symlink 伪装的捆绑/用户身份路径。
      try { if (fs.lstatSync(dir).isSymbolicLink()) entryCheck.error = '插件目录符号链接不允许'; } catch { entryCheck.error = '插件目录不可读'; }
    }
    if (entryCheck.error) {
      if (prev) unload(manifest.id, `安全拒绝：${entryCheck.error}`);
      entry.status = 'error';
      entry.loadError = entryCheck.error;
      entries.set(manifest.id, entry);
      return;
    }

    // 禁用态：不 import（关掉插件 = 回到无插件行为，硬约束 SPEC/C-ext-02）
    if (!isEnabledFor(manifest)) {
      if (prev && (prev.status !== 'disabled' || !prev.disposed)) unload(manifest.id, 'disabled-on-reload');
      entry.status = 'disabled';
      if (!bundled && entry.fingerprint) permissions.bindPlugin?.(manifest.id, {
        fingerprint: entry.fingerprint, enabledAuthorizes: true, isEnabled: () => isEnabledFor(entry.manifest) && !entry.disposed && !entry.suspended && !entry.controller?.signal.aborted,
        scopes: manifest.permissions,
        isCurrent: fingerprintChecker(entry.dir, entry.fingerprint),
      });
      entries.set(manifest.id, entry);
      log.info(`[loader] ${manifest.id} 已停用（跳过装载）`);
      return;
    }

    // 硬依赖检查：requires 能力缺失 → 不激活（控制台标"依赖未就绪"，DSH §4.2）
    const missing = manifest.requires.filter((c) => !capabilityRegistry.has(c) && !manifest.capabilities.includes(c));
    if (missing.length > 0) {
      if (prev) unload(manifest.id, '依赖能力未就绪');
      entry.status = 'unmet';
      entry.loadError = `[EXTENSION_DEPENDENCY_MISSING] ${dependencyLoadMessage(missing, [...entries.values()].filter(row => row.manifest.id !== manifest.id).map(row => row.manifest))}`;
      entries.set(manifest.id, entry);
      log.warn(`[loader] ${manifest.id} ${entry.loadError}`);
      return;
    }

    // 两段闸第 1 段：setup 前只 deactivate 旧实例（停副作用，工具/能力先不清——
    // 万一新 setup 抛错要走保留旧实例分支，SPEC §7.1）
    const prevTools = prev ? registry.snapshotOwner?.(manifest.id) ?? [] : [];
    const prevCapabilities = prev ? capabilityRegistry.snapshotOwner?.(manifest.id) ?? [] : [];
    if (prev?.status === 'active') deactivate(prev, 'reload');
    loadingEntries.add(entry);

    try {
      entry.fingerprint = pluginFingerprint(dir);
      // 0.4 清单没有权限系统：老插件直接读 data/（sessions、memory-v2、聊天记录）。
      // 兼容模式按"只读两项"补齐 scope，否则 sdk-services 的 declared() 直接抛
      // 「插件未声明权限：data.sessions.read」；这错误落在 before-context 里会让
      // 整次唤醒失败并弹「QQ Agent 运行失败」（2026-11-14 20:2x memory-plus 事故）。
      if (manifest.legacy) {
        manifest.permissions = [...new Set([...(manifest.permissions ?? []),
          'data.sessions.read', 'data.memory.read'])];
      }
      const graphKey = JSON.stringify([graphScope, fs.realpathSync(dir)]);
      const dependencyFingerprint = pluginFingerprint(dir, { excludeEntry: entryCheck.path, dependenciesOnly: true });
      // 非 hot 保留兼容的保守拒绝，不把已变依赖图重新授权成旧缓存。
      if (importedGraphs.has(graphKey) && importedGraphs.get(graphKey) !== dependencyFingerprint && !hot) {
        throw new Error('插件依赖或资产已改变：ESM 子模块缓存需要重启进程后加载，请勿把旧实例重新授权为新代码');
      }
      entry.generation = crypto.randomUUID();
      if (!bundled) permissions.bindPlugin?.(manifest.id, {
        fingerprint: entry.fingerprint, enabledAuthorizes: true, isEnabled: () => isEnabledFor(entry.manifest) && !entry.disposed && !entry.suspended && !entry.controller?.signal.aborted,
        scopes: manifest.permissions,
        isCurrent: fingerprintChecker(entry.dir, entry.fingerprint),
      });
      if ((graphImports.get(graphKey) ?? 0) >= MAX_GRAPH_IMPORTS) throw new Error(`插件已达到 ${MAX_GRAPH_IMPORTS} 次模块图装载上限，请重启进程释放 ESM 缓存`);
      const legacyDataDir=!bundled&&isShared()&&storage?.namespace?path.join(storage.namespace(manifest.id).dir,'legacy-data'):null;
      // Only the shipped compatibility provider may project old import paths.
      // Each generation gets its own binding before top-level module evaluation.
      const ctx = makeCtx(entry, bundled);
      entry.ctx = ctx;
      const markLegacy = feature => {
        const first = entry.compatibility.mode !== '04';
        entry.compatibility.mode = '04'; entry.compatibility.automatic = true;
        if (!entry.compatibility.features.includes(feature)) entry.compatibility.features.push(feature);
        if (first) log.info(`[loader] ${manifest.id} 自动启用 0.4 接口兼容（${feature}）`);
      };
      const compat = !bundled && entries.get('compat-04')?.rootKind === 'bundled' && isActive('compat-04')
        ? capabilityRegistry.providers('compat-04.prepareImport').find(row => row.ownerId === 'compat-04')?.provider : null;
      const importPlan = typeof compat === 'function' ? compat({targetCtx: ctx, manifest, onUse: markLegacy,
        apiLimits: () => ({maxRounds: config.get().api?.maxRounds}),
        isCurrent: () => !stopped && !entry.disposed && !entry.suspended && entries.get(manifest.id) === entry
          && pluginFingerprint(entry.dir) === entry.fingerprint,
      }) : null;
      const snapshot = snapshotGraph(appRoot, extensionRoot, runtimeCacheRoot, roots, rootKind, dir, entryCheck.path, entry.fingerprint, entry.generation,legacyDataDir,importPlan?.files,importPlan?.detachedRoots);
      entry.runtime = snapshot.runtime;
      // 即使 import/setup 失败也消耗预算：ESM 已缓存模块无法显式释放。
      importedGraphs.set(graphKey, dependencyFingerprint);
      graphImports.set(graphKey, (graphImports.get(graphKey) ?? 0) + 1);
      await importPlan?.bind?.(snapshot.mirror);
      if (cancelled()) throw new Error('兼容模块绑定期间插件已停止或禁用');
      const mod = await import(pathToFileURL(snapshot.entryPath).href);
      const impl = mod.default ?? mod;
      entry.instance = impl;
      // 顶层 await 无法中止；stop 时尚未取得导出，返回后仍需调用其清理函数。
      if (entry.disposed) {
        entry.disposed = false; entry.suspended = false;
        deactivate(entry); disposeEntry(entry);
      }
      if (cancelled()) throw new Error('装载期间插件已停止或禁用');
      let setupCtx = ctx;
      // Both generations used apiVersion:1. The compatibility provider offers
      // a dual SDK for unmarked user packages and detects actual legacy calls;
      // explicit legacy packages retain their full existing lifecycle adapter.
      if (!bundled && !manifest.legacy && capabilityRegistry.has('compat-04.createAutomaticApi')) {
        setupCtx = await capabilityRegistry.consume('compat-04.createAutomaticApi', {
          targetCtx: ctx, manifest,
          onLegacyUse: markLegacy,
        });
        entry.ctx = setupCtx;
        if (cancelled()) throw new Error('兼容识别期间插件已停止或禁用');
      }
      // compat-04 必须在 setup 阶段即可被 legacy Skill 消费；先登记为 loading-active，失败仍走统一回滚。
      if (manifest.id === 'compat-04') { entry.status = 'active'; entries.set(manifest.id, entry); }
      // 0.4 legacy 入口统一交给 compat-04，避免旧 API 直接接触内核。
      if (manifest.legacy && manifest.id !== 'compat-04') {
        // Legacy targetCtx only receives the same SDK; compat04.http binds its own
        // identity and permission receipt through capability access above.
        if (!capabilityRegistry.has('compat-04.createSkillApi')) throw new Error('compat-04 不可用：legacy Skill 无法激活');
        const adapted = await capabilityRegistry.consume('compat-04.createSkillApi', { targetCtx: ctx, legacy: impl, manifest, deferSetup: true });
        if (cancelled()) throw new Error('兼容适配期间插件已停止或禁用');
        if (adapted && typeof adapted.setup === 'function') {
          entry.instance = adapted.instance ?? impl;
          entry.legacyLifecycle = true;
          await adapted.setup();
        }
      } else {
        // Setup is initialization, not an alternative to declarative exports.
        // Unmarked 0.4 packages commonly combine all of these; taking only the
        // setup branch made them appear active while their hooks never ran.
        if (typeof impl?.setup === 'function') await impl.setup(setupCtx);
        else if (typeof impl?.register === 'function') await impl.register(setupCtx);
        else if (!impl || (!impl.hooks && !impl.providers && typeof impl.activate !== 'function')) {
          throw new Error('入口未导出 setup/register/hooks/providers/activate 之一');
        }
        if (cancelled()) throw new Error('setup 期间插件已停止或禁用');
        const unresolvedLegacyPolicy = entry.compatibility.mode !== '04' && Object.hasOwn(impl.providers ?? {}, 'reply.local-policy');
        for (const [name, provider] of Object.entries(impl.providers ?? {})) {
          const target = entry.compatibility.mode === '04' && name === 'reply.local-policy' ? 'reply.after-tool-batch' : name;
          ctx.registerCapability(target, provider);
        }
        for (const [name, declared] of Object.entries(impl.hooks ?? {})) {
          for (const fn of Array.isArray(declared) ? declared : [declared]) if (typeof fn === 'function') ctx.hooks.on(name, fn);
        }
        // Keep the same dual SDK if a retained automatic-compat instance has
        // to reactivate after a failed reload. Do not retry setup.
        entry.activationCtx = setupCtx;
        if (typeof impl.activate === 'function') await impl.activate(setupCtx);
        if (unresolvedLegacyPolicy && entry.compatibility.mode === '04') {
          // An activate-only package can reveal its old API usage after the
          // declarations were registered. Remap only its declared old policy;
          // a native provider keeps the modern capability unchanged.
          capabilityRegistry.unregister('reply.local-policy', manifest.id);
          entry.registeredCapabilities = entry.registeredCapabilities.filter(item => item.name !== 'reply.local-policy');
          ctx.registerCapability('reply.after-tool-batch', impl.providers['reply.local-policy']);
        }
      }

      if (cancelled()) throw new Error('setup 期间插件已停止或禁用');
      if (pluginFingerprint(dir) !== entry.fingerprint) throw new Error('setup 期间插件磁盘内容已改变，请重试');
      importPlan?.verify?.(snapshot.mirror);

      // 两段闸第 2 段：setup 成功 → 清旧注册（摘旧表项 + 清旧能力）→ register 新实例；
      // 不走 unregister——它会连新工具一起删（SPEC §7.1 两段闸）
      if (prev) {
        // Keep this owner's logical load position across a successful reload.
        // Deleting/reinserting moves its equal-priority instructions and hooks
        // behind every other owner, invalidating an otherwise identical prefix.
        // A loading placeholder retains Map order while remaining inactive
        // during old dispose callbacks, just as the former missing slot did.
        // An actual unload still deletes the slot; a later install goes last.
        entry.status = 'loading';
        entries.set(manifest.id, entry);
        capabilityRegistry.unregisterOwner(manifest.id);
        capabilityRegistry.restoreOwner?.(manifest.id, entry.registeredCapabilities);
        // 孤儿工具清扫：新版只保留自己实际注册的工具，避免误删其他 owner。
        const newTools = new Set(entry.tools);
        for (const oldTool of prevTools) if (!newTools.has(oldTool.id)) registry.unregister(oldTool.id, manifest.id);
        disposeEntry(prev); // 只回收旧代 SDK 资源，不能按同 owner 删除新 setup 的定时器
      }
      entry.status = 'active';
      entries.set(manifest.id, entry);
      // prompt 静态片段
      for (const sec of manifest.prompt?.sections ?? []) {
        entry.promptSections.push({ ...sec, owner: manifest.id, priority: Math.min(99, sec.priority ?? 50) });
      }
      bus?.emit('plugin.loaded', { id: manifest.id });
      log.info(`[loader] ${manifest.id}@${manifest.version} 激活（${rootKind}${bundled ? '' : `/${manifest.kind}`}，工具 ${entry.tools.length} 个）`);
    } catch (err) {
      // setup 抛错 → 回滚已注册工具 + 补 activate 救活旧实例（stale-but-working，SPEC §7.1）
      for (const tid of entry.tools) registry.unregister(tid, manifest.id);
      entry.tools = [];
      entry.hooks = {};
      entry.promptSections = [];
      deactivate(entry, 'setup-failed');
      disposeEntry(entry);
      if (cancelled()) {
        capabilityRegistry.unregisterOwner(manifest.id);
        if (entries.get(manifest.id) === entry) entries.delete(manifest.id);
        if (!bundled) permissions.unbindPlugin?.(manifest.id);
        if (prev && entries.get(manifest.id) === prev && !prev.disposed) {
          prev.suspended = false;
          prev.controller = new AbortController();
          registry.restore?.(prevTools);
          capabilityRegistry.restoreOwner?.(manifest.id, prevCapabilities);
          if (!bundled) permissions.bindPlugin?.(manifest.id, { fingerprint: prev.fingerprint, enabledAuthorizes: true, isEnabled: () => isEnabledFor(prev.manifest) && !prev.disposed && !prev.suspended && !prev.controller?.signal.aborted, scopes: prev.manifest.permissions, isCurrent: fingerprintChecker(prev.dir, prev.fingerprint) });
          try { await prev.instance?.activate?.(prev.activationCtx ?? prev.ctx); } catch { /* 回滚尽力恢复 */ }
        }
        return;
      }
      if (prev?.status === 'active' && !prev.disposed) {
        capabilityRegistry.unregisterOwner(manifest.id);
        prev.suspended = false;
        prev.controller = new AbortController();
        try { await prev.instance?.activate?.(prev.activationCtx ?? prev.ctx); } catch { /* 旧实例已 deactivate，救不回就 down */ }
        if (cancelled()) return;
        registry.restore?.(prevTools);
        capabilityRegistry.restoreOwner?.(manifest.id, prevCapabilities);
        entries.set(manifest.id, prev); // 恢复旧表项；授权仍校验当前磁盘内容，不复用更新前的 allow。
        if (!bundled && prev.fingerprint) permissions.bindPlugin?.(manifest.id, {
          fingerprint: prev.fingerprint, enabledAuthorizes: true, isEnabled: () => isEnabledFor(prev.manifest) && !prev.disposed && !prev.suspended && !prev.controller?.signal.aborted, scopes: prev.manifest.permissions,
          isCurrent: fingerprintChecker(prev.dir, prev.fingerprint),
        });
        prev.scanFingerprint = diskFingerprint;
        prev.enabledAtScan = isEnabledFor(manifest);
        prev.loadError = `新版本 setup 失败：${err?.message ?? err}`;
        log.error(`[loader] ${manifest.id} 新版 setup 失败，沿用旧实例：${err?.stack || err}`);
      } else {
        capabilityRegistry.unregisterOwner(manifest.id);
        scheduler.disposeOwner(manifest.id);
        entry.status = 'error';
        const diagnostic = extensionLoadDiagnostic(err);
        entry.loadError = `[${diagnostic.code}] ${diagnostic.message}`;
        entries.set(manifest.id, entry);
        log.error(`[loader] ${manifest.id} 装载失败：${err?.stack || err}`);
        bus?.emit('plugin.error', { id: manifest.id, error: entry.loadError });
      }
    } finally {
      loadingEntries.delete(entry);
    }
  }

  // 磁盘对齐 pruneMissing：目录没了 → 卸载（含失败条目不算"已删除"，SPEC §7.1）
  function pruneMissing() {
    const alive = new Set();
    for (const [rootKind, root] of Object.entries(roots)) {
      if (!fs.existsSync(root)) continue;
      try { assertExtensionDirectory(root); } catch { continue; }
      for (const name of fs.readdirSync(root)) {
        if (rootKind === 'bundled' && name === 'runtime-defaults') continue;
        const dir = path.join(root, name);
        try { directExtensionDirectory(root, dir); } catch { continue; }
        const { raw } = readManifest(dir);
        alive.add(raw?.id ?? name);
        // 清单损坏不是目录删除，旧实例仍需保留以便回滚。
        if (!raw) for (const [id, entry] of entries) if (path.resolve(entry.dir) === path.resolve(dir)) alive.add(id);
      }
    }
    for (const [id, e] of [...entries]) {
      if (!alive.has(id)) {
        unload(id, `目录已删除（${e.rootKind}）`);
      }
    }
  }

  function unload(id, reason) {
    ownerEpochs.set(id, (ownerEpochs.get(id) ?? 0) + 1);
    for (const pending of loadingEntries) if (pending.manifest.id === id) { deactivate(pending); disposeEntry(pending); }
    const e = entries.get(id);
    if (e) { deactivate(e, reason); disposeEntry(e); }
    for (const tid of registry.byOwner(id)) registry.unregister(tid);
    capabilityRegistry.unregisterOwner(id);
    scheduler.disposeOwner(id);
    if (!e) { permissions.unbindPlugin?.(id); return false; }
    e.status = 'unloaded';
    if (e.rootKind !== 'bundled') permissions.unbindPlugin?.(id);
    entries.delete(id);
    bus?.emit('plugin.unloaded', { id, reason });
    log.info(`[loader] ${id} 已卸载：${reason}`);
    return true;
  }

  async function loadAll({ reason = 'boot', hot = false, skipUnchanged = reason === 'fs-watch', watchToken = null } = {}) {
    if (watchStarted && !stopped) reconcileWatchers();
    log.info(`[loader] 开始装载（${reason}）：bundled → plugins → skills（串行）`);
    for (const [rootKind, root] of Object.entries(roots)) {
      if (!fs.existsSync(root)) continue;
      try { assertExtensionDirectory(root); } catch (err) { log.error?.(`[loader] 扩展根不安全：${err.message}`); continue; }
      for (const name of fs.readdirSync(root).sort()) {
        if (rootKind === 'bundled' && name === 'runtime-defaults') continue;
        const dir = path.join(root, name);
        try {
          if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) continue;
          if (stopped || (watchToken !== null && (!watchStarted || watchToken !== watchEpoch))) return listEntries();
          await loadDir(rootKind, dir, { hot: hot || reason === 'fs-watch', skipUnchanged, watchToken }); // 逐目录串行
        } catch (err) {
          log.error(`[loader] 目录 ${name} 装载异常：${err?.stack || err}`);
        }
      }
    }
    if (!stopped && (watchToken === null || (watchStarted && watchToken === watchEpoch))) pruneMissing();
    return listEntries();
  }

  function listEntries() {
    return [...entries.values()].map((e) => ({
      id: e.manifest.id, name: e.manifest.name, version: e.manifest.version, update: e.manifest.update, updateError: e.manifest.updateError,
      kind: e.manifest.kind, category: e.manifest.category, description: e.manifest.description,
      root: e.rootKind, dir: e.dir, status: e.status, loadError: e.loadError,...(e.rootKind!=='bundled'&&isShared()?{shared:true}:{}),
      lastError: e.lastError ?? null, lastErrorAt: e.lastErrorAt ?? null,
      enabled: isEnabled(e.manifest.id),
      fingerprint: e.fingerprint ?? null, generation: e.generation ?? null,
      compatibility: e.compatibility ? structuredClone(e.compatibility) : null,
      panels: structuredClone(e.manifest.panels ?? []),
      permissions: [...(e.manifest.permissions ?? [])],
      // 只读 DTO 暴露清单声明，控制台据此渲染和校验设置；值在 HTTP 边界由 serializeSkill 脱敏。
      settings: skillSettings(e.manifest),
      configSchema: structuredClone(e.manifest.configSchema ?? {}),
      requires: [...(e.manifest.requires ?? [])],
      capabilities: [...(e.manifest.capabilities ?? [])],
      tools: [...e.tools],
    }));
  }

  // 启停：写 config.skills[id].enabled（Skill 开关唯一来源，SPEC §5.1）
  async function setEnabled(id, enabled) {
    const skills = structuredClone(config.get().skills ?? {});
    skills[id] = { ...(skills[id] ?? {}), enabled: !!enabled };
    config.update({ skills });
    if (!enabled) {
      const e = entries.get(id) ?? [...loadingEntries].find((pending) => pending.manifest.id === id);
      unload(id, 'disabled');
      if (e) {
        e.status = 'disabled';
        e.generation = null;
        e.tools = []; e.hooks = {}; e.promptSections = [];
        e.scanFingerprint = null;
        entries.set(id, e);
      }
      if (e?.rootKind !== 'bundled') permissions.unbindPlugin?.(id);
    } else {
      const e = entries.get(id);
      if (e && e.status !== 'active') {
        // Another account may update a shared package while this account is
        // disabled. Explicitly enabling it creates a fresh immutable graph.
        await loadDir(e.rootKind, e.dir, {hot:isShared()&&e.rootKind!=='bundled'});
      }
    }
    return listEntries();
  }

  // 回调只能得到按插件绑定的 SDK 视图。可修改的消息先隔离，成功且仍有效
  // 才提交；独立 signal 在超时/卸载/结束后封闭保留的仓接口和迟到修改。
  async function invokeCallback(entry, kind, payload, fn, legacyArgs = null) {
    const controller = new AbortController();
    const cleanup = [];
    for (const signal of new Set([payload?.signal, entry.controller?.signal].filter(Boolean))) {
      const abort = () => controller.abort(signal.reason ?? new Error('插件回调已取消'));
      if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      cleanup.push(() => signal.removeEventListener('abort', abort));
    }
    let timer, removeAbort;
    const cancelled = new Promise((_, reject) => {
      const abort = () => reject(controller.signal.reason ?? new Error('插件回调已取消'));
      removeAbort = () => controller.signal.removeEventListener('abort', abort);
      if (controller.signal.aborted) abort(); else controller.signal.addEventListener('abort', abort, { once: true });
    });
    cancelled.catch(() => {});
    timer = setTimeout(() => controller.abort(new Error(`${kind} 超时（5000ms）`)), 5000);
    const current = () => {
      if (stopped || controller.signal.aborted || entries.get(entry.manifest.id) !== entry
        || entry.status !== 'active' || entry.suspended || entry.disposed) return false;
      try { return freshFingerprint(entry.dir, entry.fingerprint); } catch { return false; }
    };
    try {
      const raw = { ...payload, signal: controller.signal };
      const context = sdkHost.callbackContext ? await sdkHost.callbackContext(raw, entry, kind) : {
        ...Object.fromEntries(['chatKey', 'botName', 'session', 'triggerEntries', 'messages', 'response', 'toolName', 'argsRaw', 'args', 'result', 'context']
          .filter((key) => Object.hasOwn(raw, key)).map((key) => [key, sanitizeSdkValue(raw[key])])),
        cfg: sanitizeSdkValue(entry.ctx?.config?.all?.() ?? {}), signal: controller.signal,
      };
      // Legacy callbacks used these scalar aliases. Derive them from the same
      // already-visible identifiers; never lend a host object or configuration.
      const chat = /^(group|private):(.+)$/.exec(String(context.chatKey ?? ''));
      for (const [key, explicit, derived] of [['sessionId', payload.sessionId, context.session?.id], ['chatId', payload.chatId, chat?.[2]], ['kind', payload.kind, chat?.[1]]]) {
        const value = ['string', 'number'].includes(typeof explicit) ? explicit : derived;
        if (!Object.hasOwn(context, key) && ['string', 'number'].includes(typeof value)) Object.defineProperty(context, key, { value, enumerable: true, writable: false });
      }
      const mutable = kind === 'before-context' ? ['triggerEntries', 'messages', 'context'] : kind === 'before-llm-messages' ? ['messages'] : [];
      const original = new Map(mutable.filter((key) => Object.hasOwn(context, key)).map((key) => [key, JSON.stringify(context[key])]));
      const responseBefore = kind === 'after-response' ? JSON.stringify(context.response?.message) : null;
      const result = await Promise.race([
        Promise.resolve().then(() => {
          if (!current()) throw controller.signal.reason ?? new Error('插件回调已失效');
          return legacyArgs ? fn(context.toolName, context.args, context) : fn(context);
        }),
        cancelled,
      ]);
      if (!current()) return;
      if (kind === 'after-response' && payload.response?.message && JSON.stringify(context.response?.message) !== responseBefore) {
        const message = callbackMessage(payload.response.message, context.response?.message);
        if (!current()) return; // Cloning must not let a retained getter outlive its lease.
        payload.response.message = message;
      }
      for (const [key, before] of original) {
        if (JSON.stringify(context[key]) === before) continue;
        const value = structuredClone(context[key]); // 不把插件保留的对象引用放回运行中的消息。
        if (Array.isArray(payload[key]) && Array.isArray(value)) payload[key].splice(0, payload[key].length, ...value);
        else if (key === 'context' && payload[key] && value && typeof value === 'object') {
          for (const property of Object.keys(payload[key])) delete payload[key][property];
          Object.assign(payload[key], value);
        }
      }
      return sanitizeSdkValue(result);
    } finally {
      clearTimeout(timer); removeAbort?.(); for (const release of cleanup) release();
      controller.abort(new Error('插件回调已结束'));
    }
  }

  function hooksOf(name, baseContext = {}) {
    const out = [];
    for (const e of entries.values()) {
      if (e.status !== 'active' || e.suspended) continue;
      const declared = e.hooks[name];
      const hooks = Array.isArray(declared) ? declared : typeof declared === 'function' ? [declared] : [];
      for (const fn of hooks.filter((value) => typeof value === 'function')) out.push({
        ownerId: e.manifest.id,
        managesTimeout: true,
        recordError: (error) => recordError(e.manifest.id, error, { hook: name }, e),
        fn: async (payload, ...args) => {
          if (entries.get(e.manifest.id) !== e || e.status !== 'active' || e.suspended) return;
          // Panel/tool-registry 仍使用 fn(toolId, args)；runner 使用对象上下文。
          const legacy = typeof payload === 'string';
          const context = legacy ? { ...baseContext, toolName: payload, args: args[0], argsRaw: JSON.stringify(args[0] ?? {}) } : { ...baseContext, ...payload };
          try { return await invokeCallback(e, name, context, fn, legacy ? args : null); }
          catch (error) { recordError(e.manifest.id, error, { hook: name }, e); throw error; }
        },
      });
    }
    return out; // 顺序 = 装载序（stable）
  }

  function recordError(ownerId, error, details = {}, expected = null) {
    const entry = entries.get(ownerId);
    if (!entry || (expected && expected !== entry)) return;
    entry.lastError = String(error?.message ?? error);
    entry.lastErrorAt = Date.now();
    bus?.emit('plugin.error', { id: ownerId, error: entry.lastError, phase: 'runtime', ...details });
  }

  function promptSections(context) {
    const out = [], snapshot = [...entries.values()];
    const active = e => entries.get(e.manifest.id) === e && e.status === 'active' && !e.suspended;
    const include = (e, section) => out.push({ entry: e, section });
    const finish = () => out.filter(({ entry }) => active(entry)).map(({ section }) => section)
      .sort((a, b) => b.priority - a.priority);
    for (const e of snapshot) {
      if (e.status !== 'active' || e.suspended) continue;
      for (const section of e.promptSections) include(e, section);
    }
    // 无上下文的旧调用仍同步读取静态清单；运行组装传 context 并 await 动态片段。
    if (context !== undefined) return (async () => {
      for (const e of snapshot) {
        if (!active(e) || typeof e.instance?.promptSections !== 'function') continue;
        try {
          const sections = await invokeCallback(e, 'promptSections', context, e.instance.promptSections.bind(e.instance));
          if (entries.get(e.manifest.id) !== e || e.status !== 'active' || e.suspended || context?.signal?.aborted) continue;
          for (const section of Array.isArray(sections) ? sections : []) {
            if (section && typeof section === 'object') include(e, { ...section, owner: e.manifest.id, priority: Math.min(99, section.priority != null && Number.isFinite(Number(section.priority)) ? Number(section.priority) : 40) });
          }
        } catch (error) { recordError(e.manifest.id, error, { hook: 'promptSections' }, e); log.warn?.(`[loader] ${e.manifest.id} 动态提示异常：${error?.message ?? error}`); }
      }
      // A later asynchronous provider may have yielded while an earlier owner
      // was unloaded, disabled or replaced. Recheck all static and dynamic
      // sections against their exact generation, never retain the old prefix.
      return context?.signal?.aborted ? [] : finish();
    })();
    // Skill 片段 priority 降序（稳定序：同 priority 保持装载序）
    return finish();
  }

  function closeWatchers() {
    watchEpoch++;
    watchPending = false;
    watchStarted = false;
    const closing = [...watchHandles.values()];
    watchHandles.clear();
    watchIdentities.clear();
    watchRecoveryDelays.clear();
    for (const timer of watchTimers.values()) clearTimeout(timer);
    watchTimers.clear();
    // Delete ownership first: a close notification must not schedule recovery.
    for (const watcher of closing) { try { watcher.close?.(); } catch {} }
  }

  function stopWatchers() {
    watchRequested = false;
    releaseWatchPreference?.();
    releaseWatchPreference = null;
    closeWatchers();
  }

  function queueWatchScan(key) {
    const epoch = watchEpoch;
    if (!watchStarted || stopped) return;
    const old = watchTimers.get(key); if (old) clearTimeout(old);
    watchTimers.set(key, setTimeout(() => {
      watchTimers.delete(key);
      if (watchStarted && !stopped && epoch === watchEpoch) void watchRescan();
    }, 500));
  }

  function queueWatchRecovery(key) {
    if (!watchStarted || stopped || watchTimers.has(`recovery:${key}`)) return;
    const epoch = watchEpoch, delay = Math.min((watchRecoveryDelays.get(key) ?? 250) * 2, 30000);
    watchRecoveryDelays.set(key, delay);
    const timer = setTimeout(() => {
      watchTimers.delete(`recovery:${key}`);
      if (watchStarted && !stopped && epoch === watchEpoch) void watchRescan();
    }, delay);
    timer.unref?.(); watchTimers.set(`recovery:${key}`, timer);
  }

  function watchIdentity(root) {
    try { const stat = fs.lstatSync(root); return stat.isDirectory() && !stat.isSymbolicLink() ? `${stat.dev}:${stat.ino}` : null; }
    catch { return null; }
  }

  function releaseWatcher(key) {
    const watcher = watchHandles.get(key);
    watchHandles.delete(key); watchIdentities.delete(key);
    try { watcher?.close?.(); } catch {}
  }

  function bindWatcher(key, root, recursive) {
    const identity = watchIdentity(root), previous = watchHandles.get(key);
    if (previous && identity === watchIdentities.get(key)) return;
    if (previous) releaseWatcher(key);
    if (!identity) return; // A stable parent notices a missing root being recreated.
    const epoch = watchEpoch;
    try {
      const watcher = watch(root, { recursive }, (_event, filename) => {
        if (!watchStarted || stopped || epoch !== watchEpoch || watchHandles.get(key) !== watcher) return;
        if (key.startsWith('parent') && filename != null && !Object.hasOwn(roots, String(filename).split(/[\\/]/)[0])) return;
        queueWatchScan(key);
      });
      watchHandles.set(key, watcher); watchIdentities.set(key, identity);
      watchRecoveryDelays.delete(key);
      const recovery = watchTimers.get(`recovery:${key}`);
      if (recovery) { clearTimeout(recovery); watchTimers.delete(`recovery:${key}`); }
      const lost = error => {
        if (!watchStarted || stopped || epoch !== watchEpoch || watchHandles.get(key) !== watcher) return;
        releaseWatcher(key);
        if (error) log.warn?.(`[loader] ${key} 监听中断：${error?.message ?? error}`);
        queueWatchRecovery(key);
      };
      watcher.on?.('error', lost);
      watcher.on?.('close', () => lost());
    } catch (error) {
      log.warn?.(`[loader] 无法监听 ${key}：${error?.message ?? error}`);
      queueWatchRecovery(key);
    }
  }

  function reconcileWatchers() {
    if (!watchStarted || stopped) return;
    // Root watches attach to directory identities, not names. Keep one
    // non-recursive parent watch so rename/replacement can rebind those roots.
    bindWatcher('parent', appRoot, false);
    if (path.resolve(extensionRoot) !== path.resolve(appRoot)) bindWatcher('parent-extensions', extensionRoot, false);
    for (const [kind, root] of Object.entries(roots)) bindWatcher(kind, root, true);
  }

  async function watchRescan() {
    if (!watchStarted || stopped) return;
    if (watchBusy) { watchPending = true; return; }
    watchBusy = true;
    const token = watchEpoch;
    try {
      do {
        watchPending = false;
        await loadAll({ reason: 'fs-watch', watchToken: token });
      } while (watchPending && watchStarted && !stopped && token === watchEpoch);
    } catch (err) { log.error?.(`[loader] fs.watch 重扫失败：${err?.stack || err}`); }
    finally { watchBusy = false; if (watchPending && watchStarted && !stopped) void watchRescan(); }
  }

  function startWatchers() {
    if (stopped) return;
    watchRequested = true;
    const syncPreference = () => {
      if (!watchRequested || stopped) return;
      if (config.get().skills?.watch === false || config.get().extensions?.hotReload === false) {
        if (watchStarted) closeWatchers();
        return;
      }
      if (watchStarted) { reconcileWatchers(); return; }
      watchStarted = true;
      for (const root of Object.values(roots)) {
        try { if (!fs.existsSync(root)) fs.mkdirSync(root, { recursive: true }); } catch {}
      }
      reconcileWatchers();
      // Also pick up edits made while the preference was off.
      void watchRescan();
    };
    if (!releaseWatchPreference) releaseWatchPreference = config.onChange?.(syncPreference) ?? null;
    syncPreference();
  }

  function stopAll() {
    stopped = true;
    stopWatchers();
    for (const pending of loadingEntries) { deactivate(pending); disposeEntry(pending); if (pending.rootKind !== 'bundled') permissions.unbindPlugin?.(pending.manifest.id); }
    for (const [id] of [...entries]) unload(id, 'shutdown');
  }

  return {
    loadAll, loadDir, withDirectoryUpdate, unload, pruneMissing, setEnabled, listEntries, startWatchers, stopWatchers,
    commandOf(name) {
      for (const entry of entries.values()) {
        if (entry.status === 'active' && !entry.suspended && entry.commands.has(name)) return entry.commands.get(name);
      }
      return null;
    },
    // 仅宿主适配器使用，永不把 ctx/dir 交给 iframe。
    hostEntry: (id) => entries.get(id) ?? null,
    contentCurrent(id, fingerprint = null) {
      const entry = entries.get(id);
      if (!entry?.fingerprint || (fingerprint && fingerprint !== entry.fingerprint)) return false;
      try { return freshFingerprint(entry.dir, entry.fingerprint); } catch { return false; }
    },
    hooksOf, promptSections, recordError, stopAll,
    isActive, isLoaded, isEnabled,isShared,
    skillSettings,
  };
}
