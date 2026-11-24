// Side-by-side installation: copy user-owned data, never execute or remove the
// old application. This module also runs under the shipped Electron Node mode.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {installationPath,readInstallationState,INSTALL_STATE_FILE} from './state.js';
import {sha256File,removeCreatedInstallTree} from './files.js';
import {migrateFrom04} from '../kernel/migrator.js';
import {installFailure} from './diagnostics.js';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const within=(child,parent)=>{const rel=path.relative(parent,child);return !rel||rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel);};
function ordinaryRoot(value){
  if(typeof value!=='string'||!path.isAbsolute(value)||/[\0\r\n]/.test(value))throw Error('必须选择绝对路径');
  const root=path.resolve(value);
  if(root===path.parse(root).root)throw Error('不能选择磁盘根目录');
  installationPath(root,'.qqa-path-check');
  if(fs.existsSync(root)&&!fs.lstatSync(root).isDirectory())throw Error('目标必须是文件夹');
  return root;
}
export function inspectCopySource(value){
  const root=ordinaryRoot(value);
  if(!fs.existsSync(root))throw installFailure('SOURCE_NOT_FOUND','旧版目录不存在',{Path:root});
  let metadata=null,appRoot=null;
  for(const base of [path.join(root,'resources','app'),root]){
    const file=installationPath(root,path.relative(root,path.join(base,'package.json')));
    if(!fs.existsSync(file))continue;
    let item;try{item=read(file);}catch(error){if(error instanceof SyntaxError)throw installFailure('SOURCE_INVALID','旧版版本文件损坏',{Path:file});throw error;}
    if(['qq-agent','qqa'].includes(String(item.name).toLowerCase())&&/^0\.[45](?:\.|-)/.test(item.version??'')){metadata=item;appRoot=base;break;}
  }
  if(!metadata&&process.env.APPDATA&&path.relative(root,path.resolve(process.env.APPDATA,'qq-agent'))===''&&fs.existsSync(path.join(root,'data','config.json'))){metadata={name:'qq-agent',version:'0.4.0'};appRoot=root;}
  if(!metadata)throw installFailure('SOURCE_INVALID','所选文件夹不是受支持的 QQ Agent 0.4/0.5 目录',{Path:root});
  const installed=readInstallationState(root);
  const baseData=installed?.dataRoot??path.join(root,'data');
  const extensionRoot=installed?.extensionRoot??appRoot;
  const profiles=[];
  const parent=path.dirname(baseData),base=path.basename(baseData);
  if(fs.existsSync(parent))for(const name of fs.readdirSync(parent)){
    if(name!==base&&!(name.startsWith(base+'-')&&/^\d+$/.test(name.slice(base.length+1))))continue;
    const source=installationPath(root,path.relative(root,path.join(parent,name)));
    if(fs.existsSync(path.join(source,'config.json')))profiles.push({source,name:'data-v05'+name.slice(base.length)});
  }
  // Some portable 0.4 builds stored data beside package.json rather than exe.
  if(!profiles.length&&appRoot!==root&&fs.existsSync(path.join(appRoot,'data','config.json')))
    profiles.push({source:installationPath(root,path.relative(root,path.join(appRoot,'data'))),name:'data-v05'});
  if(!profiles.length&&/^0\.4(?:\.|-)/.test(metadata.version)&&process.env.APPDATA){
    const fallback=path.resolve(process.env.APPDATA,'qq-agent','data');
    ordinaryRoot(fallback);
    if(fs.existsSync(path.join(fallback,'config.json')))profiles.push({source:fallback,name:'data-v05'});
  }
  return{root,appRoot,version:String(metadata.version),legacy:/^0\.4(?:\.|-)/.test(metadata.version),profiles,extensionRoot};
}
export function validateNewInstallTarget(value,{sourceRoot=null,otherRoots=[]}={}){
  const root=ordinaryRoot(value);
  for(const old of [sourceRoot,...otherRoots].filter(Boolean)){
    const source=ordinaryRoot(old);
    if(within(root,source)||within(source,root))throw installFailure('TARGET_OVERLAP','新安装目录不能与旧版目录相同、重叠或互相包含',{Path:source});
  }
  if(fs.existsSync(root)&&fs.readdirSync(root).length)throw installFailure('TARGET_NOT_EMPTY','安装目录必须为空；不会覆盖已有文件',{Path:root});
  return root;
}

const transient=name=>/^(?:electron-user-data|\.cache|qq-agent\.lock|boot-diag\.log|.*\.tmp)$/i.test(name);
function inventory(root){
  const rows=[];
  function visit(directory,relative=''){
    installationPath(root,relative||'.qqa-path-check');
    for(const item of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
      if(transient(item.name))continue;
      const rel=path.join(relative,item.name),file=path.join(root,rel),stat=fs.lstatSync(file);
      if(stat.isSymbolicLink()||!stat.isDirectory()&&!stat.isFile())throw installFailure('PATH_LINK','迁移目录包含链接或特殊文件',{Path:file});
      installationPath(root,rel);
      if(stat.isDirectory()){rows.push({relative:rel,kind:'directory'});visit(file,rel);}
      else rows.push({relative:rel,kind:'file',bytes:stat.size,hash:sha256File(file)});
    }
  }
  visit(root);return rows;
}
function copyVerified(source,target,rows){
  fs.mkdirSync(target,{recursive:true});
  for(const row of rows){
    const from=installationPath(source,row.relative),to=installationPath(target,row.relative);
    if(row.kind==='directory')fs.mkdirSync(to,{recursive:true});
    else{
      fs.mkdirSync(path.dirname(to),{recursive:true});fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
      if(sha256File(from)!==row.hash)throw installFailure('SOURCE_CHANGED','复制期间源文件发生变化，请关闭旧版后重试',{Path:from});
      if(sha256File(to)!==row.hash)throw installFailure('COPY_VERIFY_FAILED','复制文件校验失败',{Path:to});
    }
  }
}
const pathKeys=/^(?:path|file|localFile|localPath|imagePath|mediaPath|backgroundImage|backgroundMedia|directory|dir|root|dataDir|extensionRoot|cacheRoot)$/i;
function relocated(value,mappings){
  if(typeof value!=='string')return value;
  for(const [from,to]of mappings)if(value===from||value.startsWith(from+path.sep)||value.startsWith(from+'/'))return to+value.slice(from.length);
  return value;
}
function rewritePaths(directory,mappings){
  const rewrite=(value,all=false,key='')=>Array.isArray(value)?value.map(item=>rewrite(item,all,key)):value&&typeof value==='object'
    ?Object.fromEntries(Object.entries(value).map(([name,item])=>[name,rewrite(item,all,name)])):(all||pathKeys.test(key)?relocated(value,mappings):value);
  function visit(dir){for(const item of fs.readdirSync(dir,{withFileTypes:true})){
    const file=path.join(dir,item.name);
    if(item.isDirectory())visit(file);
    else if(item.name.endsWith('.jsonl')){
      const before=fs.readFileSync(file,'utf8');
      const after=before.split('\n').map(line=>{try{const value=JSON.parse(line),updated=rewrite(value);return JSON.stringify(updated)===JSON.stringify(value)?line:JSON.stringify(updated);}catch{return line;}}).join('\n');
      if(after!==before)fs.writeFileSync(file,after);
    }else if(item.name.endsWith('.json')){
      let original;try{original=read(file);}catch{continue;}
      const changed=rewrite(original,item.name==='config.json');
      if(JSON.stringify(changed)!==JSON.stringify(original))fs.writeFileSync(file,JSON.stringify(changed,null,2));
    }
  }}visit(directory);
}

export function copyInstallData({installRoot,sourceRoot=null,version='0.5.1'}={}){
  const target=ordinaryRoot(installRoot),source=sourceRoot?inspectCopySource(sourceRoot):null;
  if(source&&(within(target,source.root)||within(source.root,target)))throw installFailure('TARGET_OVERLAP','新旧安装目录不能重叠',{Path:source.root});
  if(!/^0\.5\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version))throw Error('安装版本无效');
  if(fs.existsSync(path.join(target,INSTALL_STATE_FILE)))throw installFailure('TARGET_CHANGED','目标已有安装记录，不能覆盖安装',{Path:path.join(target,INSTALL_STATE_FILE)});
  const stage=installationPath(target,'.qqa-copy-'+randomUUID()),groups=[],protocolMappings=[];
  const add=(from,to,legacy=false)=>{
    if(!fs.existsSync(from))return;
    if(source.profiles.some(p=>p.source===from))ordinaryRoot(from);
    else installationPath(source.root,path.relative(source.root,from));
    if(!fs.lstatSync(from).isDirectory())throw Error('待迁移数据必须是文件夹');
    if(groups.some(g=>g.to===to))throw installFailure('DATA_LAYOUT_CONFLICT','发现多个相同用途的数据目录，请先整理旧版目录',{Path:from});
    groups.push({from,to,legacy,rows:inventory(from)});
  };
  if(source){
    for(const profile of source.profiles)add(profile.source,profile.name,source.legacy);
    for(const kind of ['plugins','skills','overrides'])add(path.join(source.extensionRoot,kind),path.join('extensions',kind));
    const programRoots=[...new Set([source.root,source.appRoot])];
    for(const base of programRoots){
      const protocols=path.join(base,'protocols');
      if(fs.existsSync(protocols)){add(protocols,'protocols');protocolMappings.push([protocols,path.join(target,'protocols')]);}
    }
    for(const [name,provider]of [['snowluma','SnowLuma'],['napcat','NapCatQQ']]){
      for(const base of programRoots){
        const old=path.join(base,name);
        if(fs.existsSync(old)){if(groups.some(g=>g.to==='protocols'))throw installFailure('DATA_LAYOUT_CONFLICT','同时发现协议端新旧存储目录，请选择整理后的旧版目录',{Path:old});add(old,path.join('protocols',provider));protocolMappings.push([old,path.join(target,'protocols',provider)]);}
      }
    }
  }
  for(const group of groups){
    const dest=installationPath(target,group.to);
    if(fs.existsSync(dest)&&fs.readdirSync(dest).length)throw installFailure('TARGET_CHANGED','新版本的数据目标已有内容，已停止以免覆盖',{Path:dest});
  }
  const mappings=source?[...source.profiles.map(p=>[p.source,installationPath(target,p.name)]),
    ...['plugins','skills','overrides'].map(kind=>[path.join(source.extensionRoot,kind),path.join(target,'extensions',kind)]),
    ...protocolMappings,[source.root,target]]:[];
  const created=[];
  fs.mkdirSync(target,{recursive:true});fs.mkdirSync(stage);
  try{
    for(const group of groups){
      const dest=installationPath(stage,group.to);
      if(group.legacy){
        const result=migrateFrom04({source:group.from,targetDataDir:dest,relocate:mappings,log:{}});
        if(!result.ok)throw installFailure('DATA_CONVERSION_FAILED','0.4 数据转换失败，旧版文件已保留',{Path:group.from});
      }else copyVerified(group.from,dest,group.rows);
    }
    // Path changes affect only copied data and known path fields. Chat text,
    // memory prose, extension source code and the old installation stay intact.
    for(const group of groups)if(group.to.startsWith('data-v05'))rewritePaths(installationPath(stage,group.to),mappings);
    for(const group of groups)if(JSON.stringify(inventory(group.from))!==JSON.stringify(group.rows))throw installFailure('SOURCE_CHANGED','旧版数据仍在写入，已停止提交，请关闭旧版后重试',{Path:group.from});
    fs.mkdirSync(path.join(stage,'data-v05'),{recursive:true});fs.mkdirSync(path.join(stage,'extensions'),{recursive:true});
    for(const name of fs.readdirSync(stage)){
      const dest=installationPath(target,name);
      if(fs.existsSync(dest)){
        if(!fs.lstatSync(dest).isDirectory()||fs.readdirSync(dest).length)throw installFailure('TARGET_CHANGED','提交前目标出现新文件，已停止迁移',{Path:dest});
        fs.rmdirSync(dest);
      }
      fs.renameSync(path.join(stage,name),dest);created.push(dest);
    }
    const state={schema:1,version,dataDirectory:'data-v05',extensionDirectory:'extensions',legacyMigration:source?'accepted':'not-needed',
      ...(source?{sourceVersion:source.version}:{}),installedAt:new Date().toISOString()};
    fs.writeFileSync(path.join(target,INSTALL_STATE_FILE),JSON.stringify(state,null,2),{flag:'wx'});
    return{ok:true,migrated:!!source,sourceVersion:source?.version??null,profiles:source?.profiles.length??0,files:groups.reduce((n,g)=>n+g.rows.filter(r=>r.kind==='file').length,0)};
  }catch(error){
    for(const dest of created.reverse()){installationPath(target,path.relative(target,dest));removeCreatedInstallTree(dest,target);}
    throw error;
  }finally{
    if(path.dirname(stage)!==target||!path.basename(stage).startsWith('.qqa-copy-'))throw Error('迁移暂存路径异常');
    installationPath(target,path.relative(target,stage));removeCreatedInstallTree(stage,target);
  }
}
