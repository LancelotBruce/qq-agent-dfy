// 人设细节库管理面板 —— 0.5 组合层桥接
//
// 背景：0.4 的 persona-detail 靠 api.registerPluginRoutes() 自注册 13 条
// /api/persona-detail/* 路由（含 admin.html 管理页）。0.5 不再给插件这条通道，
// 官方替代是 overrides/ 组合层里的「路由贡献」。这个层不重写任何业务逻辑：
// 直接加载扩展运行时快照里的同一份技能模块，把技能自己的路由表挂到宿主作用域，
// 档案读写、备份、待确认队列、查询统计全部沿用技能自身实现，行为与 0.4 一致。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ROOT, resolveDataDir } from '../../src/kernel/env.js';

const SKILL = 'persona-detail';
const ROUTES = [
  ['GET', '/api/persona-detail/ui'],
  ['GET', '/api/persona-detail/entries'],
  ['POST', '/api/persona-detail/entries'],
  ['POST', '/api/persona-detail/delete'],
  ['POST', '/api/persona-detail/import'],
  ['GET', '/api/persona-detail/staging'],
  ['POST', '/api/persona-detail/staging'],
  ['GET', '/api/persona-detail/export'],
  ['GET', '/api/persona-detail/backups'],
  ['POST', '/api/persona-detail/backups'],
  ['POST', '/api/persona-detail/restore'],
  ['GET', '/api/persona-detail/queries'],
  ['GET', '/api/persona-detail/simulate'],
];

const reqBodies = new WeakMap();
let pending = null;

function sendJson(res, status, payload) {
  if (!res || res.writableEnded) return;
  const text = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-cache',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function dataRoots() {
  const roots = [];
  try { roots.push(resolveDataDir()); } catch { /* 取不到环境就只看安装根 */ }
  try {
    const installRoot = path.resolve(APP_ROOT, '..', '..');
    for (const name of fs.readdirSync(installRoot)) {
      if (/^data(?:-\d+)?$/i.test(name)) roots.push(path.join(installRoot, name));
    }
  } catch { /* 目录读不到忽略 */ }
  return [...new Set(roots)];
}

/** 找最新一份含 persona-detail 的新鲜副本 + src 垫片的运行时快照。
 *  注意：别的插件快照里 persona-detail 只是到 extensions 的 junction，从那里 import
 *  会被 Node 解析回 extensions 真实路径，导致 ../../src 解析失败——必须挑真副本。 */
function findSkillEntry() {
  for (const root of dataRoots()) {
    const cache = path.join(root, 'extension-cache');
    let dirs = [];
    try {
      dirs = fs.readdirSync(cache, { withFileTypes: true })
        .filter((item) => item.isDirectory())
        .map((item) => path.join(cache, item.name))
        .sort((left, right) => {
          try { return fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs; } catch { return 0; }
        });
    } catch { continue; }
    for (const dir of dirs) {
      const skillDir = path.join(dir, 'app', 'skills', SKILL);
      const entry = path.join(skillDir, 'index.js');
      const configShim = path.join(dir, 'app', 'src', 'config.js');
      try {
        if (fs.lstatSync(skillDir).isSymbolicLink()) continue;
        if (!fs.existsSync(entry) || !fs.existsSync(configShim)) continue;
        return entry;
      } catch { continue; }
    }
  }
  return null;
}

async function buildRoutes() {
  const entry = findSkillEntry();
  if (!entry) throw new Error(`在 extension-cache 里找不到 ${SKILL} 的运行时快照`);
  const module = await import(pathToFileURL(entry).href);
  const internals = module?.internals;
  if (!internals || typeof internals.registerHttpRoutes !== 'function') {
    throw new Error('技能模块未导出 registerHttpRoutes（检查 index.js 的 internals 段）');
  }
  let getConfig = null;
  try {
    const configModule = await import(pathToFileURL(path.join(path.dirname(entry), '..', '..', 'src', 'config.js')).href);
    getConfig = typeof configModule?.getConfig === 'function' ? configModule.getConfig : null;
  } catch { /* 配置垫片不可用时按空配置走 storeDir.hint 兜底 */ }

  const collected = [];
  internals.setApi({
    config: () => {
      try { return getConfig?.()?.skills?.[SKILL]?.settings ?? {}; } catch { return {}; }
    },
    json: (res, status, payload) => sendJson(res, status, payload),
    readBody: async (req) => reqBodies.get(req) ?? {},
    registerPluginRoutes: (id, routes) => {
      collected.push(...(Array.isArray(routes) ? routes : []));
      return { registered: collected.length, id };
    },
  });
  internals.registerHttpRoutes();
  if (!collected.length) throw new Error('技能没有产出管理路由');
  return collected;
}

function routes() {
  if (!pending) {
    pending = buildRoutes();
    pending.catch(() => { pending = null; });
  }
  return pending;
}

export function register(scopedHttp) {
  for (const [method, pattern] of ROUTES) {
    scopedHttp.route(method, pattern, async ({ req, res, params, body }) => {
      reqBodies.set(req, body ?? {});
      let list;
      try { list = await routes(); }
      catch (error) {
        return sendJson(res, 503, { ok: false, error: `人设细节库管理接口未就绪：${String(error?.message || error)}` });
      }
      const record = list.find((item) => String(item.method).toUpperCase() === method && item.pattern === pattern);
      if (!record) return sendJson(res, 503, { ok: false, error: `技能未注册该路由：${method} ${pattern}` });
      return record.handler({ req, res, params });
    });
  }
}
