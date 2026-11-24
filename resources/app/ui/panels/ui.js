import './theme.js'; // 自执行：应用控制台主题（内置面板共享）
import {installMotion} from './motion.js';
import {installCollapsibles} from './collapsible.js';
import {request} from './panel-client.js';
import {installDisposableDialog} from './dialog-lifecycle.js';
export {destructiveButton,bindDestructiveAction} from './destructive-action.js';
export {destructiveRefresh} from './destructive-layout.js';
installMotion();
installCollapsibles();
export const $=selector=>document.querySelector(selector);
export function text(node,value){const next=String(value??'—');if(node.textContent!==next)node.textContent=next;return node;}
export function clear(node){node.replaceChildren();return node;}
export function error(node,reason){clear(node);const box=document.createElement('div');box.className='error';box.textContent=reason||'当前运行环境未提供该能力';node.append(box);}
export function button(label,handler,kind=''){const b=document.createElement('button');b.type='button';b.textContent=label;if(kind)b.className=kind;b.addEventListener('click',async()=>{b.disabled=true;try{await handler();}catch(e){const box=document.createElement('p');box.className='error';box.textContent=e.message||'操作失败';(b.closest('article,.message,dialog,#detail,section')||b.parentElement)?.append(box);}finally{b.disabled=false;}});return b;}
export function row(title,detail,actions=[]){const el=document.createElement('article');el.className='list-item';const head=document.createElement('div');head.className='row';const left=document.createElement('div'),name=document.createElement('strong'),sub=document.createElement('div');name.textContent=title;sub.className='muted';sub.textContent=detail;left.append(name,sub);head.append(left);if(actions.length){const area=document.createElement('div');area.className='actions';area.append(...actions);head.append(area);}el.append(head);return el;}
// A real title button keeps list details reachable by keyboard without nesting
// the row's destructive/secondary controls inside another interactive element.
export function selectableRow(item,onSelect){
  const title=item.querySelector('strong'),open=document.createElement('button'),arrow=document.createElement('span');
  open.type='button';open.className='list-entry-open';arrow.className='list-entry-arrow';arrow.setAttribute('aria-hidden','true');arrow.textContent='›';
  title.replaceWith(open);open.append(title,arrow);open.addEventListener('click',onSelect);return open;
}
export function format(value){if(value===null||value===undefined||value==='')return '—';return typeof value==='object'?JSON.stringify(value):String(value);}
export function dateTime(value){const n=Number(value)||Date.parse(value);return Number.isFinite(n)&&n?new Date(n).toLocaleString('zh-CN',{hour12:false}):'—';}
export function jsonDetails(title,value){const box=document.createElement('details'),summary=document.createElement('summary'),pre=document.createElement('pre');box.dataset.collapsible='';summary.textContent=title;pre.className='pre';pre.textContent=typeof value==='string'?value:JSON.stringify(value,null,2);box.append(summary,pre);return box;}
export function formDialog(title,fields,save,options={}){
  const dialog=document.createElement('dialog'),heading=document.createElement('h3'),form=document.createElement('form'),feedback=document.createElement('p');heading.textContent=title;feedback.className='error';const inputs={};
  for(const field of fields){const label=document.createElement('label');label.className='setting-field';const name=document.createElement('span');name.textContent=field.label;const input=document.createElement(['textarea','select'].includes(field.type)?field.type:'input');if(!['textarea','select'].includes(field.type))input.type=field.type||'text';if(field.type==='select')for(const option of field.options||[])input.append(new Option(option.label,option.value));input.name=field.key;input.value=field.value??'';input.required=!!field.required;input.readOnly=!!field.readOnly;if(field.pattern)input.pattern=field.pattern;if(field.maxLength)input.maxLength=field.maxLength;inputs[field.key]=input;label.append(name,input);form.append(label);}
  const submit=document.createElement('button');submit.type='button';submit.textContent=options.submitLabel||'保存';submit.hidden=!!options.autoSave;submit.className='primary';const actions=document.createElement('div');actions.className='actions';actions.append(submit,button(options.autoSave?'完成':'取消',()=>dialog.close()));form.append(feedback,actions);const commit=async event=>{event?.preventDefault();if(!form.reportValidity())return false;submit.disabled=true;feedback.textContent='';try{await save(Object.fromEntries(Object.entries(inputs).map(([key,input])=>[key,input.value])));if(!options.autoSave)dialog.close();}catch(e){feedback.textContent=e.message||'保存失败';if(options.autoSave)throw e;}finally{submit.disabled=false;}};const automatic=options.autoSave?.(dialog,commit);form.addEventListener('input',()=>automatic?.schedule());form.addEventListener('change',()=>automatic?.schedule());submit.addEventListener('click',commit);form.addEventListener('submit',commit);dialog.append(heading,form);installDisposableDialog(dialog,automatic?{beforeClose:()=>automatic.flush(),onClosed:()=>automatic.dispose()}:{});document.body.append(dialog);dialog.showModal();return dialog;
}
export async function capability(run,target){try{return await run();}catch(e){error(target,e.message||'当前运行环境未提供该能力');return null;}}
export function confirmAction(message){return new Promise(resolve=>{const dialog=document.createElement('dialog');dialog.className='confirm-panel';dialog.setAttribute('aria-label','确认操作');const textNode=document.createElement('p');textNode.textContent=message;const actions=document.createElement('div');actions.className='actions';const cancel=button('取消',()=>{dialog.close('cancel');});const accept=button('确认',()=>{dialog.close('accept');},'danger');actions.append(cancel,accept);dialog.append(textNode,actions);installDisposableDialog(dialog,{onClosed:()=>resolve(dialog.returnValue==='accept')});document.body.append(dialog);dialog.showModal();});}
