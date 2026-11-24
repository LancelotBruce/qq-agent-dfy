import {createAutoSave} from './auto-save.js';

// A separate autosave queue keeps shared desktop preferences out of the
// current QQ account's FormState and its settings recovery drafts.
export function createClientDesktop({root,inputs,note,request}){
  const doc=root.ownerDocument,keys=Object.keys(inputs),draft=new Map(),invalid=new Map(),listeners=[];
  const message=doc.createElement('span'),retry=doc.createElement('button');
  retry.type='button';retry.textContent='重试';retry.hidden=true;note.dataset.clientDesktopNote='';note.replaceChildren(message,retry);
  let disposed=false,baseline=null,readVersion=0,editVersion=0,reading=null;
  function status(error){message.textContent=error||'所有账号共用，修改后自动保存。';note.classList.toggle('field-error',!!error);retry.hidden=!error;}
  function paint(){
    for(const key of keys){
      const input=inputs[key];input.disabled=!baseline;
      if(!draft.has(key)&&!invalid.has(key)&&doc.activeElement!==input){
        if(input.type==='checkbox'){input.checked=baseline?.[key]===true;input.toggleAttribute('checked',input.checked);}
        else if(baseline)input.value=String(baseline[key]);
      }
    }
  }
  const queue=createAutoSave({root,delay:450,dirty:()=>draft.size>0||invalid.size>0,onError:error=>status(error.message),save:async()=>{
    if(invalid.size)throw Error([...invalid.values()][0]);
    if(!draft.size)return;
    const snapshot=new Map(draft),result=await request(Object.fromEntries(snapshot));
    if(disposed)return;
    baseline=result;
    for(const[key,value]of snapshot)if(draft.get(key)===value)draft.delete(key);
    ++editVersion;paint();status();
  }});
  function edited(key){
    if(disposed||!baseline)return;
    const input=inputs[key],error=input.closest('.setting-field').querySelector('.field-error');
    try{
      const value=input.type==='checkbox'?input.checked:Number(input.value);
      if(input.type!=='checkbox'&&(!input.value.trim()||!Number.isInteger(value)||value<1024||value>65535))throw Error('控制台端口须为 1024～65535 的整数');
      invalid.delete(key);input.removeAttribute('aria-invalid');error.hidden=true;draft.set(key,value);status();
    }catch(cause){invalid.set(key,cause.message);input.setAttribute('aria-invalid','true');error.hidden=false;error.textContent=cause.message;}
    ++editVersion;queue.schedule();
  }
  for(const key of keys){const input=inputs[key],event=input.type==='checkbox'?'change':'input',handler=()=>edited(key);input.disabled=true;
    input.closest('.setting-field').dataset.settingScope='client';input.setAttribute('aria-description','所有账号共用的客户端设置');
    input.addEventListener(event,handler);listeners.push(()=>input.removeEventListener(event,handler));}
  async function refresh(){
    if(disposed||queue.dirty)return;
    if(reading)return reading;
    const ticket=++readVersion,version=editVersion;
    reading=(async()=>{try{
      const result=await request();
      if(disposed||ticket!==readVersion||version!==editVersion||queue.dirty)return;
      baseline=result;paint();status();
    }catch(error){if(!disposed&&ticket===readVersion){status(error.message);paint();}}finally{reading=null;}})();
    return reading;
  }
  const retried=()=>{void(queue.dirty?queue.flush():refresh()).catch(error=>status(error.message));};
  retry.addEventListener('click',retried);
  const focused=()=>void refresh();doc.defaultView.addEventListener('focus',focused);
  status();void refresh();
  return{refresh,dispose(){disposed=true;++readVersion;queue.dispose();listeners.forEach(remove=>remove());retry.removeEventListener('click',retried);doc.defaultView.removeEventListener('focus',focused);}};
}
