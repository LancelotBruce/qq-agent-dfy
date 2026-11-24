import {request,onLeave} from './panel-client.js';
import {confirmAction} from './ui.js';
import {createCatalogView,action,workName,compareVersion,node} from './catalog-view.js';
import {openWorkDialog} from './work-dialog.js';

export function bindMarketBrowser({kind,onInstalled,getInstalled=()=>[],requestImpl=request,confirmImpl=confirmAction,doc=document}={}){
  const find=id=>doc.querySelector('#'+id),label=kind==='skill'?'技能':'插件';
  const installed=find('installed-view'),market=find('market-view'),installedActions=find('installed-actions'),tabs=[find('tab-installed'),find('tab-market')];
  let loaded=false,busy=false,disposed=false,ticket=0,selected=0,operation=false;const installedIds=new Set();
  market.replaceChildren();
  const view=createCatalogView({host:market,kind,onOpen:openItem,actions:item=>item.status==='approved'&&item.installCode?[operationButton(item)]:[]});
  function state(item){const local=getInstalled().find(row=>row.id===item.id&&row.kind===kind)||(installedIds.has(item.id)?{id:item.id,version:item.version}:null);return{local,compare:local?compareVersion(item.version,local.version):null};}
  function operationButton(item){
    const button=action('',async()=>{button.setAttribute('aria-busy','true');try{await(state(item).local?update(item):install(item));}finally{button.removeAttribute('aria-busy');if(!disposed)sync();}});button.dataset.marketInstallId=item.id;
    function sync(){const {local,compare}=state(item),text=local?(compare===1?'更新':compare===-1?'本地较新':'已安装'):'安装';button.textContent=text;button.classList.toggle('primary',compare===1);button.disabled=operation||item.status!=='approved'||!item.installCode||!!local&&compare!==1;button.setAttribute('aria-label',`${text}${label} ${workName(item)}`);}
    sync();return button;
  }
  async function install(item){
    if(disposed||operation||state(item).local||item.status!=='approved'||!item.installCode)return;operation=true;let confirmed=false;
    try{
      if(!await confirmImpl(`安装「${workName(item)}」？\n版本：${item.version||'未声明'} · 作者：${item.author||'未署名'}\n\n安装后默认停用，不执行代码。`))return;
      confirmed=true;
      view.render();view.message(`正在下载并校验「${workName(item)}」…`);
      const result=await requestImpl('POST','/api/market/install',{id:item.id,kind});
      if(result?.ok!==true||!result.installed||result.kind!==kind)throw Error('未收到明确的安装结果，请在已安装列表重扫核对');
      installedIds.add(item.id);await onInstalled?.();view.message(`已安装「${result.skill?.name||result.installed}」，默认停用，未执行代码。`);
    }catch(error){view.message(`安装未完成：${error.message}。如遇超时，请先在已安装列表重扫核对。`,true);}
    finally{operation=false;if(!disposed&&confirmed)view.render();}
  }
  async function update(item){
    if(disposed||operation||state(item).compare!==1)return;operation=true;let confirmed=false;
    try{
      const offers=await requestImpl('GET','/api/extensions/market',undefined,{id:item.id,kind,force:'1'}),offer=offers.items?.find(row=>row.id===item.id);
      if(offer?.action!=='pull'||offer.disabled)throw Error(offer?.reason||'暂未发现可拉取的新版，请刷新目录');
      if(!await confirmImpl(`更新「${workName(item)}」？\n${offer.localVersion} → ${offer.remoteVersion}\n\n保留设置和启用状态；失败时恢复旧版。`))return;
      confirmed=true;view.render();view.message('正在下载、校验并重新加载…');
      await requestImpl('POST',`/api/extensions/${encodeURIComponent(item.id)}/market-update`,{confirmed:true,checkId:offer.checkId});
      await onInstalled?.();view.message(`已更新「${workName(item)}」`);
    }catch(error){view.message(error.message,true);}finally{operation=false;if(!disposed&&confirmed)view.render();}
  }
  function openItem(item){
    const detail=openWorkDialog(item);if(item.status==='approved'&&item.installCode)detail.actions.append(operationButton(item));
    if(item.downloads!==undefined)detail.body.append(node('p',`${item.downloads} 次下载`,'muted'));
    if(view.data.stale)detail.status.textContent='当前显示离线缓存；安装或更新前会重新核验在线状态。';
  }
  async function load(force=false){
    if(disposed)return;const version=++ticket;busy=true;view.setBusy(true);
    if(!loaded)view.message('正在获取市场目录…');
    try{const data=await requestImpl('GET','/api/market/catalog',undefined,{kind,...(force?{force:'1'}:{})});if(disposed||ticket!==version)return;
      if(data?.ok!==true||data.kind!==kind||!Array.isArray(data.items))throw Error('市场目录响应异常');
      loaded=true;view.setData(data);view.message(data.stale?data.warning||'显示上次保存的目录，联网后可刷新。':'');
    }catch(error){if(!disposed&&ticket===version){view.message(`无法加载在线目录：${error.message}${loaded?'；当前列表已保留。':''}`,true);if(!loaded){view.status.textContent='在线目录暂不可用';view.list.replaceChildren(node('p','可稍后刷新，或继续管理已安装扩展。','empty'));}}}
    finally{if(!disposed&&ticket===version){busy=false;view.setBusy(false);}}
  }
  view.refresh.addEventListener('click',()=>load(true));
  function selectView(index,focus=false){
    selected=index;tabs.forEach((tab,i)=>{tab.setAttribute('aria-selected',String(i===index));tab.tabIndex=i===index?0:-1;});
    installed.hidden=index!==0;market.hidden=index!==1;if(installedActions)installedActions.hidden=index!==0;if(focus)tabs[index].focus();
    if(index===1&&!loaded&&!busy)void load();else if(index===1)view.render();
  }
  tabs.forEach((tab,index)=>{tab.addEventListener('click',()=>selectView(index));tab.addEventListener('keydown',event=>{const next=event.key==='Home'?0:event.key==='End'?1:['ArrowLeft','ArrowRight'].includes(event.key)?1-selected:null;if(next!==null){event.preventDefault();selectView(next,true);}});});
  onLeave(()=>{disposed=true;++ticket;view.dispose();});selectView(0);
  return{selectView,refresh:()=>load(true)};
}
