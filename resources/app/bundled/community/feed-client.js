import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const BASE='https://kondius.cn/qq-agent';
const SOURCES={quotes:'/holyshits/holyshits.json',comments:'/comment/comments.json'};
const LIKES={quotes:'/holyshits/likes.json',comments:'/comment/likes.json'};
const ID=/^[A-Za-z0-9_-]{1,128}$/;
const count=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const fail=(message,status=400)=>Object.assign(new Error(message),{status,expose:true});
export function createCommunityFeedClient({fetchImpl,dataDir,signal=()=>null}){
  const memory=new Map();
  const cleanText=(value,max)=>typeof value==='string'?value.slice(0,max):'';
  function imageRef(raw,kind){const value=typeof raw==='string'?raw:raw?.dataUrl||raw?.url;if(typeof value!=='string')return null;
    if(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)&&value.length<1400000)return value;
    try{const url=new URL(value,BASE+(kind==='quotes'?'/holyshits/':'/comment/'));return url.protocol==='https:'&&['kondius.cn','www.kondius.cn'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/qq-agent\/(comment|holyshits)\/images\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/.test(url.pathname)?url.href:null;}catch{return null;}}
  function timestamp(...values){for(const value of values){if(typeof value!=='number'&&typeof value!=='string')continue;const numeric=typeof value==='number'||/^\d+$/.test(value)?Number(value):null,time=numeric===null?Date.parse(value):numeric<100000000000?numeric*1000:numeric;if(Number.isFinite(time)&&time>0)return time;}return null;}
  const cleanReply=reply=>({...(ID.test(String(reply.id??''))?{id:String(reply.id)}:{}),nickname:cleanText(reply.nickname,64)||'匿名',text:cleanText(reply.text,1000),createdAt:timestamp(reply.createdAt,reply.at,reply.ts)});
  function normalize(raw,kind){
    const rows=Array.isArray(raw)?raw:raw?.items;
    if(!Array.isArray(rows))throw fail('社区内容格式异常',502);
    return rows.filter(row=>row&&ID.test(String(row.id??''))&&(!row.status||row.status==='approved')).slice(0,2000).map(row=>({
      id:String(row.id),nickname:cleanText(row.nickname||row.name,64)||'匿名',text:cleanText(row.text||row.content,8000),
      createdAt:timestamp(row.createdAt,row.at,row.ts),pinned:row.pinned===true,likes:count(row.likes),
      messages:(Array.isArray(row.messages)?row.messages:[]).map(message=>({senderName:cleanText(message.senderName||message.sender,64)||'发言者',text:cleanText(message.text,4000),self:message.self===true,images:[...(Array.isArray(message.images)?message.images:[]),...(Array.isArray(message.media)?message.media:[])].map(value=>imageRef(value,kind)).filter(Boolean)})),
      imageCount:Math.min(9,(Array.isArray(row.images)?row.images:[]).length),
      images:[...(Array.isArray(row.images)?row.images:[]),...(Array.isArray(row.messages)?row.messages:[]).flatMap(message=>Array.isArray(message.media)?message.media:[])].map(value=>imageRef(value,kind)).filter(Boolean).slice(0,9),
      replies:(Array.isArray(row.replies)?row.replies:[]).filter(reply=>reply&&typeof reply==='object').map(cleanReply),kind,
    })).sort((a,b)=>Number(b.pinned)-Number(a.pinned)||(b.createdAt||0)-(a.createdAt||0));
  }
  function cached(kind){try{const file=path.join(dataDir,`community-feed-${kind}.json`),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>3*1024*1024)return null;const value=JSON.parse(fs.readFileSync(file,'utf8'));return{...value,items:normalize(value.items,kind).map(item=>({...item,likes:value.likesLoaded===true?item.likes:null}))};}catch{return null;}}
  async function call(relative,options={}){
    if(signal()?.aborted)throw signal().reason;
    const response=await fetchImpl(BASE+relative,{redirect:'manual',signal:signal(),timeoutMs:12000,maxBytes:2*1024*1024,...options});
    if(!response.ok||response.truncated)throw fail(`社区服务暂不可用（HTTP ${response.status}）`,response.status===429?429:503);
    try{return await response.json();}catch{throw fail('社区服务响应异常',502);}
  }
  return{
    async readFeed({kind,force=false}={}){
      if(signal()?.aborted)throw signal().reason;
      if(!Object.hasOwn(SOURCES,kind))throw fail('社区内容类型无效');
      const old=memory.get(kind);if(!force&&old&&Date.now()-old.fetchedAt<120000)return{...old,cached:true};
      try{const [feed,likes]=await Promise.allSettled([call(SOURCES[kind]),call(LIKES[kind])]);if(feed.status==='rejected')throw feed.reason;if(signal()?.aborted)throw signal().reason;
        const previous=old??cached(kind),prior=new Map(previous?.items?.map(item=>[item.id,item])||[]),likesAvailable=likes.status==='fulfilled'&&likes.value&&typeof likes.value==='object'&&!Array.isArray(likes.value);
        const items=normalize(feed.value,kind).map(item=>({...item,likes:likesAvailable?(Object.hasOwn(likes.value,item.id)?count(likes.value[item.id]):0):(previous?.likesLoaded===true?prior.get(item.id)?.likes??null:item.likes)}));
        const value={ok:true,kind,items,source:BASE+SOURCES[kind],fetchedAt:Date.now(),stale:false,likesLoaded:Boolean(likesAvailable||previous?.likesLoaded===true),likesStale:!likesAvailable};
        if(signal()?.aborted)throw signal().reason;memory.set(kind,value);
        try{fs.mkdirSync(dataDir,{recursive:true});const file=path.join(dataDir,`community-feed-${kind}.json`);if(!fs.existsSync(file)||!fs.lstatSync(file).isSymbolicLink()){const temp=file+'.'+crypto.randomUUID()+'.tmp';fs.writeFileSync(temp,JSON.stringify(value));fs.renameSync(temp,file);}}catch{}
        return value;
      }catch(error){if(signal()?.aborted)throw signal().reason;const value=old??cached(kind);if(value)return{...value,stale:true,cached:true};throw error;}
    },
    async likeFeed({kind,id,liked}={}){
      if(!Object.hasOwn(SOURCES,kind)||!ID.test(id??'')||typeof liked!=='boolean')throw fail('点赞参数无效');
      const result=await call('/api/like',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:kind==='quotes'?'holyshits':'comment',id,like:liked})});if(result.ok!==true)throw fail('点赞结果未确认',502);memory.delete(kind);return{ok:true,count:count(result.count)};
    },
    async replyFeed({kind,id,nickname,text}={}){
      if(kind!=='quotes'||!ID.test(id??'')||typeof nickname!=='string'||!nickname.trim()||nickname.length>32||typeof text!=='string'||!text.trim()||text.length>500)throw fail('请检查昵称和回复内容（最多 500 字）');
      const result=await call('/api/reply',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({target:'holyshits',id,nickname:nickname.trim(),text:text.trim()})});if(result.ok!==true)throw fail('回复结果未确认',502);memory.delete(kind);return{ok:true,reply:cleanReply(result.reply&&typeof result.reply==='object'?result.reply:{nickname:nickname.trim(),text:text.trim()})};
    },
  };
}
