// Display-only request metadata. No messages, prompts or credentials belong here.
const tools={send_message:'发送消息',send_to:'跨会话发送',finish:'结束本轮',web_search:'搜索网页',web_fetch:'读取网页'};
const seconds=value=>`${Math.max(0,Math.floor(value/1000))} 秒`;
export function sessionProgress(session){
  if(!['waiting','running'].includes(session?.status))return null;
  return session.activeStep?.progress??session.progress??(session.activeStep?.kind==='tool'
    ?{phase:'tool',name:session.activeStep.name,since:session.activeStep.startedAt}
    :session.status==='running'&&!session.activity?{phase:'preparing',since:session.startedAt}:null);
}
export function describeProgress(progress,now=Date.now()){
  if(!progress)return{text:'',tone:''};
  const age=Math.max(0,now-Number(progress.lastOutputAt??progress.requestStartedAt??progress.since??now));
  const model=String(progress.model??'').slice(0,160),attempt=Number(progress.requestAttempt)||0;
  let text,tone='';
  switch(progress.phase){
    case 'queued':text=`排队中${progress.position?` · 第 ${progress.position} 位`:''} · 已等 ${seconds(now-Number(progress.since??now))}`;break;
    case 'preparing':text='准备上下文';break;
    case 'retry':text=`请求失败 · ${Math.max(0,Math.ceil((Number(progress.retryAt)-now)/1000))} 秒后重试${progress.attempt?`（第 ${progress.attempt} 次）`:''}`;tone='warn';break;
    case 'fallback':text=`切换备用模型${model?` · ${model}`:''}`;break;
    case 'tool':text=`执行工具 · ${tools[progress.name]??progress.name??'处理中'}`;break;
    case 'tool-arguments':text='模型正在生成工具参数';break;
    case 'thinking':text='模型正在思考';break;
    case 'responding':text='模型正在输出';break;
    case 'receiving':text='正在接收模型响应';break;
    default:text=`等待模型返回${attempt>1?` · 第 ${attempt} 次请求`:''}`;
  }
  if(['request','receiving','thinking','responding','tool-arguments'].includes(progress.phase)&&age>=20000){
    text+=` · ${seconds(age)}暂无新输出`;tone='warn';
  }
  return{text,tone,title:model?`当前请求模型：${model}`:''};
}
export function bindProgress(node,progress){
  if(!progress){node.hidden=true;delete node.dataset.progressClock;return;}
  node.hidden=false;node.dataset.progressClock=JSON.stringify(progress);paintProgress(node,progress);
}
export function paintProgress(node,progress,now=Date.now()){
  const value=describeProgress(progress,now);if(node.textContent!==value.text)node.textContent=value.text;
  if(node.dataset.tone!==value.tone)node.dataset.tone=value.tone;if(node.title!==value.title)node.title=value.title;
}
