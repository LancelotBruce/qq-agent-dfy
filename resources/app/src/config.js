import {host} from '../.compat-04/host.js';
import {personaForChat as corePersonaForChat} from './kernel/persona.js';
export const ROOT=host().root;
export const DATA_DIR=host().use('src/config.js').dataDir;
export function getConfig(){host().use('src/config.js');return host().getConfig();}
export function updateConfig(patch){host().use('src/config.js');const pending=host().applyConfig(patch);if(pending&&typeof pending.catch==='function')pending.catch(error=>{try{host().log.warn('[compat-04] 旧插件写配置失败：'+String(error&&error.message||error))}catch{}});return pending;}
export function setRuntimeConfig(patch){return updateConfig(patch);}
export function loadConfig(){return getConfig();}
export function personaForChat(a,b){const bare=typeof b==='undefined';const cfg=bare?getConfig():a;const chatKey=bare?a:b;return corePersonaForChat(cfg,String(chatKey??''));}