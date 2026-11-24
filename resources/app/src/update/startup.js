import fs from 'node:fs';
import path from 'node:path';
import {updateHome} from './layout.js';
const read=file=>{try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}};
// An ordinary double-click during installation must never open stores on a
// half-replaced program tree. Only the helper's identified boot may bypass it.
export function updateLaunchState({installRoot,appRoot,env=process.env}={}){
  const home=updateHome(installRoot,env),lockFile=path.join(home,'update.lock');
  if(!fs.existsSync(lockFile))return{allowed:true};const lock=read(lockFile);
  const denied={allowed:false,reason:'QQA 正在更新或恢复，请等待完成后再打开。若上次更新意外中断，请先使用更新目录中的恢复副本恢复。'};
  if(!lock||!/^[a-f0-9-]{36}$/.test(lock.id))return denied;
  const directory=path.join(home,lock.id),state=read(path.join(directory,'state.json'));
  if(['downloaded','complete','rolledBack','error','cancelled','rollbackFailed'].includes(state?.phase))return{allowed:true};
  const jobFile=path.join(directory,'job.json'),job=read(jobFile);
  if(env.QQ_AGENT_UPDATE_JOB&&path.resolve(env.QQ_AGENT_UPDATE_JOB).toLowerCase()===jobFile.toLowerCase()&&job?.schema===1&&job.id===lock.id&&/^[a-f0-9]{64}$/.test(job.nonce)&&['upgrade','rollback'].includes(job.bootMode)&&typeof job.installRoot==='string'&&typeof job.appRoot==='string'&&path.resolve(job.installRoot).toLowerCase()===path.resolve(installRoot).toLowerCase()&&path.resolve(job.appRoot).toLowerCase()===path.resolve(appRoot).toLowerCase())return{allowed:true};
  return denied;
}
