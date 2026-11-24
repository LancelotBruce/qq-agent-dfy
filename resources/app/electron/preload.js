/** Narrow, context-isolated bridge. No token, config, kernel, or filesystem objects cross into renderer. */
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('qqAgentShell', Object.freeze({
  getConsoleToken: () => ipcRenderer.invoke('qq-agent:get-console-token'),
  browser: payload => ipcRenderer.invoke('qqa-browser:command', payload),
  onBrowserState: callback => { const listener=(_event,state)=>callback(state);ipcRenderer.on('qqa-browser:state',listener);return()=>ipcRenderer.removeListener('qqa-browser:state',listener); },
  onBrowserOpen: callback => { const listener=()=>callback();ipcRenderer.on('qqa-browser:open-author',listener);return()=>ipcRenderer.removeListener('qqa-browser:open-author',listener); },
  onBrowserAddress: callback => { const listener=()=>callback();ipcRenderer.on('qqa-browser:focus-address',listener);return()=>ipcRenderer.removeListener('qqa-browser:focus-address',listener); },
  captchaNetProbe: () => ipcRenderer.invoke('qqa-captcha-net-probe'),
  captchaInterceptorStatus: () => ipcRenderer.invoke('qqa-captcha-interceptor-status'),
  quit: () => ipcRenderer.send('qq-agent:quit'),
  reload: () => ipcRenderer.send('qq-agent:reload'),
  onPrepareLeave: callback => {
    if(typeof callback!=='function')throw new TypeError('保存回调无效');
    const listener=async(_event,request)=>{if(typeof request?.requestId!=='string'||!['quit','reload'].includes(request.reason))return;let result;try{result=await callback({reason:request.reason});}catch(error){result={ok:false,error:String(error?.message||'设置尚未保存')};}ipcRenderer.send('qq-agent:leave-result',{requestId:request.requestId,ok:result?.ok===true,error:String(result?.error||'').slice(0,512)});};
    ipcRenderer.on('qq-agent:prepare-leave',listener);ipcRenderer.send('qq-agent:leave-ready');
    return()=>ipcRenderer.removeListener('qq-agent:prepare-leave',listener);
  },
  refocus: () => ipcRenderer.send('app-refocus'),
  openDevTools: () => ipcRenderer.send('qq-agent:open-devtools'),
}));
