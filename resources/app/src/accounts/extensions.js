import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {removeCreatedInstallTree} from '../install/files.js';

const ID=/^[a-z0-9][a-z0-9._-]{0,127}$/i;
const MARKER='shared-extensions-migrated-v1.json';
export function plainExtensionDirectory(value,{create=false}={}){
  const absolute=path.resolve(value),parsed=path.parse(absolute);let current=parsed.root;
  for(const name of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)){
    current=path.join(current,name);
    if(create&&!fs.existsSync(current))fs.mkdirSync(current);
    const stat=fs.lstatSync(current);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('共享扩展路径包含链接或不是普通目录。');
  }
  return absolute;
}
function json(file,fallback=null){
  if(!fs.existsSync(file))return fallback;
  const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>8*1024*1024)throw Error('共享扩展迁移文件无效，已保留原文件。');
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function save(file,value){
  json(file);const temp=file+'.'+crypto.randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});fs.renameSync(temp,file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function packageInfo(dir,kind){
  plainExtensionDirectory(dir);
  const raw=json(path.join(dir,'skill.json'))??json(path.join(dir,'plugin.json'));
  if(!raw||!ID.test(raw.id??path.basename(dir)))throw Error('旧扩展清单无效，已保留原目录。');
  return {id:raw.id??path.basename(dir),kind:raw.kind==='plugin'?'plugins':raw.kind==='skill'?'skills':kind,enabledByDefault:raw.enabledByDefault!==false};
}
function inventory(root){
  const result=[];
  for(const kind of ['plugins','skills']){
    const folder=path.join(root,kind);if(!fs.existsSync(folder))continue;plainExtensionDirectory(folder);
    for(const name of fs.readdirSync(folder).sort()){
      const dir=path.join(folder,name),st=fs.lstatSync(dir);if(st.isSymbolicLink())throw Error('旧扩展目录包含链接，已保留原目录。');if(!st.isDirectory())continue;
      result.push({...packageInfo(dir,kind),dir});
    }
  }
  return result;
}
function copyTree(source,destination,{seed=false}={}){
  const st=fs.lstatSync(source);if(st.isSymbolicLink())throw Error('扩展迁移不接受符号链接。');
  if(st.isDirectory()){
    plainExtensionDirectory(destination,{create:true});
    for(const name of fs.readdirSync(source))copyTree(path.join(source,name),path.join(destination,name),{seed});
  }else{
    if(!st.isFile())throw Error('扩展迁移不接受特殊文件。');
    if(fs.existsSync(destination)){const existing=fs.lstatSync(destination);if(existing.isSymbolicLink()||!existing.isFile())throw Error('扩展目标文件无效。');if(seed)return;throw Error('共享扩展目标已存在。');}
    fs.copyFileSync(source,destination,fs.constants.COPYFILE_EXCL);
  }
}
function sameCode(a,b){
  function hashes(root){const rows=[];function walk(dir,rel=''){for(const name of fs.readdirSync(dir).sort()){if(!rel&&name==='data')continue;const file=path.join(dir,name),st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('扩展目录包含链接。');if(st.isDirectory())walk(file,path.join(rel,name));else rows.push([path.join(rel,name),crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]);}}walk(root);return JSON.stringify(rows);}
  return hashes(a)===hashes(b);
}

/** Package code is shared; settings, switches and SDK/legacy data stay in each profile. */
export function createSharedExtensionStore({extensionRoot,dataDir,config}={}){
  const shared=path.resolve(extensionRoot),home=path.resolve(dataDir);let prepared=false,conflicts=[];
  function prepare(records=[]){
    if(prepared)return {root:shared,conflicts};
    plainExtensionDirectory(shared,{create:true});for(const kind of ['plugins','skills'])plainExtensionDirectory(path.join(shared,kind),{create:true});
    const owners=[{id:'primary',dataDir:home,extensionRoot:shared,primary:true},...records.map(row=>({id:row.id,dataDir:path.join(home,'accounts',row.id,'data'),extensionRoot:path.join(home,'accounts',row.id,'extensions')}))];
    // Capture ownership before importing any other account's package.
    const plans=owners.map(owner=>{
      if(!fs.existsSync(owner.dataDir))return null;plainExtensionDirectory(owner.dataDir);
      if(json(path.join(owner.dataDir,MARKER))?.version===1)return null;
      const saved=owner.primary?structuredClone(config.get()):json(path.join(owner.dataDir,'config.json'));
      if(!saved||typeof saved!=='object'||Array.isArray(saved))return null;
      if(!owner.primary&&fs.existsSync(path.join(owner.dataDir,'qq-agent.lock'))){
        const lock=path.join(owner.dataDir,'qq-agent.lock'),st=fs.lstatSync(lock);if(st.isSymbolicLink()||!st.isFile()||st.size>64)throw Error('账号实例锁无效，未迁移扩展。');
        const pid=Number(fs.readFileSync(lock,'utf8').trim());if(!Number.isSafeInteger(pid)||pid<1)throw Error('账号实例锁无效，未迁移扩展。');
        let alive=true;try{process.kill(pid,0);}catch(error){alive=error.code!=='ESRCH';}if(alive)throw Error('账号扩展仍有其它实例在运行，请先退出该实例。');
      }
      return {...owner,saved,packages:fs.existsSync(owner.extensionRoot)?inventory(owner.extensionRoot):[]};
    }).filter(Boolean);
    const installed=new Map(inventory(shared).map(item=>[item.id.toLowerCase(),item]));
    for(const plan of plans){
      const skills=structuredClone(plan.saved.skills??{});
      for(const item of plan.packages){
        if(skills[item.id]?.enabled===undefined)skills[item.id]={...(skills[item.id]??{}),enabled:item.enabledByDefault};
        // Copy old package-local data into the owning profile, never into another profile.
        const privateData=path.join(plan.dataDir,'plugins',item.id,'legacy-data');plainExtensionDirectory(privateData,{create:true});
        if(fs.existsSync(path.join(item.dir,'data')))copyTree(path.join(item.dir,'data'),privateData,{seed:true});
        const previous=installed.get(item.id.toLowerCase());
        if(!previous){
          const domain=path.join(shared,item.kind),temporary=fs.mkdtempSync(path.join(domain,'.shared-import-')),destination=path.join(domain,item.id);
          try{copyTree(item.dir,temporary);fs.renameSync(temporary,destination);installed.set(item.id.toLowerCase(),{...item,dir:destination});}
          finally{if(fs.existsSync(temporary))removeCreatedInstallTree(temporary,domain);}
        }else if(path.resolve(previous.dir)!==path.resolve(item.dir)&&!sameCode(previous.dir,item.dir))conflicts.push({id:item.id,account:plan.id,retained:'shared',originalPreserved:true});
      }
      if(plan.primary){if(JSON.stringify(skills)!==JSON.stringify(plan.saved.skills??{}))config.update({skills:{__replace__:skills}});}else save(path.join(plan.dataDir,'config.json'),{...plan.saved,skills});
      save(path.join(plan.dataDir,MARKER),{version:1,imported:plan.packages.map(item=>item.id),conflicts:conflicts.filter(row=>row.account===plan.id)});
    }
    prepared=true;return {root:shared,conflicts};
  }
  function newAccountConfig(value){
    const initial=structuredClone(value),skills=initial.skills??{};
    for(const item of inventory(shared))skills[item.id]={enabled:false,settings:{}};
    initial.skills=skills;return initial;
  }
  function markNewAccount(dir){save(path.join(plainExtensionDirectory(dir),MARKER),{version:1,imported:[]});}
  return {root:shared,prepare,newAccountConfig,markNewAccount,get prepared(){return prepared;}};
}
