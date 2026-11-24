import {controlCommunityBrowser,onShellEvent,onLeave} from '../panel-client.js';

export function mountCommunityBrowser({onClose}={}){
  const $=selector=>document.querySelector(selector),viewport=$('#browser-viewport'),address=$('#browser-address'),status=$('#browser-status');let active=false,raf=0,loading=false,ticket=0,localError='';
  const trackedAnimations=new WeakSet();
  function message(value){status.textContent=value||'';}
  function box(){
    // WAAPI entry animations do not fire CSS animationend. Re-measure once
    // they finish, without polling the native view throughout an idle page.
    for(let node=viewport;node;node=node.parentElement)for(const animation of node.getAnimations?.()||[]){if(!trackedAnimations.has(animation)){trackedAnimations.add(animation);void animation.finished.then(schedule,schedule);}}
    const b=viewport.getBoundingClientRect();return{x:b.x,y:b.y,width:b.width,height:b.height};
  }
  async function attach(){raf=0;if(!active)return;if(document.querySelector('dialog[open]')){await command('hide');return;}const version=++ticket;try{const result=await controlCommunityBrowser({action:'attach',bounds:box()});if(!active||version!==ticket)return;viewport.classList.toggle('browser-in-desktop',result.embedded===true);if(localError||result.embedded===false)message(localError||'网页已在 QQA 桌面客户端的“作者官网”页签中打开。');}catch(error){if(active&&version===ticket){localError=error.message;message(localError);}}}
  function schedule(){if(active&&!raf)raf=requestAnimationFrame(()=>void attach());}
  async function command(action,url){if(['navigate','home','reload','back','forward','close'].includes(action))localError='';try{await controlCommunityBrowser({action,...(url===undefined?{}:{url})});}catch(error){localError=error.message;message(localError);}}
  $('#browser-address-form').addEventListener('submit',event=>{event.preventDefault();void command('navigate',address.value);});
  // Panels cannot submit forms through their sandbox. Keep navigation on the
  // narrow browser RPC instead of granting form/network privileges to a panel.
  address.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void command('navigate',address.value);}});
  $('#browser-go').addEventListener('click',()=>void command('navigate',address.value));
  for(const action of ['back','forward','home'])$('#browser-'+action).addEventListener('click',()=>command(action));
  $('#browser-reload').addEventListener('click',()=>command(loading?'stop':'reload'));
  $('#browser-close').addEventListener('click',()=>{void command('close');onClose?.();});
  const focusAddress=()=>{if(active){address.focus();address.select();}};
  const unlisten=onShellEvent((name,state)=>{if(!active)return;if(name==='browser-address'){focusAddress();return;}if(name!=='browser-state')return;loading=state.loading;$('#browser-back').disabled=!state.back;$('#browser-forward').disabled=!state.forward;const reload=$('#browser-reload');reload.textContent=loading?'×':'↻';reload.setAttribute('aria-label',loading?'停止加载':'刷新网页');reload.title=loading?'停止加载':'刷新网页';if(document.activeElement!==address)address.value=state.url||'https://kondius.cn/';message(localError||state.error||'');});
  const observer=new ResizeObserver(schedule);observer.observe(viewport);const modals=new MutationObserver(records=>{if(!active||!records.some(record=>record.target.matches?.('dialog')||[...record.addedNodes,...record.removedNodes].some(node=>node.matches?.('dialog')||node.querySelector?.('dialog'))))return;if(document.querySelector('dialog[open]'))void command('hide');else schedule();});modals.observe(document.body,{subtree:true,attributes:true,attributeFilter:['open'],childList:true});
  addEventListener('resize',schedule);addEventListener('scroll',schedule,true);
  const layoutEnd=event=>{if(event.target===viewport||event.target?.contains?.(viewport))schedule();};
  document.addEventListener('animationend',layoutEnd,true);document.addEventListener('transitionend',layoutEnd,true);
  const keys=event=>{if(!active)return;const key=event.key.toLowerCase();if((event.ctrlKey||event.metaKey)&&key==='l'){event.preventDefault();focusAddress();}else if(key==='f5'||(event.ctrlKey||event.metaKey)&&key==='r'){event.preventDefault();void command('reload');}};document.addEventListener('keydown',keys);
  onLeave(()=>{active=false;++ticket;cancelAnimationFrame(raf);observer.disconnect();modals.disconnect();unlisten();removeEventListener('resize',schedule);removeEventListener('scroll',schedule,true);document.removeEventListener('animationend',layoutEnd,true);document.removeEventListener('transitionend',layoutEnd,true);document.removeEventListener('keydown',keys);});
  return{show(value){active=value;++ticket;document.body.dataset.browserActive=String(value);if(value)schedule();else{cancelAnimationFrame(raf);raf=0;void command('hide');}}};
}
