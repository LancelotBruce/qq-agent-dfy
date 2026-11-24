import {createIcon} from '../panels/icons.js';

const ACTIVE=new Set(['downloading','verifying','staging','ready','stopping','backingUp','installing','restarting','rollingBack']);
const CANCELLABLE=new Set(['downloading','verifying','staging','ready']);
const LABELS={downloading:'正在下载更新',verifying:'正在校验更新包',staging:'正在检查安装文件',ready:'安装文件已准备好',downloaded:'更新已下载，是否现在安装？',stopping:'正在保存设置并退出',backingUp:'正在备份程序和用户数据',installing:'正在安装新版',restarting:'正在启动新版',rollingBack:'正在恢复旧版',complete:'更新完成',rolledBack:'已恢复旧版',error:'更新未完成',cancelled:'更新已取消',rollbackFailed:'自动恢复未完成'};

export function createAppUpdateDialog({api,doc=document,win=window,beforeInstall=async()=>{},onState=()=>{}}){
  let dialog=null,timer=null,disposed=false,requesting=false,startedAt=0,resultNotice=null,documentVersion=null,startedHere=false,reloading=false,latest=null;
  const node=(tag,text)=>{const el=doc.createElement(tag);if(text!==undefined)el.textContent=text;return el;};
  const style=node('style');style.textContent=`.app-update-dialog{box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:85vh;overflow:auto;padding:22px;border:1px solid var(--accent);background:var(--surface,#202427);color:var(--text,#eee)}.app-update-dialog::backdrop{background:#0009}.app-update-dialog header,.app-update-dialog .actions{display:flex;align-items:center;justify-content:space-between;gap:12px}.app-update-dialog h3{margin:0}.app-update-dialog p{line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere}.app-update-dialog progress{width:100%;accent-color:var(--accent)}.app-update-dialog .actions{justify-content:flex-end;margin-top:18px}.app-update-dialog .error{color:var(--bad,#f07777)}.app-update-result{position:fixed;right:20px;bottom:20px;z-index:110;box-sizing:border-box;width:min(380px,calc(100vw - 40px));padding:16px;border:1px solid var(--accent);background:var(--surface,#202427);color:var(--text,#eee)}.app-update-result button{float:right}.app-update-result pre{white-space:pre-wrap;overflow-wrap:anywhere;max-height:160px;overflow:auto}.app-update-launcher{position:fixed;right:20px;bottom:20px;z-index:100;width:46px;height:46px;padding:10px;display:grid;place-items:center;border:1px solid var(--accent);border-radius:50%;color:var(--accent);background:var(--surface,#202427);box-shadow:var(--shadow-lift,0 4px 18px #0005)}.app-update-launcher[hidden]{display:none}.app-update-launcher::after{content:'';position:absolute;right:0;top:0;width:9px;height:9px;border-radius:50%;background:var(--accent);border:2px solid var(--surface,#202427)}`;doc.head.append(style);
  const launcher=node('button');launcher.type='button';launcher.className='app-update-launcher';launcher.hidden=true;launcher.setAttribute('aria-label','安装 QQA 更新');launcher.append(createIcon('upload',{size:24}));doc.body.append(launcher);
  launcher.addEventListener('click',async()=>{try{await open(await readStatus());}catch(error){await open(latest);if(dialog)dialog.detail.textContent=error.message;}});
  function syncLauncher(){launcher.hidden=!latest?.downloadReady||Boolean(dialog);launcher.title=latest?.downloadReady?`QQA ${latest.version} 已下载，点击安装`:'';}
  function accept(state){latest=state;syncLauncher();onState(state);return state;}
  async function readStatus(){return accept(await api.get('/api/app-update/status'));}
  function showResult(state){
    if(!state?.notificationPending||resultNotice)return;
    const box=resultNotice=node('section'),closeButton=node('button','关闭'),title=node('strong');box.className='app-update-result';box.setAttribute('role','status');
    title.textContent=state.phase==='complete'?`QQA 已更新至 ${state.installedVersion}`:state.phase==='rolledBack'?`更新未完成，已恢复 ${state.installedVersion||state.previousVersion}`:'更新恢复需要处理';
    closeButton.type='button';closeButton.addEventListener('click',async()=>{closeButton.disabled=true;try{await api.post('/api/app-update/ack',{jobId:state.jobId});box.remove();resultNotice=null;}catch{closeButton.disabled=false;}});box.append(closeButton,title);
    if(state.error){const details=node('details');details.append(node('summary','查看原因'),node('pre',state.error));box.append(details);}doc.body.append(box);
  }
  function close(){if(!dialog)return;win.clearTimeout(timer);dialog.root.close();dialog.root.remove();dialog=null;syncLauncher();}
  function render(state){
    if(!dialog)return;dialog.current=state;const{title,status,progress,detail,cancel,install,impact}=dialog;
    const active=ACTIVE.has(state.phase),prepared=state.downloadReady===true;
    title.textContent=prepared?`QQA ${state.version} 已准备好`:`更新至 ${state.version||''}`;
    status.textContent=state.phase==='downloaded'&&!prepared?'下载缓存不可用，请重新下载':LABELS[state.phase]||'准备下载';progress.hidden=!active;
    if(state.phase==='downloading'&&state.total>0){progress.max=state.total;progress.value=Math.min(state.total,state.received||0);detail.textContent=`${Math.floor((state.received||0)*100/state.total)}%`;}else{progress.removeAttribute('value');detail.textContent=state.error||'';}
    detail.className=state.error?'error':'';impact.textContent=prepared||state.installRequested?'安装会保存设置并重启 QQA。账号配置、聊天记录、协议端和用户扩展会保留；失败时恢复旧版。':'下载期间可继续使用 QQA，完成后再决定安装时间。';
    install.hidden=active||['complete','rolledBack','rollbackFailed'].includes(state.phase);install.textContent=prepared?'立即安装':'下载更新';install.disabled=prepared&&state.busy===true;
    cancel.textContent=prepared?'稍后':active?(state.installRequested?'取消安装':'取消下载'):'关闭';cancel.disabled=active&&!CANCELLABLE.has(state.phase);
    dialog.active=active;if(prepared&&dialog.root.open&&!dialog.root.matches(':modal')){dialog.root.close();dialog.root.showModal();}syncLauncher();showResult(state);
  }
  async function poll(){
    if(disposed||!dialog)return;
    try{const state=await readStatus();if(disposed||!dialog)return;render(state);
      if(!reloading&&['complete','rolledBack'].includes(state.phase)&&(startedHere||documentVersion&&state.installedVersion&&documentVersion!==state.installedVersion)){reloading=true;win.location.reload();return;}
      if(!ACTIVE.has(state.phase)&&!state.busy)return;
    }catch{if(!dialog||disposed)return;dialog.status.textContent='正在重新连接 QQA…';if(Date.now()-startedAt>180000){dialog.detail.textContent='暂时无法确认更新状态，重新打开 QQA 后可继续查看。';dialog.cancel.disabled=false;dialog.cancel.textContent='关闭';dialog.active=false;return;}}
    timer=win.setTimeout(()=>void poll(),700);
  }
  async function postpone(){
    const state=dialog?.current;if(!state?.downloadReady){close();return;}close();accept({...state,deferred:true});
    try{accept(await api.post('/api/app-update/defer',{jobId:state.jobId}));}catch(error){if(!disposed){await open(state);if(dialog){dialog.detail.textContent=error.message;dialog.detail.className='error';}}}
  }
  async function installNow(){
    if(requesting||!dialog)return;const session=dialog,jobId=session.current.jobId;requesting=true;session.install.disabled=true;session.detail.textContent='';
    try{
      await beforeInstall();if(disposed||dialog!==session)return;
      const current=await readStatus();if(disposed||dialog!==session)return;
      if(!current.supported||!current.downloadReady||current.jobId!==jobId){render(current);throw Error(current.reason||'已下载的更新发生变化，请重新查看');}
      session.active=true;session.cancel.disabled=true;session.status.textContent='正在准备安装…';startedHere=true;startedAt=Date.now();
      const state=accept(await api.post('/api/app-update/install',{confirmed:true,jobId}));if(disposed||dialog!==session)return;render(state);void poll();
    }catch(error){if(dialog===session){session.active=false;session.cancel.disabled=false;session.detail.textContent=error.message;session.detail.className='error';}}
    finally{requesting=false;if(dialog===session)session.install.disabled=false;}
  }
  async function open(state=latest){
    if(disposed)return;if(!state)state=await readStatus();if(disposed)return;
    if(dialog){dialog.root.focus();return;}
    const root=node('dialog'),head=node('header'),title=node('h3'),notes=node('p',state.notes||''),impact=node('p'),status=node('p'),progress=node('progress'),detail=node('p'),actions=node('div'),cancel=node('button'),install=node('button');
    root.className='app-update-dialog';root.setAttribute('aria-label','更新 QQA');status.setAttribute('role','status');actions.className='actions';install.className='primary';cancel.type=install.type='button';head.append(title);actions.append(cancel,install);root.append(head,notes,impact,status,progress,detail,actions);doc.body.append(root);dialog={root,title,status,progress,detail,cancel,install,impact,current:state,active:false};
    root.addEventListener('cancel',event=>{event.preventDefault();if(dialog&&!dialog.active)void postpone();});
    cancel.addEventListener('click',async()=>{if(!dialog)return;if(dialog.current?.downloadReady){await postpone();return;}if(dialog.active){cancel.disabled=true;try{await api.post('/api/app-update/cancel',{});await poll();}catch(error){detail.textContent=error.message;cancel.disabled=false;}}else close();});
    install.addEventListener('click',()=>{if(dialog?.current.downloadReady)void installNow();else void download(dialog.current);});
    render(state);if(state.downloadReady||state.installRequested)root.showModal();else root.show();
  }
  async function download(offer){
    if(disposed||requesting)return;requesting=true;let session;
    try{
      const current=await readStatus();if(disposed)return;
      if(current.downloadReady&&(current.offerVersion??current.version)===current.version){await open(current);return;}
      if(current.busy){await open(current);startedAt=Date.now();void poll();return;}
      if(!current.supported||!current.available||current.offerId!==offer.offerId)throw Error(current.reason||'更新信息已变化，请重新检查');
      await open({...current,phase:'idle',downloadReady:false,busy:false,version:current.offerVersion??offer.version,notes:offer.notes??current.notes});session=dialog;if(!session)return;
      session.active=true;session.cancel.disabled=true;session.install.hidden=true;session.detail.textContent='';session.status.textContent='开始下载…';startedAt=Date.now();
      const state=accept(await api.post('/api/app-update/start',{confirmed:true,offerId:offer.offerId}));if(disposed||dialog!==session)return;render(state);void poll();
    }catch(error){if(!disposed){await open(latest??offer);if(dialog){dialog.active=false;dialog.cancel.disabled=false;dialog.detail.textContent=error.message;dialog.detail.className='error';}}}
    finally{requesting=false;}
  }
  async function hydrate(){
    try{const state=await readStatus();if(disposed)return;documentVersion=state.currentVersion??null;showResult(state);
      if(state.downloadReady){if(!state.deferred)await open(state);}
      else if(ACTIVE.has(state.phase)){await open(state);startedAt=Date.now();void poll();}
    }catch{/* Older servers retain their manual download link. */}
  }
  void hydrate();
  return{open,download,status:()=>latest,dispose(){disposed=true;win.clearTimeout(timer);close();resultNotice?.remove();launcher.remove();style.remove();}};
}
