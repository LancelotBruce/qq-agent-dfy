import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_MARKET_SOURCE='https://www.kondius.cn/api/community';
const ID=/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const KINDS={plugin:'plugins',skill:'skills',persona:'personas'};
const fail=(message,status=400)=>Object.assign(new Error(message),{status,expose:true});
const hash=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function marketSource(value=DEFAULT_MARKET_SOURCE){
  let url;try{url=new URL(value||DEFAULT_MARKET_SOURCE);}catch{throw fail('市场服务地址无效');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname.replace(/\/$/,'')!=='/api/community')throw fail('市场服务地址需为 HTTPS，路径为 /api/community，且不含凭据或查询参数');
  return url.origin+'/api/community';
}
export function publicWork(raw,kind,{owned=false}={}){
  if(!raw||!ID.test(String(raw.id??''))||!Object.hasOwn(KINDS,kind))return null;
  const out={id:String(raw.id),type:kind};
  for(const key of ['name','title','description','category','categoryName','version','author','authorId','createdAt','updatedAt','status']){
    if(typeof raw[key]==='string')out[key]=raw[key].slice(0,key==='description'?5000:200);
  }
  for(const key of ['downloads','promptLength'])if(Number.isFinite(raw[key])&&raw[key]>=0)out[key]=Math.floor(raw[key]);
  for(const key of ['hasPrompt','canCopyPrompt'])if(typeof raw[key]==='boolean')out[key]=raw[key];
  if(out.status==='approved'&&/^[A-Z0-9]{4,12}$/.test(raw.installCode??''))out.installCode=raw.installCode;
  if(owned&&typeof raw.reviewNote==='string')out.reviewNote=raw.reviewNote.slice(0,2000);
  out.revision=hash(out);
  return out;
}

// Public content only. Authentication, private submission details and profiles
// never enter this cache. Cache files and credentials are scoped to the source.
export function createCommunityLibrary({dataDir,request,source,accounts,verifiedAccounts,fsImpl=fs,now=Date.now}){
  const flights=new Map(),memory=new Map();
  const cacheName=key=>path.join(dataDir,`community-public-${hash([source(),key]).slice(0,40)}.json`);
  function disk(key){try{const file=cacheName(key),stat=fsImpl.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>3*1024*1024)return null;
    const value=JSON.parse(fsImpl.readFileSync(file,'utf8'));return value.source===source()&&Number.isFinite(value.fetchedAt)&&value.fetchedAt>0?value:null;
  }catch{return null;}}
  function persist(key,value){try{const file=cacheName(key);if(fsImpl.existsSync(file)&&fsImpl.lstatSync(file).isSymbolicLink())return;
    fsImpl.mkdirSync(dataDir,{recursive:true});const temp=file+'.'+crypto.randomUUID()+'.tmp';fsImpl.writeFileSync(temp,JSON.stringify(value));fsImpl.renameSync(temp,file);
  }catch{/* A cache write cannot turn a successful public read into a failure. */}}
  async function json(endpoint,options={}){
    const response=await request(endpoint,{timeoutMs:12000,maxBytes:2*1024*1024,followRedirects:false,...options});
    let data;try{data=JSON.parse(response.body);}catch{throw fail('社区服务返回了无法识别的内容',502);}
    if(response.status<200||response.status>=300||response.truncated||data?.ok===false)throw fail(response.status===401||response.status===403?'登录已失效或当前账号无权操作':response.status===404?'作品已不存在':`社区服务请求失败（HTTP ${response.status}）`,[400,401,403,404,409,429,503].includes(response.status)?response.status:502);
    return data;
  }
  function normalizeCatalog(data,kind){
    if(!Array.isArray(data?.items))throw fail('市场目录格式异常',502);
    const categories=Object.fromEntries(Object.entries(data.categories??{}).filter(([key,value])=>ID.test(key)&&typeof value==='string').slice(0,60).map(([key,value])=>[key,value.slice(0,100)]));
    const items=data.items.slice(0,5000).filter(item=>!item?.type||item.type===kind).map(item=>publicWork(item,kind)).filter(Boolean);
    for(const item of items)item.categoryName=(Object.hasOwn(categories,item.category)?categories[item.category]:'')||item.categoryName||item.category||'其他';
    return{ok:true,kind,categories,items};
  }
  async function catalog({kind,force=false,allowStale=true}={}){
    if(!Object.hasOwn(KINDS,kind))throw fail('请选择插件、技能或人设');
    const origin=source(),key='catalog:'+kind,identity=origin+key,old=memory.get(identity);
    if(!force&&old&&now()-old.fetchedAt<120000)return{...structuredClone(old),cached:true,stale:false};
    if(flights.has(identity))return flights.get(identity).then(value=>{if(value.stale&&!allowStale)throw fail('无法重新核验在线目录，请联网后再安装',503);return structuredClone(value);});
    const work=(async()=>{
      try{
        const data=normalizeCatalog(await json('/'+KINDS[kind],{expectedSource:origin}),kind);
        if(source()!==origin)throw fail('市场服务已切换，请重新读取',409);
        const value={...data,source:origin,fetchedAt:now(),cached:false,stale:false};memory.set(identity,value);persist(key,value);return structuredClone(value);
      }catch(error){
        if(source()!==origin||!allowStale||[400,401,403,404,409].includes(error.status))throw error;
        const cached=old??disk(key);
        if(!cached)throw error;
        return{...normalizeCatalog(cached,kind),source:origin,fetchedAt:cached.fetchedAt,cached:true,stale:true,warning:'在线服务暂不可用，显示上次保存的目录。安装与更新仍会重新核验。'};
      }
    })();flights.set(identity,work);try{return await work;}finally{if(flights.get(identity)===work)flights.delete(identity);}
  }
  async function persona({id,force=false}={}){
    if(!ID.test(id??''))throw fail('人设标识无效');
    const origin=source(),listing=await catalog({kind:'persona',force}),item=listing.items.find(row=>row.id===id);
    if(!item||item.status!=='approved'||item.canCopyPrompt!==true)throw fail('此人设尚未通过审核或已下架，暂不开放提示词',403);
    const key='prompt:'+id,cached=disk(key);
    try{
      const data=await json(`/personas/${encodeURIComponent(id)}/prompt`,{expectedSource:origin});
      if(data.status!=='approved'||data.canCopyPrompt!==true||typeof data.prompt!=='string'||!data.prompt.trim()||data.prompt.length>100000)throw fail('人设的审核状态或正文未确认',403);
      const prompt=data.prompt.trim(),value={ok:true,id,title:item.title||item.name||id,prompt,revision:hash([origin,id,prompt]),status:'approved',source:origin,fetchedAt:now(),cached:false,stale:false};
      if(source()!==origin)throw fail('市场服务已切换，请重新读取',409);persist(key,value);return value;
    }catch(error){
      if([400,401,403,404,409].includes(error.status)||!cached||cached.id!==id||typeof cached.prompt!=='string'||!cached.prompt.trim()||cached.prompt.length>100000||source()!==origin)throw error;
      return{ok:true,id,title:item.title||item.name||id,prompt:cached.prompt,revision:hash([origin,id,cached.prompt]),status:'approved',source:origin,fetchedAt:cached.fetchedAt,cached:true,stale:true};
    }
  }
  async function identity(username){
    if(typeof username!=='string'||!username.trim())throw fail('请先在账号中选择已登录的社区账号',401);
    const origin=source(),record=accounts().find(row=>row.username===username),view=await verifiedAccounts({force:true});
    const account=view.accounts.find(row=>row.username===username);
    if(!record||!account||source()!==origin||accounts().find(row=>row.username===username)?.token!==record.token)throw fail('登录状态未确认，请重新登录后再试',401);
    return{origin,record,account};
  }
  async function profile({username,authorId}={}){
    const own=username?await identity(username):null,id=own?.account.id||authorId;
    if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(id))throw fail('作者标识无效');
    const data=await json('/u/'+encodeURIComponent(id),own?{headers:{'x-account-token':own.record.token},expectedSource:own.origin}:{});
    if(data.account?.id!==id)throw fail('作者身份未确认',502);
    if(own&&(source()!==own.origin||accounts().find(row=>row.username===username)?.token!==own.record.token))throw fail('登录状态已变化，请重新打开作品列表',409);
    const account={id};for(const key of ['username','displayName','createdAt'])if(typeof data.account[key]==='string')account[key]=data.account[key].slice(0,200);
    return{ok:true,account,mine:!!own,works:Object.fromEntries(Object.entries(KINDS).map(([kind,plural])=>[plural,(Array.isArray(data.works?.[plural])?data.works[plural]:[]).filter(item=>item.authorId===id).slice(0,5000).map(item=>publicWork(item,kind,{owned:!!own})).filter(Boolean)]))};
  }
  async function publishPersona(input={}){
    const {accountUsername,title,description,prompt,category,captchaVerifyParam}=input;
    for(const [key,value,limit]of [['名称',title,120],['简介',description,500],['提示词',prompt,100000]])if(typeof value!=='string'||!value.trim()||value.length>limit)throw fail(`${key}不能为空且最多 ${limit} 字`);
    if(typeof category!=='string'||!ID.test(category))throw fail('人设分类无效');
    if(typeof captchaVerifyParam!=='string'||!captchaVerifyParam||captchaVerifyParam.length>16384)throw fail('请先完成人机验证');
    const own=await identity(accountUsername);
    try{const data=await json('/personas',{method:'POST',timeoutMs:30000,maxBytes:65536,headers:{'x-account-token':own.record.token,'content-type':'application/json'},expectedSource:own.origin,
      body:JSON.stringify({title:title.trim(),description:description.trim(),prompt,category,captchaVerifyParam})});
      if(data.ok!==true)throw fail('没有收到明确的发布结果，请先查看我的作品再重试',502);
      memory.delete(own.origin+'catalog:persona');const item=publicWork(data.item,'persona');if(item)for(const key of Object.keys(item))if(typeof item[key]==='string')item[key]=item[key].replaceAll(own.record.token,'[已隐藏]').replaceAll(captchaVerifyParam,'[已隐藏]');return{ok:true,item,note:'已提交，审核状态以我的作品为准'};
    }catch(error){throw fail(String(error.message).replaceAll(own.record.token,'[已隐藏]').replaceAll(captchaVerifyParam,'[已隐藏]'),error.status??502);}
  }
  async function removeWork({accountUsername,kind,id,revision,confirmed}={}){
    if(!['plugin','skill'].includes(kind)||!ID.test(id??'')||typeof revision!=='string'||confirmed!==true)throw fail('删除参数无效或尚未确认');
    const own=await identity(accountUsername),current=await profile({username:accountUsername}),item=current.works[KINDS[kind]].find(row=>row.id===id);
    if(!item||item.authorId!==own.account.id||item.revision!==revision)throw fail('作品或登录账号已变化，请重新打开后确认',409);
    try{const data=await json(`/market/${KINDS[kind]}/${encodeURIComponent(id)}/delete`,{method:'POST',headers:{'x-account-token':own.record.token},expectedSource:own.origin});
      if(data.ok!==true)throw fail('删除结果未确认，请重新读取我的作品',502);
      memory.delete(own.origin+'catalog:'+kind);return{ok:true,id};
    }catch(error){throw fail(String(error.message).replaceAll(own.record.token,'[已隐藏]'),error.status??502);}
  }
  return{catalog,persona,profile,publishPersona,removeWork,json,source,clear:()=>memory.clear()};
}
