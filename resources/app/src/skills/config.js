import {host} from '../../.compat-04/host.js';
host().use('src/skills/config.js');
export function getSkillConfig(id,defaults={}){return {...defaults,...host().ownConfig(id)};}
export function isSkillEnabledInConfig(id){host().ownConfig(id);return host().enabled();}
export function listConfiguredSkillIds(){return [host().id];}
export function setSkillConfig(){throw Error('[COMPAT04_CONFIG_WRITE] 旧插件不能直接写配置，请使用 SDK 配置接口');}
export function setSkillEnabled(){return setSkillConfig();}