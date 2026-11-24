import {request,publishInstalledExtension,notify} from './panel-client.js';
import {button,confirmAction} from './ui.js';

export async function readExtensionMarket(kind){try{return await request('GET','/api/extensions/market',undefined,{kind});}catch(error){return{items:[],error:error.message};}}
export function createExtensionMarketControls(entry){
  const action=button('上传',async()=>{
    if(entry.operationBusy||entry.toggleBusy||entry.uninstall?.busy)return;
    entry.operationBusy=true;entry.toggleFeedback.hidden=true;entry.repaint();
    try{
      const offer=entry.marketState;
      if(offer?.action==='pull'){
        if(offer.disabled)throw Error(offer.reason||'新版暂不可下载');
        if(!await confirmAction(`拉取「${entry.extension.name||entry.extension.id}」的市场新版？\n\n${offer.localVersion} → ${offer.remoteVersion}\n作者：${offer.author||'市场作者'}\n保留设置与启用状态，替换代码后重新加载；失败会恢复旧版。`))return;
        await request('POST',`/api/extensions/${encodeURIComponent(entry.extension.id)}/market-update`,{confirmed:true,checkId:offer.checkId});
        await notify(`已拉取更新：${entry.extension.name||entry.extension.id}`);
      }else{
        const result=await publishInstalledExtension({id:entry.extension.id,kind:entry.extension.kind});
        if(result?.needsLogin||result?.canceled)return;
        if(result?.ok!==true)throw Error('上传未完成，请重试');
        if(result?.unchanged)await notify('客户端与市场版本相同');
        else await notify(result.note||'上传完成，审核状态以市场为准');
      }
      await entry.reload();
    }catch(error){entry.toggleFeedback.textContent=error.message||'市场操作未完成，请重试';entry.toggleFeedback.hidden=false;}
    finally{entry.operationBusy=false;entry.repaint();}
  });
  action.classList.add('extension-market-action');
  return{action,render(offer){
    entry.marketState=offer;action.hidden=entry.extension.root==='bundled'||offer?.action==='none';
    action.textContent=offer?.action==='push'?'↑推送更新↑':offer?.action==='pull'?'↓拉取更新↓':'上传';
    action.title=offer?.reason||((offer?.action==='push'||offer?.action==='pull')?`${offer.localVersion} → ${offer.remoteVersion}`:'上传当前技能或插件到社区市场');
    action.disabled=!!entry.operationBusy||!!entry.toggleBusy||!!entry.uninstall?.busy||offer?.action==='blocked'||offer?.disabled===true;
    action.classList.toggle('primary',['push','pull'].includes(offer?.action));
  }};
}
