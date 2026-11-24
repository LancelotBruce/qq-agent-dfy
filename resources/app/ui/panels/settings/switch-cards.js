import {createIcon} from '../icons.js';
// Native checked/disabled state remains the source of truth, including keyboard
// activation. Color, the check mark and pressed surface convey state visually.
export function mountSwitchCards(doc=document){
  const INPUT='input[type=checkbox]',BUTTON='button[role=switch]',SUMMARY='details>summary',CONTROLS=INPUT+','+BUTTON+','+SUMMARY;
  let disposed=false;
  const indicator=element=>{if(element.querySelector(':scope>.settings-toggle-indicator'))return;const mark=doc.createElement('span');mark.className='settings-toggle-indicator';mark.setAttribute('aria-hidden','true');mark.append(createIcon('check',{size:14}),createIcon('warning',{size:14}));element.append(mark);};
  function enhance(control){
    if(control.matches(INPUT)){
      const input=control,label=input.closest('label');if(!label)return;
      if(!label.classList.contains('settings-toggle-card'))label.classList.add('settings-toggle-card');
      const title=input.getAttribute('aria-label')||label.querySelector('.field-title')?.textContent;
      if(title&&!input.hasAttribute('aria-label'))input.setAttribute('aria-label',title);
      const checked=String(input.checked),disabled=String(input.disabled);
      if(label.dataset.checked!==checked)label.dataset.checked=checked;
      if(label.dataset.disabled!==disabled)label.dataset.disabled=disabled;
      indicator(label);
      for(const pill of label.querySelectorAll('.switch-pill,.activity-switch-track'))if(!pill.hidden)pill.hidden=true;
    }else if(control.matches(BUTTON)){
      if(!control.hasAttribute('aria-label'))control.setAttribute('aria-label',control.textContent.trim());
      for(const name of ['settings-toggle-card','settings-toggle-button'])if(!control.classList.contains(name))control.classList.add(name);
      indicator(control);
    }else if(control.matches(SUMMARY)&&!control.querySelector(':scope>.settings-fold-chevron')){
      const mark=doc.createElement('span');mark.className='settings-fold-chevron';mark.setAttribute('aria-hidden','true');mark.append(createIcon('chevron',{size:14}));control.append(mark);
    }
  }
  function scan(root){
    if(disposed||root.nodeType!==1&&root!==doc)return;
    if(root.matches?.(CONTROLS))enhance(root);
    if(root===doc||root.childElementCount)for(const control of root.querySelectorAll(CONTROLS))enhance(control);
  }
  // Streaming text, save notices and unrelated lists must not rescan/rewrite
  // every switch in the page. Enhance only newly inserted control subtrees.
  const observer=new MutationObserver(records=>{
    for(const record of records){
      if(record.type==='attributes'){if(record.target.matches(CONTROLS))enhance(record.target);}
      else for(const node of record.addedNodes)scan(node);
    }
  });observer.observe(doc.body,{childList:true,subtree:true,attributes:true,attributeFilter:['aria-checked','checked','disabled']});
  const update=event=>{if(event.target.matches?.(CONTROLS))enhance(event.target);};
  const reset=event=>queueMicrotask(()=>scan(event.target));
  doc.addEventListener('change',update);doc.addEventListener('reset',reset);scan(doc);
  return()=>{disposed=true;observer.disconnect();doc.removeEventListener('change',update);doc.removeEventListener('reset',reset);};
}
