import {installDisposableDialog} from '../panels/dialog-lifecycle.js';
import {PUBLIC_CAPTCHA_SDK} from './public-captcha.js';

// Fixed targets match the authenticated backend and desktop probe. Fetching
// the SDK checks the actual resource without executing it or solving a CAPTCHA.
export const CAPTCHA_DIAGNOSTIC_TARGETS=Object.freeze([
  {url:PUBLIC_CAPTCHA_SDK,label:'验证码脚本',method:'GET',kind:'sdk',renderer:true},
  {url:'https://captcha.cn-shanghai.aliyuncs.com/',label:'验证码接口',method:'HEAD',kind:'api',renderer:true},
]);
const failures={dns:'域名解析失败',tls:'证书连接失败',timeout:'请求超时',blocked:'安全规则拒绝访问',network:'连接失败'};
function describe(result,target){
  if(result?.ok!==true||!Number.isInteger(result.status)||result.status<100||result.status>599)return{text:failures[result?.error]||'未获得 HTTP 响应',state:'bad'};
  const status=result.status;if(status<200||status>=300)return{text:`收到 HTTP ${status}`,state:'warn'};
  if(target.kind==='sdk'&&!/javascript|ecmascript/i.test(result.contentType||''))return{text:`HTTP ${status} · 响应不是脚本`,state:'warn'};
  return{text:`${target.kind==='sdk'?'脚本可下载':'接口已响应'} · HTTP ${status}`,state:'good'};
}
function untilAborted(promise,signal){
  if(signal.aborted)return Promise.reject(signal.reason);
  return new Promise((resolve,reject)=>{const abort=()=>{signal.removeEventListener('abort',abort);reject(signal.reason);};signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});});
}
async function rendererProbe(target,signal,fetchImpl) {
  const controller=new AbortController(),abort=()=>controller.abort(signal.reason);
  signal.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(()=>controller.abort(new DOMException('请求超时','TimeoutError')),5000);
  try {
    if(signal.aborted)throw signal.reason;
    const response=await untilAborted(fetchImpl(target.url,{method:target.method,mode:'cors',redirect:'manual',credentials:'omit',cache:'no-store',signal:controller.signal}),controller.signal);
    try{void response.body?.cancel?.().catch?.(()=>{});}catch{}
    if(response.type==='opaque'||response.type==='opaqueredirect'||response.status===0)return{text:'请求已完成 · 浏览器不提供状态',state:'neutral'};
    return describe({ok:true,status:response.status,contentType:response.headers?.get?.('content-type')},target);
  } catch {return controller.signal.reason?.name==='TimeoutError'?{text:'请求超时',state:'bad'}:{text:'浏览器未提供结果',state:'neutral'};}
  finally {clearTimeout(timer);signal.removeEventListener('abort',abort);}
}

// All content stays in the root document; callers can only open this fixed UI.
export function createCaptchaDiagnostics({win=window,doc=document,fetchImpl=(...args)=>win.fetch(...args),backendProbe=null}={}) {
  let current=null;
  function open() {
    if(current?.dialog.open){current.run.focus();return {ok:true};}
    const dialog=doc.createElement('dialog');dialog.id='captcha-diagnostics-dialog';dialog.className='captcha-diagnostics-dialog';
    const element=(tag,text,className)=>{const node=doc.createElement(tag);if(text)node.textContent=text;if(className)node.className=className;return node;};
    const title=element('h2','验证码诊断');title.id='captcha-diagnostics-title';dialog.setAttribute('aria-labelledby',title.id);
    const explanation=element('p','检测资源和网络连接，不代表已通过人机验证。','captcha-diagnostics-intro');
    const interceptor=element('p','正在读取检测方式…');interceptor.id='captcha-interceptor-state';interceptor.setAttribute('role','status');
    const status=element('p','点击“检测网络”开始；不会登录或发布内容。');status.id='captcha-diagnostics-status';status.setAttribute('role','status');
    const table=element('div',null,'captcha-diagnostics-grid');table.setAttribute('role','table');table.setAttribute('aria-label','验证码网络检测结果');
    const header=element('div',null,'captcha-diagnostics-row captcha-diagnostics-header');header.setAttribute('role','row');for(const label of ['检测目标','QQA 后台','当前浏览器']){const cell=element('strong',label);cell.setAttribute('role','columnheader');header.append(cell);}table.append(header);
    const rows=CAPTCHA_DIAGNOSTIC_TARGETS.map(target=>{const row=element('div',null,'captcha-diagnostics-row');row.setAttribute('role','row');const label=element('strong',target.label),node=element('span','尚未检测','captcha-diagnostic-result'),renderer=element('span','尚未检测','captcha-diagnostic-result');label.title=target.url;node.dataset.label='QQA 后台';renderer.dataset.label='当前浏览器';for(const cell of [label,node,renderer])cell.setAttribute('role','cell');row.append(label,node,renderer);table.append(row);return{target,node,renderer};});
    const run=element('button','检测网络','primary');run.type='button';run.id='captcha-diagnostics-run';
    const close=element('button','关闭');close.type='button';close.id='captcha-diagnostics-close';
    const actions=element('div',null,'dialog-actions');actions.append(close,run);
    const help=element('details',null,'captcha-diagnostics-help');help.append(element('summary','为什么两边结果不同？'),element('p','浏览器可能因为跨域或来源限制，无法提供响应状态。后台检测不受浏览器跨域规则影响；403、404 表示收到了响应，不能当作组件可用。验证码是否通过，以实际验证弹窗为准。'));
    dialog.append(title,explanation,interceptor,table,status,help,actions);doc.body.append(dialog);
    const session={dialog,run,controller:null,busy:false};current=session;
    const active=()=>current===session&&dialog.open;
    const paint=(cell,value)=>{cell.textContent=value.text;cell.dataset.state=value.state;};
    async function readInterceptor(){
      if(typeof win.qqAgentShell?.captchaInterceptorStatus!=='function'){if(active())interceptor.textContent=backendProbe?'浏览器模式 · 可使用 QQA 后台检测':'浏览器模式 · 本页面未接入后台检测';return;}
      try {
        const value=await win.qqAgentShell.captchaInterceptorStatus();if(!active())return;
        if(value?.mode==='direct'){interceptor.textContent='桌面模式 · 验证码使用官方直连';return;}
        if(value?.installed!==true){interceptor.textContent='桌面转发未安装或状态未确认；检测将直接访问官方资源';return;}
        const count=Number.isSafeInteger(value.redirectCount)&&value.redirectCount>=0?value.redirectCount:0;
        interceptor.textContent=`旧桌面转发已安装 · 已转发 ${count} 次${value.lastError?' · 最近出现转发异常':''}。请重启应用以使用官方直连。`;
      }catch{if(active())interceptor.textContent='无法读取桌面转发状态，请重试或重新打开桌面应用。';}
    }
    run.addEventListener('click',async()=>{
      if(session.busy)return;session.busy=true;run.disabled=true;run.textContent='检测中…';table.setAttribute('aria-busy','true');status.textContent='正在检测验证码脚本和接口…';const controller=new AbortController();session.controller=controller;
      const timer=setTimeout(()=>controller.abort(new DOMException('请求超时','TimeoutError')),6500);
      for(const row of rows){paint(row.node,{text:'检测中…',state:'pending'});paint(row.renderer,{text:'检测中…',state:'pending'});}
      const native=win.qqAgentShell?.captchaNetProbe,hasNode=typeof native==='function'||typeof backendProbe==='function';
      const nodePromise=hasNode?untilAborted(Promise.resolve().then(()=>typeof native==='function'?native.call(win.qqAgentShell):backendProbe({signal:controller.signal})),controller.signal).then(value=>({value}),()=>({failed:true})):Promise.resolve({unavailable:true});
      const rendererPromise=Promise.all(rows.map(row=>rendererProbe(row.target,controller.signal,fetchImpl)));
      try {
        const [node,renderer]=await Promise.all([nodePromise,rendererPromise]);if(!active())return;
        rows.forEach((row,index)=>{const result=node.value?.targets?.find(item=>item.target===row.target.url);paint(row.node,node.unavailable?{text:'后台检测未接入',state:'neutral'}:node.failed?{text:controller.signal.aborted?'后台检测超时':'后台检测失败',state:'bad'}:describe(result,row.target));paint(row.renderer,renderer[index]);});
        status.textContent='检测完成。请查看脚本是否可下载；浏览器未提供结果时，可参考后台检测。';void readInterceptor();
      }finally{clearTimeout(timer);if(active()){session.busy=false;run.disabled=false;run.textContent='检测网络';table.removeAttribute('aria-busy');}if(session.controller===controller)session.controller=null;}
    });
    close.addEventListener('click',()=>dialog.close());
    installDisposableDialog(dialog,{onClosed:()=>{session.controller?.abort(new Error('诊断已关闭'));session.controller=null;if(current===session)current=null;}});
    dialog.showModal();run.focus();void readInterceptor();return {ok:true};
  }
  return Object.freeze({open});
}
