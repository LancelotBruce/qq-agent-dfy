import crypto from 'node:crypto';
import {compareVersions,versionParts} from '../kernel/extension-update-source.js';
import {pluginFingerprint} from '../kernel/extension-fingerprint.js';

const fail=(message,status=400)=>Object.assign(Error(message),{status,expose:true});
const kindRoot={skill:'skills',plugin:'plugins'},TTL=30000,TICKET_TTL=10*60*1000;
export function createExtensionMarketController({loader,marketClient,extensionUpdates,publish=()=>{},now=Date.now,lifecycle}={}){
  const caches=new Map(),tickets=new Map(),publishing=new Set();let generation=0,closed=false;
  const active=()=>{if(closed||lifecycle?.signal.aborted)throw fail('应用已停止',409);};
  const target=id=>{const row=loader?.listEntries?.().find(row=>row.id===id);if(!row||!kindRoot[row.kind]||row.root!==kindRoot[row.kind])throw fail('仅用户安装的技能或插件支持市场操作',404);return row;};
  const present=row=>({id:row.id,kind:row.kind,localVersion:row.version,name:row.name||row.id});
  function cached(key,read,force){const old=caches.get(key);if(!force&&old&&now()-old.at<TTL)return old.promise;const entry={at:now(),promise:Promise.resolve().then(read)};caches.set(key,entry);entry.promise.catch(()=>{if(caches.get(key)===entry)caches.delete(key);});return entry.promise;}
  function invalidate(){generation++;caches.clear();tickets.clear();}
  function ticket(row,state,accounts){const checkId=crypto.randomUUID();tickets.set(checkId,{id:row.id,kind:row.kind,version:row.version,fingerprint:row.fingerprint,action:state.action,remoteVersion:state.remoteVersion,authorId:state.authorId,accountUsername:state.accountUsername,accountId:accounts.find(account=>account.username===state.accountUsername)?.id,at:now(),generation});return{...present(row),...state,checkId};}
  async function inspect({kind,id,force=false}={}){
    active();if(!kindRoot[kind])throw fail('类型必须是 skill 或 plugin');
    const rows=id?[target(id)]:(loader?.listEntries?.()||[]).filter(row=>row.kind===kind&&row.root===kindRoot[kind]);
    if(rows.some(row=>row.kind!==kind))throw fail('扩展类型不匹配');
    if(!rows.length)return{items:[],accounts:[]};const start=generation;
    const [catalogResult,identityResult]=await Promise.allSettled([
      cached('catalog:'+kind,()=>marketClient.listCatalog({kind}),force),
      cached('accounts',()=>marketClient.verifiedAccounts({force}),force),
    ]);active();if(start!==generation)throw fail('账号或扩展状态已变化，请重新检查',409);
    const accounts=identityResult.status==='fulfilled'?identityResult.value.accounts||[]:[];
    const identityUnknown=identityResult.status!=='fulfilled'||(!accounts.length&&identityResult.value.hasSavedAccounts&&identityResult.value.invalid?.some(item=>!item.expired));
    const items=rows.map(row=>{
      if(catalogResult.status!=='fulfilled')return{...present(row),action:'error',reason:'无法读取市场版本，请重试检查'};
      const matches=(catalogResult.value.items||[]).filter(item=>item.id===row.id);
      if(matches.length>1)return{...present(row),action:'error',reason:'市场存在重复身份，暂不提供操作'};
      const remote=matches[0],base={remoteVersion:remote?.version||null,authorId:remote?.authorId||null,author:remote?.author||'',remoteExists:!!remote,needsLogin:accounts.length===0,accountUsername:null};
      if(!versionParts(row.version))return{...present(row),...base,action:'error',reason:'本地清单需要有效的 x.y.z 版本号'};
      if(!remote)return identityUnknown?{...present(row),...base,action:'error',needsLogin:false,reason:'暂时无法验证社区账号，请稍后重试'}:ticket(row,{...base,action:'upload',accountUsername:accounts[0]?.username||null},accounts);
      if(!versionParts(remote.version))return{...present(row),...base,action:'error',reason:'服务器版本格式无法比较'};
      const comparison=compareVersions(row.version,remote.version),owner=accounts.find(account=>account.id===remote.authorId);
      if(comparison<0)return ticket(row,{...base,action:'pull',needsLogin:false,disabled:remote.status!=='approved'||!remote.installCode,reason:remote.status!=='approved'?'新版尚未通过审核':''},accounts);
      if(comparison===0)return{...present(row),...base,action:'none'};
      if(identityUnknown)return{...present(row),...base,action:'error',needsLogin:false,reason:'暂时无法验证作者账号，请稍后重试'};
      if(owner)return ticket(row,{...base,action:'push',needsLogin:false,accountUsername:owner.username},accounts);
      if(!accounts.length)return ticket(row,{...base,action:'upload',needsLogin:true},accounts);
      return{...present(row),...base,action:'blocked',reason:remote.authorId?'该 ID 属于其他作者，不能覆盖上传':'服务器未提供可验证的作者身份'};
    });
    for(const [key,value]of tickets)if(now()-value.at>TICKET_TTL)tickets.delete(key);
    return{items,accounts:accounts.map(({username,displayName})=>({username,displayName})),accountError:identityResult.status!=='fulfilled'||identityResult.value?.invalid?.length?'社区账号需要重新验证':''};
  }
  async function verifiedTicket(id,checkId,action){
    active();const previous=tickets.get(checkId),row=target(id);
    if(!previous||previous.id!==id||previous.generation!==generation||now()-previous.at>TICKET_TTL||previous.fingerprint!==row.fingerprint||previous.version!==row.version||previous.action!==action)throw fail('操作信息已过期，请重新检查并确认',409);
    if(!row.fingerprint||pluginFingerprint(row.dir)!==previous.fingerprint)throw fail('本地扩展文件已变化，请重新加载再操作',409);
    const fresh=(await inspect({kind:row.kind,id,force:true})).items[0];
    if(!fresh||fresh.action!==previous.action||fresh.remoteVersion!==previous.remoteVersion||fresh.authorId!==previous.authorId||fresh.accountUsername!==previous.accountUsername||tickets.get(fresh.checkId)?.accountId!==previous.accountId)throw fail('账号、作者或版本已变化，请重新检查并确认',409);
    return{row,previous,fresh};
  }
  async function preparePublish(id,{checkId}={}){
    const previous=tickets.get(checkId);if(!previous||!['upload','push'].includes(previous.action))throw fail('当前扩展不需要上传',409);
    const {row,fresh}=await verifiedTicket(id,checkId,previous.action);
    if(fresh.needsLogin||!fresh.accountUsername)return{ok:false,needsLogin:true};
    return{ok:true,...fresh,accountId:tickets.get(fresh.checkId)?.accountId,description:row.description||'',fingerprint:row.fingerprint};
  }
  async function upload(id,{checkId,captchaVerifyParam}={}){
    if(typeof captchaVerifyParam!=='string'||!captchaVerifyParam.trim()||captchaVerifyParam.length>65536)throw fail('请先完成人机验证');
    if(publishing.has(id))throw fail('此扩展正在上传，请勿重复操作',409);publishing.add(id);
    try{
      const offer=await preparePublish(id,{checkId});if(offer.needsLogin)throw fail('请先在“我的”页面登录社区账号',401);
      const result=await marketClient.publish({id,kind:offer.kind,displayName:offer.name,description:offer.description,accountUsername:offer.accountUsername,expectedAccountId:offer.accountId,captchaVerifyParam,update:offer.action==='push',expectedFingerprint:offer.fingerprint});
      invalidate();publish('status',{extensionMarketUpdated:true});return{ok:true,item:result.item,note:result.note||'已上传，审核状态以市场为准'};
    }finally{publishing.delete(id);}
  }
  async function pull(id,{checkId,confirmed}={}){
    if(confirmed!==true)throw fail('请先确认拉取并替换此版本');
    const {row,previous,fresh}=await verifiedTicket(id,checkId,'pull');if(fresh.disabled)throw fail(fresh.reason||'该市场版本暂不可下载',409);
    const result=await extensionUpdates.applyMarket(id,{version:previous.remoteVersion,fingerprint:row.fingerprint,download:()=>marketClient.downloadPackage({id,kind:row.kind,version:previous.remoteVersion,authorId:previous.authorId})});
    invalidate();publish('status',{extensionMarketUpdated:true});return result;
  }
  lifecycle?.onStop(()=>{closed=true;invalidate();});
  return{inspect,preparePublish,upload,pull,invalidate};
}
