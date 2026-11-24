import {request,submitCommunity,cancelCommunitySubmit,publishInstalledExtension,onLeave,getViewState,onViewStateSnapshot} from '../panel-client.js';
import {confirmAction} from '../ui.js';
import {createCatalogView,node,action,workName} from '../catalog-view.js';
import {openWorkDialog} from '../work-dialog.js';
import {mountCommunityFeed} from './feed.js';
import {mountCommunityBrowser} from './browser-view.js';

import {createPersonaMarket,PERSONA_CATEGORIES as CATEGORIES} from '../persona-market.js';
export function mountCommunityLibrary({getAccount=()=>''}={}){
  const $=selector=>document.querySelector(selector);let active='account',disposed=false,workTicket=0,profile=null,profileAccount='',workKind='plugin',workView=null,submitBusy=false;
  const tabs=[...document.querySelectorAll('[data-community-tab]')];
  const feed=mountCommunityFeed($('#community-feed'));
  const browser=mountCommunityBrowser({onClose:()=>select('account')});
  const personaMarket=createPersonaMarket({getAccount,onPublished:()=>active==='account'?works():undefined});
  const canonical=name=>name==='works'?'account':name;
  function select(name,focus=false){
    name=canonical(name);if(!tabs.some(button=>button.dataset.communityTab===name))name='account';
    active=name;tabs.forEach(button=>{const chosen=button.dataset.communityTab===name;button.setAttribute('aria-selected',String(chosen));button.tabIndex=chosen?0:-1;});
    for(const item of tabs){const pane=$('#hub-'+item.dataset.communityTab);pane.hidden=item.dataset.communityTab!==name;pane.setAttribute('aria-labelledby',item.id||(item.id='community-tab-'+item.dataset.communityTab));}
    browser.show(name==='browser');
    if(focus)tabs.find(button=>button.dataset.communityTab===name)?.focus();
    if(name==='account')void works();
    if(name==='feed')feed.open();
  }
  let selectedByUser=false;
  tabs.forEach((button,index)=>{button.addEventListener('click',()=>{selectedByUser=true;select(button.dataset.communityTab);});button.addEventListener('keydown',event=>{const position=event.key==='Home'?0:event.key==='End'?tabs.length-1:event.key==='ArrowRight'?(index+1)%tabs.length:event.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:null;if(position!==null){event.preventDefault();selectedByUser=true;select(tabs[position].dataset.communityTab,true);}});button.disabled=false;});
  async function run(detail,fn){
    if(detail.busy||detail.closed)return;detail.busy=true;const buttons=[...detail.actions.querySelectorAll('button')];buttons.forEach(button=>button.disabled=true);
    try{await fn();}catch(error){if(!detail.closed)detail.status.textContent=error.message;}finally{detail.busy=false;if(!detail.closed)buttons.forEach(button=>button.disabled=false);}
  }
  function renderWorks(){
    workView?.dispose();$('#works-list').replaceChildren();
    workView=createCatalogView({host:$('#works-list'),kind:workKind,compact:true,onOpen:ownDetail,actions:item=>[action('管理',()=>ownDetail(item))]});
    workView.setData({items:profile?.works?.[workKind==='persona'?'personas':workKind+'s']??[],categories:workKind==='persona'?CATEGORIES:{}});
    for(const button of document.querySelectorAll('[data-work-kind]'))button.setAttribute('aria-pressed',String(button.dataset.workKind===workKind));
  }
  async function works(){
    const username=getAccount(),ticket=++workTicket;
    if(profileAccount!==username){profileAccount=username;profile=null;renderWorks();}
    if(!username){profile=null;renderWorks();$('#works-status').textContent='';return;}
    $('#works-status').textContent='正在核对账号与作品…';
    try{const data=await request('GET','/api/community/profile',undefined,{username});if(disposed||ticket!==workTicket||getAccount()!==username)return;profile=data;renderWorks();$('#works-status').textContent='';}
    catch(error){if(!disposed&&ticket===workTicket){profile=null;renderWorks();$('#works-status').textContent=`无法读取我的作品：${error.message}`;}}
  }
  async function ownDetail(item){
    if(item.type==='persona'){await personaMarket.openPersona(item);return;}
    const username=getAccount(),detail=openWorkDialog(item);
    detail.actions.append(action('推送本机版本',()=>run(detail,async()=>{const result=await publishInstalledExtension({id:item.id,kind:item.type});if(result?.needsLogin)select('account');else if(result?.ok){detail.status.textContent=result.unchanged?'本机与市场版本相同':'已提交，等待审核';await works();}})),
      action('删除作品',()=>run(detail,async()=>{if(submitBusy)return;submitBusy=true;try{const result=await submitCommunity({action:'removeWork',accountUsername:username,kind:item.type,id:item.id,revision:item.revision});if(result?.ok){detail.close();await works();}}finally{submitBusy=false;}}),'danger'));
    detail.body.append(node('p','推送更新会打包本机已安装的同名扩展。请先安装或导入要发布的版本。','muted'));
  }
  for(const button of document.querySelectorAll('[data-work-kind]'))button.addEventListener('click',()=>{workKind=button.dataset.workKind;renderWorks();});
  onLeave(()=>{disposed=true;++workTicket;personaMarket.dispose();workView?.dispose();profile=null;if(submitBusy)void cancelCommunitySubmit();});
  const explicit=canonical(location.hash.slice(1));onViewStateSnapshot('communityNavigation',()=>({tab:active,workKind}));
  if(tabs.some(button=>button.dataset.communityTab===explicit))select(explicit);
  else void getViewState('communityNavigation').then(value=>{if(disposed||selectedByUser)return;if(['plugin','skill','persona'].includes(value?.workKind))workKind=value.workKind;select(canonical(value?.tab));});
  return{select(name){selectedByUser=true;select(name);},refresh:()=>active==='account'?works():active==='feed'?feed.refresh():Promise.resolve(),accountChanged(){++workTicket;const username=getAccount();if(profileAccount!==username){profileAccount=username;profile=null;renderWorks();}if(active==='account')void works();}};
}
