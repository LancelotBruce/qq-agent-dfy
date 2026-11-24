import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const failure = (code, message) => Object.assign(Error(`[${code}] ${message}`), {code});
const clone = value => value === undefined ? undefined : structuredClone(value);

// --- 0.4 私有模块补充垫片（2026-11-14 本机补丁）----------------------------------
// 作者 0.5 只给旧插件投影了 src/config.js、src/skills/config.js、src/onebot.js、
// src/thinking.js 四个模块，其余 src/* 一律 ERR_MODULE_NOT_FOUND。
// 这里按同一套"每代一次性投影"的方式补上 logger / llm / safe-fetch / plugin-loader，
// 并把 config.js 补齐成可读全配置、可经控制台 API 落盘（实时生效）的版本。
const CONFIG_CACHE = new Map();
function readRawConfig(accountData) {
  const file = path.join(accountData, 'config.json');
  const stat = fs.statSync(file);
  const key = file + ':' + stat.mtimeMs + ':' + stat.size;
  const hit = CONFIG_CACHE.get(file);
  if (hit && hit.key === key) return structuredClone(hit.value);
  let text = fs.readFileSync(file, 'utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const value = JSON.parse(text);
  CONFIG_CACHE.set(file, {key, value});
  return structuredClone(value);
}
// 旧插件的 updateConfig 走控制台自己的 POST /api/config，内存与磁盘一起改，
// 不直接碰 config.json，避免"插件写了文件、运行中的宿主还拿旧值"。
async function postConfigPatch(accountData, patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw failure('COMPAT04_CONFIG_WRITE', '配置补丁必须是对象');
  const raw = readRawConfig(accountData);
  const port = Number(raw?.server?.port) || 3210;
  const token = String(raw?.server?.token ?? '');
  const response = await fetch('http://127.0.0.1:' + port + '/api/config', {
    method: 'POST',
    headers: {'content-type': 'application/json', ...(token ? {'x-console-token': token} : {})},
    body: JSON.stringify(patch),
  });
  if (!response.ok) throw failure('COMPAT04_CONFIG_WRITE', '写配置失败 HTTP ' + response.status + '：' + (await response.text()).slice(0, 160));
  CONFIG_CACHE.delete(path.join(accountData, 'config.json'));
  return await response.json().catch(() => ({ok: true}));
}

// These are per-generation surrogate methods, NEVER the live client's class.
// Old prototype wrappers run against a message copy and have no send/connection
// handle. Only the image display flag is accepted back by the transport.
export function createLegacyOneBotClient(host) {
  class OneBotClient {
    constructor() { if (!host.transforming) throw failure('COMPAT04_CLIENT_CONSTRUCTION', '旧客户端仅用于兼容消息样式，不能创建另一条 QQ 连接'); }
    sendSegments(_kind, _id, segments) { return segments; }
    sendSticker(kind, id, _image, _options) { return this.sendSegments(kind, id, clone(host.segments)); }
  }
  host.use('src/onebot.js');
  host.clientClass = OneBotClient;
  host.registerClient();
  return OneBotClient;
}

function thinkingProvider(provider) {
  if (!provider || typeof provider.detect !== 'function' || typeof provider.build !== 'function' || typeof provider.strip !== 'function') throw failure('COMPAT04_THINKING_PROVIDER_MISSING', '旧思考接口需要一个已启用的 llm.dialect 提供者');
  return provider;
}
export function resolveThinkingRequest(api = {}, context = {}, provider) {
  let effort = String(api.thinkingEffort ?? '').toLowerCase();
  if (!['off', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) effort = api.thinkingMode === 'off' ? 'off' : api.thinkingMode === 'on' ? 'high' : '';
  if (context.thinkingMode === 'off') effort = 'off';
  const dialect = thinkingProvider(provider).detect(api.baseUrl ?? '', api.model ?? '');
  return {dialect, effort, on: Boolean(effort) && effort !== 'off', budget: Math.max(0, Number(api.thinkingBudget) || 0)};
}
export function buildThinkingParams({effort = '', ...options} = {}, provider) {
  const mode = effort === 'off' ? 'off' : effort ? 'on' : 'default';
  const result = thinkingProvider(provider).build({...options, effort, mode, on: mode === 'on'});
  return {...result, applied: Object.keys(result.params ?? {}).length > 0};
}
export function stripThinkingParams(body, provider) { return thinkingProvider(provider).strip(body); }

// Read old plugin-private state once; existing new state always wins. Do not
// copy config.json, account records or another plugin's directory.
function seedState(source, target) {
  let budget = 64 * 1024 * 1024;
  function copy(from, to) {
    const stat = fs.lstatSync(from);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) throw failure('COMPAT04_DATA_LINK', '旧插件资料包含链接或特殊文件，未自动复制');
    if (fs.existsSync(to) && fs.lstatSync(to).isSymbolicLink()) throw failure('COMPAT04_DATA_LINK', '插件资料目标包含链接，未自动复制');
    if (stat.isDirectory()) {
      fs.mkdirSync(to, {recursive: true});
      for (const name of fs.readdirSync(from)) copy(path.join(from, name), path.join(to, name));
    } else if (!fs.existsSync(to)) {
      if ((budget -= stat.size) < 0) throw failure('COMPAT04_DATA_BUDGET', '旧插件资料超过自动复制上限，原资料已保留');
      fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
    }
  }
  if (fs.existsSync(source)) copy(source, target);
}

export function createHostModuleAdapter({ctx, manifest, onUse = () => {}, apiLimits = () => ({}), isCurrent = () => true, dialect = () => null, registerTransform}) {
  const helpers = JSON.stringify(import.meta.url);
  let runtime;
  let directoryReady = false;
  // 数据根：ctx.storage.dir = <data>/plugins/<id>，上两级即 <data>
  function accountData() { return path.resolve(ctx.storage.dir, '../..'); }
  // 补丁：0.4 的 DATA_DIR 是**数据根**（data/），不是插件私有目录。
  // 旧插件自己会拼 DATA_DIR/<插件名>、DATA_DIR/sessions、DATA_DIR/memory-v2，
  // 所以这里必须返回数据根，否则会多套一层、读出空库。
  function privateDirectory() {
    const dataDir = accountData();
    if (!directoryReady) {
      for (let current = dataDir; ; current = path.dirname(current)) {
        if (fs.existsSync(current) && (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink())) throw failure('COMPAT04_DATA_LINK', '插件资料目录包含链接或不是文件夹');
        if (path.dirname(current) === current) break;
      }
      fs.mkdirSync(dataDir, {recursive: true});
      directoryReady = true;
    }
    return dataDir;
  }
  const use = feature => { onUse(feature); return runtime; };
  const requireOwn = id => {
    if (id !== manifest.id) throw failure('COMPAT04_OTHER_CONFIG', '旧插件不能通过配置模块读取或修改其它扩展的设置');
    return ctx.config.all();
  };
  return {
    // Old disk patches must never reach the live UI or Electron boot code via
    // the import generation's convenience junctions.
    detachedRoots: ['ui', 'electron'],
    files: {
      '.compat-04/host.js': 'let value; export function bind(runtime){if(value)throw Error("兼容模块重复绑定");value=runtime;} export function host(){if(!value)throw Error("兼容模块尚未绑定");return value;}',
      'src/config.js': `import {host} from '../.compat-04/host.js';
import {personaForChat as corePersonaForChat} from './kernel/persona.js';
export const ROOT=host().root;
export const DATA_DIR=host().use('src/config.js').dataDir;
export function getConfig(){host().use('src/config.js');return host().getConfig();}
export function updateConfig(patch){host().use('src/config.js');const pending=host().applyConfig(patch);if(pending&&typeof pending.catch==='function')pending.catch(error=>{try{host().log.warn('[compat-04] 旧插件写配置失败：'+String(error&&error.message||error))}catch{}});return pending;}
export function setRuntimeConfig(patch){return updateConfig(patch);}
export function loadConfig(){return getConfig();}
export function personaForChat(a,b){const bare=typeof b==='undefined';const cfg=bare?getConfig():a;const chatKey=bare?a:b;return corePersonaForChat(cfg,String(chatKey??''));}`,
      'src/skills/config.js': `import {host} from '../../.compat-04/host.js';
host().use('src/skills/config.js');
export function getSkillConfig(id,defaults={}){return {...defaults,...host().ownConfig(id)};}
export function isSkillEnabledInConfig(id){host().ownConfig(id);return host().enabled();}
export function listConfiguredSkillIds(){return [host().id];}
export function setSkillConfig(){throw Error('[COMPAT04_CONFIG_WRITE] 旧插件不能直接写配置，请使用 SDK 配置接口');}
export function setSkillEnabled(){return setSkillConfig();}`,
      'src/onebot.js': `import {host} from '../.compat-04/host.js'; import {createLegacyOneBotClient} from ${helpers}; export const OneBotClient=createLegacyOneBotClient(host());`,
      'src/thinking.js': `import {host} from '../.compat-04/host.js'; import * as implementation from ${helpers};
host().use('src/thinking.js');
export function resolveThinkingRequest(api,context){return implementation.resolveThinkingRequest(api,context,host().dialect());}
export function buildThinkingParams(options){return implementation.buildThinkingParams(options,host().dialect());}
export function stripThinkingParams(body){return implementation.stripThinkingParams(body,host().dialect());}`,
      // 补丁：旧插件的日志接口（0.4 src/logger.js）→ 插件自己的 ctx.log
      'src/logger.js': `import {host} from '../.compat-04/host.js';
const flatten=args=>args.map(value=>{if(typeof value==='string')return value;try{return JSON.stringify(value)}catch{return String(value)}}).join(' ');
function emit(level,args){host().use('src/logger.js');try{const sink=host().log;const fn=sink&&(sink[level]||sink.info);if(typeof fn==='function')fn.call(sink,'[legacy] '+flatten(args))}catch{}}
export const logger={info:(...args)=>emit('info',args),warn:(...args)=>emit('warn',args),error:(...args)=>emit('error',args),debug:(...args)=>emit('debug',args),trace:(...args)=>emit('trace',args),child:()=>logger};
export const log=logger;
export default logger;`,
      // 补丁：旧插件的模型接口（0.4 src/llm.js）→ 0.5 内核 chatCompletion
      'src/llm.js': `import {host} from '../.compat-04/host.js';
import * as core from './kernel/llm.js';
export function resolveApiKey(cfg){host().use('src/llm.js');return core.resolveApiKey(cfg||host().rawConfig());}
export async function chatCompletion(args={}){host().use('src/llm.js');return core.chatCompletion({...args,cfg:host().rawConfig(),log:host().log});}
export async function chatCompletionWithRetry(args,retries=2){let last;for(let attempt=0;attempt<=retries;attempt++){try{return await chatCompletion(args)}catch(error){last=error;if(!core.isRetryableError(error))throw error;await new Promise(resolve=>{const timer=setTimeout(resolve,1000*Math.pow(2,attempt));timer.unref?.()})}}throw last}
export const {emptyUsage,addUsage,usageTotals,cacheHitRate,isRetryableError,extractReasoning}=core;`,
      // 补丁：旧插件的下载接口（0.4 src/safe-fetch.js）→ 0.5 内核 safeFetch（同一套 SSRF 口径）
      'src/safe-fetch.js': `import {safeFetch} from './kernel/safe-fetch.js';
export async function safeFetchBinary(url,maxBytes=10485760){const res=await safeFetch(String(url),{maxBytes:Math.max(1024,Number(maxBytes)||10485760),expectBinary:true,timeoutMs:20000});if(!(res.status>=200&&res.status<300))throw Error('下载失败 HTTP '+res.status);const body=res.body;const headers=res.headers;const contentType=String((headers&&(headers.get?headers.get('content-type'):headers['content-type']))||'');return{buffer:Buffer.isBuffer(body)?body:Buffer.from(String(body??''),'utf8'),contentType,status:res.status,finalUrl:res.finalUrl};}
export const safeFetchImpl=safeFetch;`,
      // 补丁：旧插件里"重扫扩展"的入口在 0.5 没有对应私有 API，明确告知而不静默失败
      'src/plugin-loader.js': `export function loadPlugins(){throw Error('0.5 由控制台「扩展」页统一重扫，旧插件内的重扫入口不可用');}
export default {loadPlugins};`,
    },
    async bind(mirror) {
      runtime = {id: manifest.id, root: mirror, isCurrent, dialect, log: ctx.log, get dataDir() { return privateDirectory(); }, use, ownConfig: requireOwn,
        registerClient: () => registerTransform(runtime),
        enabled: () => ctx.config.all().enabled !== false,
        rawConfig: () => readRawConfig(accountData()),
        // 补丁：旧插件读到的配置从"只给 api.maxRounds + 自己设置"扩成"真实全配置"，
        // 但自己的 skills 段仍按 0.4 口径归一（enabled + settings），不影响原有读取习惯。
        getConfig: () => {
          const raw = readRawConfig(accountData());
          const own = clone(requireOwn(manifest.id)) || {};
          const enabled = own.enabled !== false;
          delete own.enabled;
          const limits = clone(apiLimits()) || {};
          return {...raw, api: {...(raw.api ?? {}), ...limits},
            skills: {...(raw.skills ?? {}), [manifest.id]: {enabled, settings: own}}};
        },
        applyConfig: (patch) => postConfigPatch(accountData(), patch),
      };
      const control = await import(pathToFileURL(path.join(mirror, '.compat-04/host.js')).href);
      control.bind(runtime);
    },
    verify(mirror) {
      for (const directory of this.detachedRoots) if (fs.readdirSync(path.join(mirror, directory)).length) {
        throw failure('COMPAT04_HOST_PATCH_UNSUPPORTED', '旧插件尝试直接修改宿主界面或启动代码；当前仅改到了隔离副本，未应用到程序。需要作者改用 SDK 扩展接口');
      }
      for (const [name, source] of Object.entries(this.files)) if (fs.readFileSync(path.join(mirror, name), 'utf8') !== source) {
        throw failure('COMPAT04_HOST_PATCH_UNSUPPORTED', '旧插件尝试改写宿主兼容模块，修改未应用到程序');
      }
    },
  };
}

export function transformLegacySticker(runtime, {kind, id, segments}) {
  const Client = runtime.clientClass;
  if (!Client) return clone(segments);
  runtime.transforming = true; runtime.segments = segments;
  try {
    const result = new Client().sendSticker(kind, id, segments.find(s => s.type === 'image')?.data?.file, {});
    // Async wrappers, new segments, destinations and arbitrary content changes
    // are outside this adapter. Fail clearly instead of sending another payload.
    if (!Array.isArray(result) || result.length !== segments.length) {
      if (result instanceof Promise) result.catch(() => {});
      throw failure('COMPAT04_MESSAGE_PATCH', '旧发送补丁改变了消息结构，不能安全兼容');
    }
    return result.map((segment, index) => {
      const original = segments[index], allowed = clone(original);
      if (original.type === 'image' && segment?.data?.sub_type !== undefined && original.data.sub_type == null) {
        const value = segment.data.sub_type;
        if (!Number.isInteger(value) || value < 0 || value > 1) throw failure('COMPAT04_MESSAGE_PATCH', '旧发送补丁给出了无效的表情类型');
        allowed.data.sub_type = value;
      }
      if (JSON.stringify(allowed) !== JSON.stringify(segment)) throw failure('COMPAT04_MESSAGE_PATCH', '旧发送补丁尝试改变消息内容，已拒绝');
      return allowed;
    });
  } finally { runtime.transforming = false; runtime.segments = null; }
}
