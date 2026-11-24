import {randomUUID} from 'node:crypto';
import {browserUrl,createBrowserProxy} from './browser-network.js';

export const AUTHOR_HOME='https://kondius.cn/';
const CHANNEL='qqa-browser:command',STATE='qqa-browser:state';

export function createInAppBrowser(electron,{getParent=()=>null,authorize=()=>false,proxyFactory=createBrowserProxy}={}){
  let current=null,opening=null,disposed=false,wanted=false,latestBounds=null,generation=0;
  const key=randomUUID(),cleanups=new Set(),protectedSessions=new WeakSet(),watchedParents=new WeakSet();
  const supported=typeof electron.WebContentsView==='function'&&typeof electron.session?.fromPartition==='function';
  function snapshot(){const tab=current;if(!tab||tab.contents.isDestroyed())return{url:AUTHOR_HOME,title:'',loading:false,back:false,forward:false,attached:false,error:''};const h=tab.contents.navigationHistory||tab.contents;return{url:tab.contents.getURL()||AUTHOR_HOME,title:tab.contents.getTitle(),loading:tab.contents.isLoading(),back:h.canGoBack(),forward:h.canGoForward(),attached:tab.attached,error:tab.error||''};}
  function send(){const parent=getParent();if(parent&&!parent.isDestroyed())parent.webContents.send(STATE,snapshot());}
  function hide(){wanted=false;const tab=current;if(tab?.attached){tab.attached=false;if(!tab.parent.isDestroyed())tab.parent.contentView.removeChildView(tab.view);}send();}
  function destroyPage(){++generation;wanted=false;const tab=current;current=null;if(!tab)return;if(tab.attached&&!tab.parent.isDestroyed())tab.parent.contentView.removeChildView(tab.view);if(!tab.contents.isDestroyed())tab.contents.close();const cleanup=Promise.allSettled([tab.proxy.close(),tab.session.closeAllConnections(),tab.session.clearStorageData(),tab.session.clearCache()]).finally(()=>cleanups.delete(cleanup));cleanups.add(cleanup);send();}
  async function navigate(raw){const tab=current;if(!tab)return;const url=browserUrl(raw);tab.error='';send();try{await tab.contents.loadURL(url);}catch(error){if(current===tab&&error.code!=='ERR_ABORTED'){tab.error='网页暂时无法打开，请检查地址后重试';send();}}}
  function nativeBounds(parent,box){if(!box||Object.keys(box).some(key=>!['x','y','width','height'].includes(key))||!['x','y','width','height'].every(key=>Number.isFinite(box[key])&&box[key]>=0&&box[key]<=20000))throw Error('浏览区域无效');const [width,height]=parent.getContentSize(),zoom=parent.webContents.getZoomFactor(),x=Math.min(width,Math.round(box.x*zoom)),y=Math.min(height,Math.round(box.y*zoom));return{x,y,width:Math.min(width-x,Math.round(box.width*zoom)),height:Math.min(height-y,Math.round(box.height*zoom))};}
  async function ensurePage(){
    if(disposed||!supported)throw Error('当前运行环境未提供内置浏览器');
    if(current&&!current.contents.isDestroyed())return current;if(opening)return opening;
    const version=generation;
    opening=(async()=>{
      await Promise.allSettled([...cleanups]);const proxy=await proxyFactory();let contents;
      try{
        const parent=getParent();if(disposed||generation!==version||!parent||parent.isDestroyed())throw Error('浏览器页面已关闭');
        const session=electron.session.fromPartition('qqa-web-'+key);await session.setProxy({mode:'fixed_servers',proxyRules:`http://127.0.0.1:${proxy.port}`,proxyBypassRules:'<-loopback>'});
        session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));session.setPermissionCheckHandler(()=>false);session.setDevicePermissionHandler?.(()=>false);
        if(!protectedSessions.has(session)){protectedSessions.add(session);session.on('will-download',event=>{event.preventDefault();if(current){current.error='内置浏览器暂不支持下载文件';send();}});}
        session.webRequest.onBeforeRequest((details,callback)=>{let allowed=false;try{browserUrl(details.url.replace(/^wss:/,'https:'));allowed=true;}catch{allowed=['image','font','stylesheet','media','script','other'].includes(details.resourceType)&&/^(data|blob):/.test(details.url);}callback({cancel:!allowed});});
        const view=new electron.WebContentsView({webPreferences:{session,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,devTools:false,navigateOnDragDrop:false}});contents=view.webContents;contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
        const tab={parent,view,contents,session,proxy,error:'',attached:false,started:false};current=tab;
        const guard=(event,url)=>{try{browserUrl(url);}catch{event.preventDefault();tab.error='已阻止本机、内网或不安全的链接';send();}};
        contents.setWindowOpenHandler(({url})=>{try{void navigate(browserUrl(url));}catch{tab.error='已阻止非公网 HTTPS 链接';send();}return{action:'deny'};});
        contents.on('will-navigate',guard);contents.on('will-redirect',guard);contents.on('will-frame-navigate',event=>guard(event,event.url));contents.on('login',(event,_details,_auth,callback)=>{event.preventDefault();callback();});
        for(const event of ['did-navigate','did-navigate-in-page','did-start-loading','did-stop-loading','page-title-updated'])contents.on(event,send);
        contents.on('did-fail-load',(_event,code,_description,_url,isMainFrame)=>{if(isMainFrame&&code!==-3){tab.error='网页暂时无法打开，请刷新或换个地址';send();}});
        contents.on('render-process-gone',()=>{tab.error='网页进程已退出，可点击刷新重新打开';send();});
        contents.on('before-input-event',(event,input)=>{if(input.type!=='keyDown')return;const k=input.key?.toLowerCase();if((input.control||input.meta)&&k==='l'){event.preventDefault();parent.webContents.focus();parent.webContents.send('qqa-browser:focus-address');}else if(k==='f5'||(input.control||input.meta)&&k==='r'){event.preventDefault();contents.reload();}});
        if(!watchedParents.has(parent)){watchedParents.add(parent);parent.webContents.on('did-start-navigation',(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace&&current?.parent===parent)hide();});parent.once('closed',()=>{if(current?.parent===parent)destroyPage();});}
        if(disposed||generation!==version){destroyPage();throw Error('浏览器页面已关闭');}return tab;
      }catch(error){if(contents&&!contents.isDestroyed())contents.close();await proxy.close();throw error;}
    })().finally(()=>opening=null);return opening;
  }
  async function command(payload){
    if(disposed)throw Error('浏览器已停止');
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['action','url','bounds'].includes(key)))throw Error('浏览器操作参数无效');
    const action=payload.action;if(action!=='navigate'&&Object.hasOwn(payload,'url')||action!=='attach'&&Object.hasOwn(payload,'bounds'))throw Error('浏览器操作参数无效');
    if(action==='attach'){
      const parent=getParent();if(!parent||parent.isDestroyed())throw Error('客户端窗口尚未就绪');latestBounds=nativeBounds(parent,payload.bounds);wanted=true;const tab=await ensurePage();if(!wanted||current!==tab)return{ok:true};tab.view.setBounds(latestBounds);if(latestBounds.width>0&&latestBounds.height>0&&!tab.attached){tab.parent.contentView.addChildView(tab.view);tab.attached=true;}else if(!latestBounds.width||!latestBounds.height)hide();if(!tab.started&&wanted){tab.started=true;void navigate(AUTHOR_HOME);}
    }else if(action==='hide')hide();else if(action==='close')destroyPage();else if(action==='state')send();
    else{
      const tab=current;if(!tab||tab.contents.isDestroyed())throw Error('请先打开作者官网页签');
      if(action==='navigate')void navigate(browserUrl(payload.url));else if(action==='home')void navigate(AUTHOR_HOME);
      else if(action==='back'||action==='forward'){const h=tab.contents.navigationHistory||tab.contents,can=action==='back'?'canGoBack':'canGoForward',go=action==='back'?'goBack':'goForward';if(h[can]())h[go]();}
      else if(action==='reload'){tab.error='';tab.contents.reload();}else if(action==='stop')tab.contents.stop();else throw Error('不支持的浏览器操作');
    }
    send();return{ok:true};
  }
  if(supported)electron.ipcMain.handle(CHANNEL,(event,payload)=>{if(!authorize(event))throw Error('不允许的浏览器操作');return command(payload);});
  return{available:()=>supported&&!disposed,isAttached:()=>current?.attached===true,command,open(){if(disposed||!supported)throw Error('当前运行环境未提供桌面内置浏览器');const parent=getParent();if(!parent||parent.isDestroyed())throw Error('客户端窗口尚未就绪');parent.show();parent.focus();parent.webContents.send('qqa-browser:open-author');return{ok:true};},async close(){disposed=true;destroyPage();try{await opening;}catch{}await Promise.allSettled([...cleanups]);electron.ipcMain.removeHandler?.(CHANNEL);}};
}
