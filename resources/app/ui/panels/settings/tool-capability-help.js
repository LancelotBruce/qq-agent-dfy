import {installDisposableDialog} from '../dialog-lifecycle.js';

const capabilityLabels={'qq.emoji-favorites':'QQ 账号表情收藏'};
export function toolCapabilityIssue(tool,state){
  if(state?.enabled||state?.code!=='CAPABILITY_MISSING')return null;
  // Older servers expose missing dependencies only in this registry-generated
  // reason. Prefer structured names when supplied; never interpret arbitrary
  // extension errors as a dependency or executable instruction.
  const source=Array.isArray(state.missingCapabilities)?state.missingCapabilities:
    typeof state.reason==='string'&&state.reason.startsWith('缺少能力：')?state.reason.slice(5).split(','):[];
  const capabilities=[...new Set(source.filter(name=>typeof name==='string').map(name=>name.trim()).filter(name=>/^[\w.:-]{1,128}$/.test(name)))].slice(0,16);
  const favorites=capabilities.includes('qq.emoji-favorites');
  return{capabilities,
    summary:favorites?'QQ 表情收藏接口尚未就绪':'所需功能尚未接入',
    title:favorites?'检查 QQ 表情收藏连接':`${tool.name||tool.id}需要额外支持`,
    explanation:favorites?'这里的“收藏”会把图片存进 QQ 账号的表情包。SnowLuma 提供了对应的 OneBot 扩展接口，QQA 会在账号连接后检查并自动接入。':'这项工具需要由扩展提供的功能，目前该功能尚未就绪。工具开关只决定是否使用它，不能补齐缺失的功能。',
    guidance:favorites?'请先在“QQ 连接”中确认账号已连接，再重新检查。当前已适配 SnowLuma；其他协议端需要匹配各自的接口参数。已连接仍未就绪时，应核对版本、接口响应和 QQA 适配，不需要仅为此另装收藏插件。':'如果已安装提供该功能的扩展，请在“插件”或“技能”页检查其开关和加载状态；如果没有，需要先安装或开发相应的适配扩展。',
    unaffected:favorites?'本地表情库的查询和发送不受这个接口缺失影响。':'',
  };
}

let sequence=0;
export function openToolCapabilityHelp({tool,state,request,onRefresh=async()=>{},onConnect,doc=document}){
  const issue=toolCapabilityIssue(tool,state);if(!issue)return null;
  const node=(tag,cls,value)=>{const element=doc.createElement(tag);if(cls)element.className=cls;if(value!==undefined)element.textContent=value;return element;};
  const dialog=node('dialog','tool-capability-dialog');dialog.dataset.toolCapability=tool.id;
  const heading=node('h3','',issue.title);heading.id=`tool-capability-title-${++sequence}`;dialog.setAttribute('aria-labelledby',heading.id);
  const status=node('p','tool-capability-status'),providers=node('ul','tool-capability-providers');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const technical=node('details','tool-capability-technical'),summary=node('summary','','技术详情'),detail=node('pre','');detail.textContent=state.reason||'未提供缺失功能的名称。';technical.append(summary,detail);
  const actions=node('div','actions'),retry=node('button','','重新检查'),close=node('button','','完成');retry.type=close.type='button';
  if(issue.capabilities.includes('qq.emoji-favorites')&&typeof onConnect==='function'){
    const connect=node('button','','查看 QQ 连接');connect.type='button';connect.addEventListener('click',()=>{life.close();onConnect();});actions.append(connect);
  }
  actions.append(retry,close);
  dialog.append(heading,node('p','',issue.explanation),status,providers,node('p','',issue.guidance));
  if(issue.unaffected)dialog.append(node('p','muted',issue.unaffected));dialog.append(technical,actions);
  const life=installDisposableDialog(dialog,{dismissOnBackdrop:true});
  close.addEventListener('click',()=>life.close());retry.addEventListener('click',()=>void check());
  doc.body.append(dialog);dialog.showModal();void check();
  async function check(){
    if(retry.disabled||life.closed)return;retry.disabled=true;status.dataset.state='loading';status.textContent='正在检查提供者…';providers.replaceChildren();
    try{
      const catalogue=await request('GET','/api/skills/capabilities');
      if(life.closed||!dialog.isConnected)return;
      if(!Array.isArray(catalogue?.capabilities))throw Error('提供者列表不完整');
      let ready=issue.capabilities.length>0;
      for(const name of issue.capabilities){
        const capability=catalogue.capabilities.find(item=>item.name===name),rows=capability?.providers||[];
        ready=ready&&capability?.available===true;
        const item=node('li',''),title=node('strong','',capabilityLabels[name]||name);item.append(title);
        if(!rows.length)item.append(node('span','',name==='qq.emoji-favorites'?'当前协议连接尚未提供可用的收藏接口；未连接或未通过检查时不会标记为可用。':'当前没有已注册的提供者；扩展可能未安装、未启用或未加载成功。'));
        for(const provider of rows.slice(0,16)){
          const owner=provider.ownerId??provider.skillId;
          const providerState=!provider.implemented?'接口尚未就绪':!provider.active?'未启用或未加载':provider.managed&&!provider.running?'服务未就绪':provider.usable?'已就绪':'暂不可用';
          item.append(node('span','',`${owner==='transport-onebot'?'OneBot 协议连接':owner==='kernel'?'内置服务':owner||'未知扩展'} · ${providerState}`));
        }
        providers.append(item);
      }
      await onRefresh();if(life.closed||!dialog.isConnected)return;
      status.dataset.state=ready?'ready':'missing';
      status.textContent=!issue.capabilities.length?'未提供可定位的功能名称，请查看技术详情。':ready?'所需功能已接入，工具状态已重新检查。':'当前没有可用的提供者。';
    }catch{
      if(!life.closed&&dialog.isConnected){providers.replaceChildren();status.dataset.state='error';status.textContent='检查失败，暂时无法确认提供者状态。请重试。';}
    }finally{if(!life.closed)retry.disabled=false;}
  }
  return life;
}
