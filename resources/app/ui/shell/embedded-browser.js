// Host-owned geometry and lifecycle; opaque panels never choose a native window.
export function createEmbeddedBrowserHost({getFrame,emit=()=>{},openDesktop,bridge=window.qqAgentShell}={}){
  let frame=null,rect=null,active=false,raf=0,last='',webOpened=false,disposed=false;
  const native=typeof bridge?.browser==='function';
  function allowed(){return active&&frame?.isConnected&&frame===getFrame()&&!document.hidden&&!document.querySelector('dialog[open]')&&!document.querySelector('.app-shell')?.inert;}
  function bounds(){const outer=frame.getBoundingClientRect(),left=Math.max(outer.left,outer.left+rect.x),top=Math.max(outer.top,outer.top+rect.y),right=Math.min(outer.right,outer.left+rect.x+rect.width,innerWidth),bottom=Math.min(outer.bottom,outer.top+rect.y+rect.height,innerHeight);return{x:Math.max(0,left),y:Math.max(0,top),width:Math.max(0,right-Math.max(0,left)),height:Math.max(0,bottom-Math.max(0,top))};}
  async function update(){raf=0;if(!native||disposed)return;const payload=allowed()?{action:'attach',bounds:bounds()}:{action:'hide'};const signature=JSON.stringify(payload);if(signature===last)return;last=signature;try{await bridge.browser(payload);}catch{last='';}}
  function schedule(){if(!raf&&!disposed)raf=requestAnimationFrame(()=>void update());}
  const observer=new MutationObserver(schedule);observer.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:['open','inert','hidden','class','style']});
  const resize=new ResizeObserver(schedule);resize.observe(document.documentElement);addEventListener('resize',schedule);addEventListener('scroll',schedule,true);document.addEventListener('visibilitychange',schedule);
  const unsubscribe=bridge?.onBrowserState?.(state=>{if(active&&frame?.isConnected&&frame===getFrame())emit('browser-state',state);});
  const unfocus=bridge?.onBrowserAddress?.(()=>{if(allowed()){frame.focus();emit('browser-address',{});}});
  async function action(payload,source){
    if(disposed||source!==getFrame()||!source?.isConnected)throw Error('浏览器页面已切换');
    if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['action','bounds','url'].includes(key)))throw Error('浏览器参数无效');
    if(!['attach','hide','close','navigate','back','forward','reload','stop','home','state'].includes(payload.action))throw Error('不支持的浏览器操作');
    if(payload.action==='attach'){
      const box=payload.bounds;if(!box||Object.keys(box).some(key=>!['x','y','width','height'].includes(key))||!['x','y','width','height'].every(key=>Number.isFinite(box[key])&&box[key]>=0&&box[key]<=20000))throw Error('浏览区域无效');
      frame=source;rect=box;active=true;last='';
      if(!native){if(!webOpened){webOpened=true;await openDesktop();}return{ok:true,embedded:false};}
      await update();await bridge.browser({action:'state'});return{ok:true,embedded:true};
    }
    if(payload.action==='hide'||payload.action==='close'){active=false;last='';webOpened=false;if(native)await bridge.browser({action:payload.action});return{ok:true};}
    if(!native)return{ok:false,embedded:false};
    if(!active||frame!==source)throw Error('请先打开作者官网页签');
    return bridge.browser(payload.action==='navigate'?{action:'navigate',url:payload.url}:{action:payload.action});
  }
  return{action,hide(){active=false;webOpened=false;last='';schedule();},dispose(){disposed=true;cancelAnimationFrame(raf);observer.disconnect();resize.disconnect();unsubscribe?.();unfocus?.();removeEventListener('resize',schedule);removeEventListener('scroll',schedule,true);document.removeEventListener('visibilitychange',schedule);if(native)void bridge.browser({action:'hide'}).catch(()=>{});}};
}
