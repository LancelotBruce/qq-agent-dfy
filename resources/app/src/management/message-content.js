import crypto from 'node:crypto';
import {validateLiteralValue} from './ports.js';

// A content key compares data, never CQ commands or a media download. Unknown
// media deliberately remains incomparable rather than sharing a generic key.
export function stableJson(value){
  validateLiteralValue(value);
  const encode=item=>typeof item==='number'&&Object.is(item,-0)?'-0':item===null||typeof item!=='object'?JSON.stringify(item):Array.isArray(item)?'['+item.map(encode).join(',')+']':'{'+Object.keys(item).sort().map(key=>JSON.stringify(key)+':'+encode(item[key])).join(',')+'}';
  return encode(value);
}
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const mediaHash=data=>{
  const md5=String(data.md5??'').match(/^[a-f\d]{32}$/i);if(md5)return md5[0].toLowerCase();
  const file=String(data.file??'').match(/(?:^|[\\/])([a-f\d]{32})(?:\.[a-z\d]+)?$/i);if(file)return file[1].toLowerCase();
  return null;
};
export function messageContent(message,mode='segments'){
  if(!['text','segments'].includes(mode))throw Error('消息比较方式无效');
  if(typeof message!=='string'&&!Array.isArray(message))throw Error('请提供消息内容');
  validateLiteralValue(message);
  const rawString=typeof message==='string',hasCq=rawString&&/\[CQ:/i.test(message);
  const segments=rawString?[{type:hasCq?'opaque-cq':'text',data:{text:message}}]:message;
  if(segments.length>1000)throw Error('消息段过多');
  let comparable=segments.length>0&&!hasCq,onlyText=segments.length>0&&!hasCq,text='',canonical=[];
  for(const segment of segments){
    if(!segment||typeof segment!=='object'||typeof segment.type!=='string')throw Error('消息段格式无效');
    const data=segment.data??segment,type=segment.type;
    if(type==='text'){
      const part=data.text??'';if(typeof part!=='string')throw Error('消息文字格式无效');text+=part;
      if(canonical.at(-1)?.type==='text')canonical.at(-1).text+=part;else canonical.push({type,text:part});
      continue;
    }
    onlyText=false;
    if(['image','record','video'].includes(type)){
      const hash=mediaHash(data);
      const optionsValid=['sub_type','subType','type','magic'].every(key=>data[key]==null||['string','number','boolean'].includes(typeof data[key]));
      if(hash&&optionsValid)canonical.push({type,hash,sub_type:String(data.sub_type??data.subType??''),kind:String(data.type??''),magic:String(data.magic??'')});
      else {comparable=false;canonical.push({type,opaque:stableJson(data)});}
    }else if(type==='at'&&/^(?:all|[1-9]\d{0,15})$/.test(String(data.qq??data.id??'')))canonical.push({type,qq:String(data.qq??data.id)});
    else if(['face','reply','forward'].includes(type)&&['string','number'].includes(typeof data.id)&&String(data.id).length>0)canonical.push({type,id:String(data.id)});
    else if((type==='json'||type==='xml')&&typeof data.data==='string'&&data.data.length>0)canonical.push({type,data:data.data});
    else {comparable=false;canonical.push({type,opaque:stableJson(data)});}
  }
  if(text.length>100000)throw Error('消息文字过长');
  if(onlyText&&text.length===0)comparable=false;
  return {key:digest(stableJson({version:1,mode,value:mode==='text'?text:canonical})),only_text:onlyText,comparable:mode==='text'?!hasCq&&text.length>0:comparable,text};
}

export function messageRecord(event,receivedAt,unique=''){
  const message=event.message??event.raw_message??'',content=messageContent(message);
  return {message:structuredClone(message),text:content.text,user_id:String(event.user_id??event.sender?.user_id??''),
    ...(event.message_id!=null?{message_id:String(event.message_id)}:{}),
    ...(Number.isFinite(event.time)&&event.time>=0?{time:event.time}:{}),received_at:receivedAt/1000,
    content_key:content.comparable?content.key:digest('uncomparable:'+unique),only_text:content.only_text,comparable:content.comparable};
}

export function createMessageHistory({maxBytes=8*1024*1024,maxPerChat=2000,maxTotal=10000}={}){
  const chats=new Map(),losses=new Map();let bytes=0,total=0,sequence=0,untrackedLoss=-Infinity;
  const state=key=>{if(!chats.has(key))chats.set(key,{records:[],lostAt:Math.max(losses.get(key)??-Infinity,untrackedLoss)});return chats.get(key);};
  function drop(chat){const item=chat.records.shift();if(!item)return;chat.lostAt=Math.max(chat.lostAt,item.at);bytes-=item.bytes;total--;}
  function trimChats(){while(chats.size>128){const key=chats.keys().next().value,old=chats.get(key);while(old.records.length)drop(old);losses.delete(key);losses.set(key,old.lostAt);chats.delete(key);while(losses.size>256){const key=losses.keys().next().value;untrackedLoss=Math.max(untrackedLoss,losses.get(key));losses.delete(key);}}}
  return {
    add(key,event,at){
      const chat=state(key);chats.delete(key);chats.set(key,chat);let record,size;
      try{record=messageRecord(event,at,`${key}:${++sequence}`);size=Buffer.byteLength(JSON.stringify(record));if(size>256*1024)throw Error('消息过大');}
      catch{chat.lostAt=Math.max(chat.lostAt,at);record={message:[],text:'',user_id:'',received_at:at/1000,content_key:digest('invalid:'+key+':'+sequence),only_text:false,comparable:false};size=Buffer.byteLength(JSON.stringify(record));}
      chat.records.push({record,at,bytes:size});bytes+=size;total++;
      while(chat.records.length>maxPerChat||chat.records[0]?.at<at-3600000)drop(chat);
      while(bytes>maxBytes||total>maxTotal){const old=[...chats.values()].find(value=>value.records.length);if(!old)break;drop(old);}
      trimChats();
    },
    snapshot(key){const chat=chats.get(key);return {records:chat?[...chat.records]:[],observed:!!chat,lostAt:chat?.lostAt??Math.max(losses.get(key)??-Infinity,untrackedLoss)};},
    clear(){chats.clear();losses.clear();bytes=0;total=0;untrackedLoss=-Infinity;},get size(){return total;},get chatCount(){return chats.size;},get lossCount(){return losses.size;},
  };
}

export function selectHistory(snapshot,{seconds=60,limit=100,include_self=false},at,self){
  if(!Number.isInteger(limit))throw Error('最多消息数需要整数');
  const since=at-seconds*1000,available=snapshot.records.filter(item=>item.at>=since&&item.at<=at&&(include_self||item.record.user_id!==self));
  const observed=snapshot.observed??snapshot.records.length>0;
  return {items:structuredClone(available.slice(-limit).map(item=>item.record)),count:Math.min(available.length,limit),observed,complete:observed&&snapshot.lostAt<since&&available.length<=limit};
}
