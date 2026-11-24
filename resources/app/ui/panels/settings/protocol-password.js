import {createIcon} from '../icons.js';
import {destructiveButton} from '../ui.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {createAutoSave,saveFeedback} from './auto-save.js';

export function createProtocolPasswordEditor({request,doc=document}={}){
  let dialog=null,life=null,queue=null,input=null,disposed=false;
  const node=(tag,cls,text)=>{const value=doc.createElement(tag);if(cls)value.className=cls;if(text!==undefined)value.textContent=text;return value;};
  async function open(instance){
    if(disposed||!instance?.id)return;if(dialog){dialog.focus();return;}
    const current=node('dialog','protocol-password-dialog');dialog=current;current.dataset.protocolPassword=instance.provider;
    const head=node('div','settings-dialog-head'),heading=node('h3','','设置协议端密码'),close=node('button'),body=node('div','protocol-password-body'),service=node('p','muted'),label=node('label','protocol-password-field'),caption=node('span','','协议端管理密码'),wrap=node('span','protocol-password-input'),password=node('input'),show=node('button','','显示'),status=node('p','protocol-password-status','读取中…'),error=node('p','field-error'),hint=node('small','muted','输入后自动保存，用于此协议端今后的自动验证。两步验证码仍需单独输入。');
    input=password;close.type=show.type='button';close.setAttribute('aria-label','关闭协议端密码设置');close.append(createIcon('close',{size:18}));close.addEventListener('click',()=>{void life?.close();});
    password.type='password';password.setAttribute('aria-label','协议端管理密码');password.autocomplete='off';password.maxLength=8192;password.disabled=true;show.disabled=true;show.setAttribute('aria-label','显示协议端密码');show.setAttribute('aria-pressed','false');
    show.addEventListener('click',()=>{const visible=password.type==='password';password.type=visible?'text':'password';show.textContent=visible?'隐藏':'显示';show.setAttribute('aria-pressed',String(visible));show.setAttribute('aria-label',visible?'隐藏协议端密码':'显示协议端密码');});
    status.setAttribute('role','status');error.setAttribute('role','alert');error.hidden=true;head.append(heading,close);wrap.append(password,show);label.append(caption,wrap);body.append(service,label,hint,status,error);current.append(head,body);
    let metadata=null,version=0,savedVersion=0,clearing=false,clearButton;const discard=node('button','protocol-password-discard','取消重试并关闭');discard.type='button';discard.hidden=true;body.append(discard);
    const alive=()=>!disposed&&dialog===current&&current.isConnected;
    const fail=reason=>{if(!alive())return;error.textContent=reason?.message||'密码未能保存，请重试';error.hidden=false;status.textContent='未保存';status.dataset.state='error';discard.hidden=false;};
    queue=createAutoSave({root:current,delay:600,dirty:()=>version>savedVersion,savedMessage:'协议端密码已保存',onError:fail,save:async()=>{
      if(!metadata||!alive())return false;const ticket=version,value=password.value;
      if(!value){savedVersion=ticket;status.textContent=metadata.configured?'保留已保存的密码':'尚未保存密码';return;}
      error.hidden=true;discard.disabled=true;status.textContent='保存中…';status.dataset.state='saving';clearButton.disabled=true;current.setAttribute('aria-busy','true');
      try{const result=await request('POST','/api/local-protocols/password',{id:metadata.id,contextToken:metadata.contextToken,expectedRevision:metadata.revision,password:value});
        if(!alive())return;metadata=result;savedVersion=ticket;discard.hidden=true;clearButton.hidden=!result.configured;password.placeholder='已保存；留空可保留';status.textContent='已加密保存';status.dataset.state='saved';
      }finally{if(alive()){current.removeAttribute('aria-busy');clearButton.disabled=false;discard.disabled=false;}}
    }});
    clearButton=destructiveButton('清除已保存密码',async()=>{
      if(!metadata||clearing)return;await queue.flush();clearing=true;error.hidden=true;password.disabled=show.disabled=true;
      try{const result=await request('POST','/api/local-protocols/password',{id:metadata.id,contextToken:metadata.contextToken,expectedRevision:metadata.revision,clear:true});if(!alive())return;metadata=result;password.value='';password.type='password';show.textContent='显示';show.setAttribute('aria-pressed','false');show.setAttribute('aria-label','显示协议端密码');version=savedVersion=0;clearButton.hidden=true;status.textContent='已清除，后续接入时手动验证';status.dataset.state='saved';saveFeedback('saved','已清除保存的协议端密码');}
      catch(reason){fail(reason);}finally{clearing=false;if(alive())password.disabled=show.disabled=false;}
    },{clicks:2,target:()=>label,impact:'清除 QQA 保存的自动验证密码，协议端原来的管理密码仍保留。'});
    clearButton.hidden=true;clearButton.classList.add('protocol-password-clear');body.append(clearButton);
    password.addEventListener('input',()=>{version++;error.hidden=true;queue.schedule();});
    password.addEventListener('keydown',event=>{if(event.key==='Enter'){event.preventDefault();void queue.flush().catch(fail);}});
    life=installDisposableDialog(current,{dismissOnBackdrop:true,canClose:()=>!clearing,beforeClose:()=>queue.flush().catch(reason=>{fail(reason);throw reason;}),onClosed:()=>{password.value='';queue.dispose();dialog=life=queue=input=null;}});
    discard.addEventListener('click',()=>{if(!clearing&&!discard.disabled){password.value='';queue.dispose();life.dispose();}});
    doc.body.append(current);current.showModal();
    try{const result=await request('GET','/api/local-protocols/password',undefined,{id:instance.id});if(!alive())return;metadata=result;
      service.textContent=[result.provider==='snowluma'?'SnowLuma':'NapCat',result.origin].join(' · ');password.disabled=show.disabled=result.supported!==true;
      password.placeholder=result.configured?'已保存；输入新密码替换':'输入当前管理密码';clearButton.hidden=!result.configured;
      status.textContent=result.supported!==true?'当前系统无法安全保存密码，请在接入时手动验证':result.configured?'已保存；留空保留已有密码':'尚未保存密码';status.dataset.state=result.configured?'saved':'';password.focus();
    }catch(reason){fail(reason);}
  }
  return{open,get isOpen(){return !!dialog?.open;},dispose(){disposed=true;if(input)input.value='';queue?.dispose();life?.dispose();dialog=life=queue=input=null;}};
}
