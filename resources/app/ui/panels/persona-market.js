import {request,notify,submitCommunity,cancelCommunitySubmit,exportCommunityPersona,openCommunityAccount,onLeave,onShellEvent} from './panel-client.js';
import {confirmAction} from './ui.js';
import {createCatalogView,node,action,workName} from './catalog-view.js';
import {openWorkDialog} from './work-dialog.js';

export const PERSONA_CATEGORIES={companion:'陪伴',roleplay:'角色扮演',utility:'实用助手',assistant:'助手',custom:'自定义'};
// The same reviewed persona actions serve the settings market and owned works.
// Catalog requests remain lazy; closing or leaving releases every child dialog.
export function createPersonaMarket({beforeOpen=async()=>{},onChanged=async()=>{},onPublished=async()=>{},getAccount=async()=>{const data=await request('GET','/api/market/accounts');return data.accounts?.[0]?.username||'';}}={}){
  const CATEGORIES=PERSONA_CATEGORIES,dialogs=new Set();let disposed=false,submitBusy=false,market=null,openVersion=0;
  function trackedDialog(item,options={}){
    const detail=openWorkDialog(item,{...options,onClosed(){dialogs.delete(detail);options.onClosed?.();}});dialogs.add(detail);return detail;
  }
  async function run(detail,fn){
    if(detail.busy||detail.closed)return;detail.busy=true;const buttons=[...detail.actions.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);
    try{await fn();}catch(error){if(!detail.closed)detail.status.textContent=error.message;}
    finally{detail.busy=false;if(!detail.closed)buttons.forEach(button=>button.disabled=false);}
  }
  async function openPersona(item){
    const detail=trackedDialog(item,{kind:'persona'});
    if(item.status!=='approved'||item.canCopyPrompt!==true){detail.status.textContent='此人设暂不开放提示词。';return;}
    const pre=node('pre','正在读取提示词…','work-prompt');detail.body.append(pre);
    try{const card=await request('GET','/api/community/persona',undefined,{id:item.id});if(detail.closed)return;pre.textContent=card.prompt;if(card.stale)detail.status.textContent='离线缓存，审核状态以最近一次在线读取为准。';
      detail.actions.append(action('复制提示词',()=>run(detail,async()=>{await exportCommunityPersona(item.id,'copy',card.revision);detail.status.textContent='提示词已复制';})),
        action('导出人设',()=>run(detail,async()=>{await exportCommunityPersona(item.id,'export',card.revision);detail.status.textContent='已请求保存人设文件';})),
        action('保存到我的人设',()=>run(detail,async()=>{const result=await request('POST','/api/community/persona/save',{id:item.id,promptRevision:card.revision});detail.status.textContent=result.alreadySaved?'我的人设中已有相同内容':'已保存，可在设置 → 人设中选择';await notify('人设已保存');await onChanged();}), 'primary'),
        action('设为全局人设',()=>run(detail,async()=>{const target=await request('GET','/api/community/persona/target');if(detail.closed)return;
          if(!await confirmAction(`将「${workName(item)}」设为全局人设？\n\n会替换当前全局角色卡「${target.name}」及附加规则。各会话的独立人设保留。`))return;
          await request('POST','/api/community/persona/apply',{id:item.id,revision:target.revision,promptRevision:card.revision,confirmed:true});detail.status.textContent='全局人设已保存';await notify('全局人设已保存');await onChanged();})));
    }catch(error){if(!detail.closed){pre.textContent='暂时无法读取提示词';detail.status.textContent=error.message;}}
  }
  async function openAuthor(item){
    if(!item.authorId)return;const detail=trackedDialog({id:item.authorId,name:item.author||'作者作品',description:'',type:'persona'},{metadata:false});detail.body.replaceChildren();detail.status.textContent='读取作者作品…';
    try{const value=await request('GET','/api/community/profile',undefined,{authorId:item.authorId});if(detail.closed)return;detail.status.textContent='';
      for(const [key,label]of [['personas','人设'],['plugins','插件'],['skills','技能']]){const rows=value.works?.[key]??[];if(!rows.length)continue;const group=node('section','','author-works');group.append(node('h4',`${label} · ${rows.length}`));for(const row of rows.slice(0,60))group.append(action(workName(row),()=>{detail.close();if(row.type==='persona')void openPersona(row);else trackedDialog(row);}));detail.body.append(group);}
      if(!detail.body.children.length)detail.status.textContent='这位作者暂时没有公开作品。';
    }catch(error){if(!detail.closed)detail.status.textContent=error.message;}
  }
  function field(form,title,name,value='',type='input'){
    const label=node('label',title),input=node(type);input.name=name;if(type==='input')input.type='text';if(type==='textarea')input.rows=8;input.value=value;label.append(input);form.append(label);return input;
  }
  function bindLocalForm(form,button,commit){
    // Opaque panels intentionally have no allow-forms sandbox grant. Commit
    // through the existing authenticated RPC instead of native form navigation.
    button.type='button';button.addEventListener('click',commit);form.addEventListener('submit',commit);
    form.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.isComposing&&event.target.tagName==='INPUT'){event.preventDefault();void commit(event);}});
  }
  async function publishPersona(){
    const username=await getAccount();if(disposed)return;if(!username){await openCommunityAccount();return;}
    const detail=trackedDialog({id:'new-persona',name:'发布人设',description:'提交的名称、简介和提示词会公开展示；审核通过后开放使用。'},{metadata:false}),form=node('form');detail.body.append(form);
    const title=field(form,'名称','title'),description=field(form,'简介','description','','textarea'),prompt=field(form,'提示词正文','prompt','','textarea');title.maxLength=120;description.maxLength=500;prompt.maxLength=100000;title.required=description.required=prompt.required=true;
    const category=field(form,'分类','category','','select');for(const[value,label]of Object.entries(CATEGORIES)){const option=node('option',label);option.value=value;category.append(option);}
    const templates=field(form,'从我的人设填入（可选）','template','','select');const empty=node('option','手动填写');empty.value='';templates.append(empty);
    let records=[];void request('GET','/api/persona-templates').then(data=>{if(detail.closed)return;records=data.templates||[];for(const item of records){const option=node('option',item.name);option.value=item.id;templates.append(option);}}).catch(()=>{});
    templates.addEventListener('change',()=>{const selected=records.find(item=>item.id===templates.value);if(selected){title.value=selected.name;prompt.value=selected.text+(selected.customRules?'\n\n'+selected.customRules:'');}});
    const submit=node('button','提交审核','primary');submit.type='submit';form.append(submit);
    bindLocalForm(form,submit,async event=>{event.preventDefault();if(submitBusy||!form.reportValidity())return;submitBusy=true;submit.disabled=true;
      try{if(await getAccount()!==username)throw Error('社区账号已切换，请重新打开发布窗口');const result=await submitCommunity({action:'publishPersona',accountUsername:username,title:title.value,description:description.value,prompt:prompt.value,category:category.value});if(result?.ok){detail.close();await notify('人设已提交审核');await onPublished();}}
      catch(error){if(!detail.closed)detail.status.textContent=error.message;}finally{submitBusy=false;if(!detail.closed)submit.disabled=false;}});
  }

  const picker=node('input');picker.type='file';picker.accept='.json,.txt,application/json,text/plain';picker.dataset.personaImport='';picker.hidden=true;document.body.append(picker);
  picker.addEventListener('change',async()=>{
    const file=picker.files?.[0];picker.value='';if(!file)return;
    try{if(file.size>512*1024)throw Error('人设文件最多 512KB');const raw=await file.text();if(disposed)return;let card;if(file.name.toLowerCase().endsWith('.json')){const value=JSON.parse(raw);card={name:value.name||value.title||file.name.replace(/\.json$/i,''),text:value.text||value.prompt||value.roleText,customRules:value.customRules||''};}else card={name:file.name.replace(/\.txt$/i,''),text:raw,customRules:''};
      if(typeof card.name!=='string'||typeof card.text!=='string'||!card.text.trim()||card.text.length>100000||typeof card.customRules!=='string'||card.customRules.length>10000)throw Error('人设文件缺少正文或超出长度限制');
      const detail=trackedDialog({id:'import-persona',name:'导入人设',description:'保存到本机人设库；不会上传或自动替换当前人设。'},{metadata:false}),form=node('form');detail.body.append(form);
      const name=field(form,'名称','name',card.name),text=field(form,'角色设定','text',card.text,'textarea'),rules=field(form,'附加规则','customRules',card.customRules,'textarea');name.maxLength=50;
      const submit=node('button','保存到我的人设','primary');form.append(submit);bindLocalForm(form,submit,async event=>{event.preventDefault();if(submit.disabled)return;submit.disabled=true;try{await request('POST','/api/persona-templates',{name:name.value,text:text.value,customRules:rules.value});detail.close();await notify('人设已保存');await onChanged();}catch(error){if(!detail.closed)detail.status.textContent=error.message;}finally{submit.disabled=false;}});
    }catch(error){await notify('导入失败：'+error.message);}
  });

  async function open(){
    if(disposed)return;if(market&&!market.view.closed){market.view.dialog.focus();return;}
    const version=++openVersion;await beforeOpen();if(disposed||version!==openVersion)return;
    let loaded=false,ticket=0;
    const view=trackedDialog({name:'人设市场',id:'persona-market'},{metadata:false,onClosed(){++ticket;catalog.dispose();if(market?.view===view)market=null;}});
    view.dialog.classList.add('persona-market-dialog');
    const tools=node('div','','actions persona-market-tools'),host=node('div');host.id='persona-market';
    tools.append(action('导入人设',()=>picker.click()),action('发布人设',()=>{void publishPersona().catch(error=>{view.status.textContent=error.message;});},'primary'));view.body.append(tools,host);
    const catalog=createCatalogView({host,kind:'persona',onOpen:openPersona,onAuthor:openAuthor,actions:item=>[action('查看',()=>openPersona(item))]});
    async function refresh(force=false){
      const current=++ticket;catalog.setBusy(true);catalog.message(loaded?'':'正在读取人设目录…');
      try{const data=await request('GET','/api/community/catalog',undefined,{kind:'persona',...(force?{force:'1'}:{})});if(disposed||view.closed||current!==ticket)return;catalog.setData({...data,categories:{...CATEGORIES,...data.categories}});loaded=true;catalog.message(data.stale?'正在显示上次保存的离线目录。联网后可刷新。':'');}
      catch(error){if(!disposed&&!view.closed&&current===ticket){catalog.message('人设目录读取失败：'+error.message+(loaded?'；原列表保留。':''),true);if(!loaded)catalog.list.replaceChildren(node('p','可稍后重试；本地人设仍可在人设管理中使用。','empty'));}}
      finally{if(!disposed&&!view.closed&&current===ticket)catalog.setBusy(false);}
    }
    market={view,refresh};catalog.refresh.addEventListener('click',()=>refresh(true));await refresh();
  }
  const unlisten=onShellEvent((name,payload)=>{if(name==='status'&&payload?.communitySourceUpdated&&market){market.view.close();}});
  let unleave=()=>{};
  function dispose(){if(disposed)return;disposed=true;++openVersion;unlisten();unleave();for(const view of [...dialogs].reverse())view.close();dialogs.clear();picker.remove();if(submitBusy)void cancelCommunitySubmit();}
  unleave=onLeave(dispose);
  return{open,openPersona,dispose};
}
