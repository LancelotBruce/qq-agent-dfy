import {normalizeQQList} from './list-choice.js';
import {chatAllowed} from '../chat-access.js';

const chatKey=value=>/^(group|private):[1-9]\d{0,14}$/.test(String(value??''))?String(value):'';
const parameters={idleThresholdMs:{fallback:1_800_000,scale:1000},checkIntervalMinMs:{fallback:1_800_000,scale:1000},checkIntervalMaxMs:{fallback:5_400_000,scale:1000}};

// Existing inputs keep using the shared settings transaction. A selection only
// changes their write destination; it never copies another chat's values.
export function mountProactiveView({host,header,inputs,read,write,save,request,onScopeChange=()=>{},initialScope='',doc=host.ownerDocument}) {
  const node=(tag,cls,text)=>{const el=doc.createElement(tag);el.className=cls;if(text!==undefined)el.textContent=text;return el;};
  const button=(label,run)=>{const el=node('button','',label);el.type='button';el.addEventListener('click',run);return el;};
  let scope=chatKey(initialScope),disposed=false,busy=false,loaded=false,loading=false,loadFailed=false;
  const known=new Map(),buttons=new Map();
  const unified=button('统一设置',async()=>{
    if(busy)return;busy=true;refresh();
    try{await save?.();if(!disposed)write('proactive.unified',read('proactive.unified')===false);}
    catch{/* Keep the current scope until its pending edits can be saved. */}
    finally{busy=false;if(!disposed)refresh();}
  });
  unified.className='proactive-unified-toggle';unified.setAttribute('role','switch');unified.setAttribute('aria-controls','proactive-scope-picker');
  unified.title='所有会话使用全局设置；关闭后可分别设置。已有独立设置会保留。';header.append(unified);
  const picker=node('section','proactive-scope-picker full');picker.id='proactive-scope-picker';
  const search=node('input','proactive-scope-search');search.type='search';search.placeholder='搜索群聊或好友';search.setAttribute('aria-label','搜索主动聊天会话');
  const choices=node('div','proactive-scope-choices');choices.setAttribute('role','radiogroup');choices.setAttribute('aria-label','主动聊天设置对象');
  const notice=node('p','muted proactive-scope-notice');notice.setAttribute('role','status');
  const retry=button('重新读取会话',()=>{loaded=false;void load();});retry.className='proactive-scope-retry';picker.append(search,choices,notice,retry);
  const context=node('div','proactive-scope-context full'),source=node('span','muted proactive-scope-source');
  const localToggle=button('此会话主动聊天',()=>write(`proactive.byChat.${scope}.enabled`,read(`proactive.byChat.${scope}.enabled`)===false));
  localToggle.className='proactive-chat-toggle';localToggle.setAttribute('role','switch');
  const reset=button('使用全局设置',()=>write(`proactive.byChat.${scope}`,{},true));reset.className='proactive-reset';
  context.append(source,localToggle,reset);host.prepend(picker,context);
  const split=()=>read('proactive.unified')===false;
  const admitted=key=>{const[kind,id]=key.split(':');return chatAllowed({allow:read('allow'),deny:read('deny'),allowAllWhenEmpty:read('allowAllWhenEmpty')},kind,id);};
  const path=base=>split()&&scope?`proactive.byChat.${scope}.${base.slice('proactive.'.length)}`:base;
  const overrides=()=>{const value=scope&&read(`proactive.byChat.${scope}`);return value&&typeof value==='object'&&!Array.isArray(value)?value:{};};
  function candidates(){
    const map=new Map(known),allow=read('allow')||{};
    for(const[kind,list]of [['group','groups'],['private','private']])for(const id of allow[list]??[]){const key=chatKey(`${kind}:${id}`);if(key&&!map.has(key))map.set(key,String(id));}
    for(const key of Object.keys(read('proactive.byChat')||{}))if(chatKey(key)&&!map.has(key))map.set(key,key.split(':')[1]);
    if(scope&&!map.has(scope))map.set(scope,scope.split(':')[1]);
    return [['','全局设置'],...[...map].filter(([key])=>admitted(key)).sort(([a,an],[b,bn])=>a.split(':')[0].localeCompare(b.split(':')[0])||an.localeCompare(bn,'zh-CN'))];
  }
  async function choose(key){
    if(disposed||busy||key===scope||key&&!admitted(key))return;busy=true;refresh();
    try{await save?.();if(disposed||key&&!admitted(key))return;scope=key;onScopeChange();}
    catch{/* The common save controller reports validation/network errors. */}
    finally{busy=false;if(!disposed)refresh();}
  }
  function refresh(){
    if(disposed)return;
    const separate=split(),query=search.value.trim().toLowerCase(),items=candidates();
    const scopeRevoked=scope&&!admitted(scope);if(scopeRevoked)scope='';
    const local=overrides();
    unified.setAttribute('aria-checked',String(!separate));unified.disabled=busy;picker.hidden=!separate;
    context.hidden=!separate||!scope;source.textContent=Object.keys(local).length?'独立设置':'沿用全局';
    localToggle.hidden=!scope;reset.hidden=!scope||!Object.keys(local).length;
    localToggle.setAttribute('aria-checked',String(local.enabled!==false));localToggle.disabled=reset.disabled=busy;
    const wanted=new Set(items.map(([key])=>key));
    for(const[key,item]of buttons)if(!wanted.has(key)){item.remove();buttons.delete(key);}
    for(const[index,[key,label]]of items.entries()){
      let item=buttons.get(key);
      if(!item){item=button('',()=>void choose(key));item.className='proactive-scope-choice';item.dataset.proactiveChat=key||'global';item.setAttribute('role','radio');item.append(node('span','proactive-scope-kind',key?(key.startsWith('group:')?'群':'私'):''),node('span','proactive-scope-name'));buttons.set(key,item);choices.append(item);}
      if(choices.children[index]!==item)choices.insertBefore(item,choices.children[index]||null);
      const selected=key===scope;item.querySelector('.proactive-scope-name').textContent=label;
      item.setAttribute('aria-checked',String(selected));item.tabIndex=selected?0:-1;item.disabled=busy;
      item.setAttribute('aria-label',key?`${key.startsWith('group:')?'群聊':'私聊'} ${label}（${key.split(':')[1]}）`:'全局设置');
      const value=key&&read(`proactive.byChat.${key}`),custom=value&&Object.keys(value).length;
      item.dataset.custom=String(!!custom);item.title=key?`${key.split(':')[1]} · ${custom?'独立设置':'沿用全局'}`:'未单独设置的会话使用这里的参数';
      item.hidden=!!key&&!selected&&!!query&&!`${label} ${key}`.toLowerCase().includes(query);
    }
    search.hidden=items.length<12;notice.textContent=loading?'正在读取群聊与好友…':loadFailed?'部分名称读取失败，已保留响应范围中的会话。':items.length===1?'响应范围中暂无可配置的会话。':'';notice.hidden=!notice.textContent;retry.hidden=!loadFailed;
    for(const[key,{fallback,scale}]of Object.entries(parameters)){
      const input=inputs.get(`proactive.${key}`);if(!input)continue;
      const custom=separate&&scope&&Object.hasOwn(local,key),value=custom?local[key]:read(`proactive.${key}`)??fallback;
      if((scopeRevoked||doc.activeElement!==input)&&!input.hasAttribute('aria-invalid'))input.value=String(Number(value)/scale);
      input.title=custom?'此会话的独立设置':scope&&separate?'自动沿用全局设置':'所有会话的全局默认值';input.dataset.valueSource=custom?'chat':'global';
    }
    if(separate&&!loaded&&!loading)void load();
  }
  async function load(){
    if(disposed||loading)return;loading=true;loadFailed=false;refresh();
    const result=await Promise.allSettled([request('GET','/api/chats'),request('GET','/api/onebot/groups'),request('GET','/api/onebot/friends')]);if(disposed)return;
    if(result[0].status==='fulfilled')for(const chat of result[0].value.chats||[]){const key=chatKey(chat.chatKey||String(chat.key||'').replace('_',':'));if(key)known.set(key,String(chat.chatName||key.split(':')[1]));}
    for(const[index,kind,list]of [[1,'group','groups'],[2,'private','friends']])if(result[index].status==='fulfilled'){
      const normalized=normalizeQQList(result[index].value,list);if(normalized.phase==='invalid')loadFailed=true;
      for(const item of normalized.items)known.set(`${kind}:${item.id}`,item.name);
    }
    loadFailed ||= result.some(item=>item.status==='rejected');loading=false;loaded=true;refresh();
  }
  search.addEventListener('input',refresh);
  choices.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(event.key)||busy)return;
    const visible=[...buttons.values()].filter(item=>!item.hidden&&!item.disabled),index=visible.indexOf(event.target);if(index<0)return;
    event.preventDefault();const at=event.key==='Home'?0:event.key==='End'?visible.length-1:(index+(['ArrowLeft','ArrowUp'].includes(event.key)?-1:1)+visible.length)%visible.length;
    const next=visible[at],key=next.dataset.proactiveChat==='global'?'':next.dataset.proactiveChat;
    void choose(key).then(()=>{if(!disposed&&scope===key)next.focus({preventScroll:true});});
  });
  refresh();return{path,refresh,get scope(){return scope;},get selectedChat(){return split()?scope:'';},dispose(){disposed=true;}};
}
