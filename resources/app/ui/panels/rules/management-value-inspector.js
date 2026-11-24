import {allValuePorts,inputRequirement,VALUE_TYPE_LABELS,VALUE_COLORS} from './management-values.js';
import {inputSource} from './management-sources.js';
import {createIcon} from '../icons.js';

export function renderValueInspector({doc,parent,rule,node,catalog,controls,record,onChange,onVisibility,onError}){
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;},spec=catalog.find(s=>s.type===node.type),sections=[];
  const button=(text,action,cls='')=>{const b=el('button',cls,text);b.type='button';b.addEventListener('click',action);return b;};
  const filter=el('input','management-value-filter');filter.type='search';filter.placeholder='查找参数、结果或用途';filter.setAttribute('aria-label','查找节点字段');
  let searching=false;
  filter.addEventListener('input',()=>{const query=filter.value.trim().toLowerCase();for(const box of sections){if(query&&!searching)box.dataset.wasOpen=String(box.open);let matches=0;box.querySelectorAll('.management-value-field').forEach(row=>{const matched=!query||row.dataset.search.toLowerCase().includes(query);row.hidden=!matched;if(matched)matches++;const info=row.querySelector('.management-value-explanation');if(query&&matched){if(info.dataset.wasOpen===undefined)info.dataset.wasOpen=String(info.open);info.open=true;}else if(!query&&info.dataset.wasOpen!==undefined){info.open=info.dataset.wasOpen==='true';delete info.dataset.wasOpen;}});if(query){box.open=matches>0;box.hidden=!matches;}else{box.hidden=false;if(box.dataset.wasOpen!==undefined)box.open=box.dataset.wasOpen==='true';delete box.dataset.wasOpen;}}searching=!!query;});parent.append(filter);
  function section(label,open=true,container=parent){const box=el('details','management-value-section');box.open=open;box.append(el('summary','',label));container.append(box);sections.push(box);return box;}
  function header(port,direction){
    const head=el('div','management-value-field-head');head.style.setProperty('--value-color',VALUE_COLORS[port.type]);head.append(el('strong','',port.label),el('small','management-value-type',VALUE_TYPE_LABELS[port.type]));
    if(direction==='inputs'){const state=inputRequirement(node,port),badge=el('small','management-parameter-requirement',state.requirement==='conditional'?'按模板':state.requirement==='required'?'必填':'可选');badge.dataset.requirement=state.requirement;badge.dataset.missing=String(state.missing);badge.title=state.missing?'尚未提供：填写内容或连接一个来源':state.hint;head.append(badge);}
    const connected=direction==='inputs'?!!node.bindings?.[port.key]:rule.nodes.some(n=>Object.values(n.bindings??{}).some(b=>b.nodeId===node.id&&b.port===port.key)),check=el('input'),pin=el('label','management-port-pin');
    check.type='checkbox';check.checked=connected||rule.layout?.visiblePorts?.[node.id]?.[direction]?.includes(port.key)===true;check.disabled=connected;check.setAttribute('aria-label',`固定显示${direction==='inputs'?'输入':'输出'} ${port.label}`);pin.title=connected?'已有连线，接口始终显示':'固定在画布显示；未固定时由精简模式决定';pin.dataset.pinned=String(check.checked);check.addEventListener('change',()=>onVisibility(direction,port.key,check.checked));pin.append(check,createIcon('panel',{size:14}));head.append(pin);return head;
  }
  function field(port,direction,box){
    const row=el('div','management-value-field');row.dataset[direction==='inputs'?'inputKey':'outputKey']=port.key;row.dataset.search=[port.label,port.key,port.description,port.example,VALUE_TYPE_LABELS[port.type]].filter(Boolean).join(' ');row.title=port.description??'';
    if(direction==='inputs'){const state=inputRequirement(node,port);row.dataset.requirement=state.requirement;row.dataset.missing=String(state.missing);}row.append(header(port,direction));box.append(row);return row;
  }
  function explanation(port,row,source){const info=el('details','management-value-explanation'),summary=el('summary','','说明');summary.setAttribute('aria-label','说明 '+port.label);info.append(summary);if(port.description)info.append(el('p','management-value-description',port.description));if(source?.detail)info.append(el('p','management-input-help',source.detail));if(port.example)info.append(el('small','management-value-example','例如：'+port.example));info.append(el('code','management-value-key','字段名：'+port.key+(port.optional?' · 可能缺失':'')));row.append(info);return info;}
  function manual(port,row){
    const existing=controls.get(port.configKey);if(existing&&!Object.hasOwn(node.values??{},port.key)){const label=existing.querySelector('span');if(label)label.hidden=true;existing.querySelector('input,textarea,select')?.setAttribute('aria-label',port.label);row.append(existing);return;}
    existing?.remove();const value=Object.hasOwn(node.values??{},port.key)?node.values[port.key]:port.configKey?(node.config?.[port.configKey]??port.default):port.default;let control;
    if(port.options||port.type==='boolean'){
      control=el('select');const options=port.options??[[true,'是'],[false,'否']];for(const [v,title]of [['','使用默认值'],...options]){const option=el('option','',title);option.value=String(v);control.append(option);}control.value=value===undefined?'':String(value);
    }else{
      control=el(['object','list','message','sequence'].includes(port.type)?'textarea':'input');if(control.tagName==='INPUT'){control.type=['number','timestamp'].includes(port.type)?'number':'text';if(control.type==='number'){control.step=port.integer?'1':'any';if(port.min!==undefined)control.min=String(port.min);if(port.max!==undefined)control.max=String(port.max);}else if(port.maxLength!==undefined)control.maxLength=port.maxLength;}control.value=value===undefined?'':typeof value==='object'?JSON.stringify(value):String(value);
      if(port.type==='stream'){control.disabled=true;control.placeholder='在画布连接事件流';}else control.placeholder=port.targetUser?'输入单个 QQ；留空按成员名单':port.inherit?'留空恢复自动来源':'输入固定值';
    }
    control.setAttribute('aria-label','参数 '+port.label);control.addEventListener('change',()=>{
      try{let next=control.value;if(next==='')next=undefined;else if(port.options)next=port.options.find(([key])=>String(key)===next)?.[0];else if(['number','timestamp'].includes(port.type))next=Number(next);else if(port.type==='boolean')next=next==='true';else if(['user_ids','group_ids'].includes(port.type))next=next.split(/[\s,，]+/).filter(Boolean);else if(port.type==='any'){try{next=JSON.parse(next);}catch{}}else if(['object','list','message','sequence'].includes(port.type))next=JSON.parse(next);onChange(port,next,'value');}catch(error){onError(error);}
    });row.append(control);
  }
  const inputs=allValuePorts(node,catalog,'inputs');if(inputs.length){const box=section(`参数 · ${inputs.length}`),extra=inputs.filter(p=>p.visible===false&&!inputRequirement(node,p).missing&&!node.bindings?.[p.key]&&!Object.hasOwn(node.values??{},p.key)),extraBox=extra.length?section(`更多参数 · ${extra.length}`,false):null;for(const port of inputs){
    const row=field(port,'inputs',extra.includes(port)?extraBox:box),source=inputSource(rule,node,catalog,port),binding=node.bindings?.[port.key];row.dataset.search+=' '+source.text;
    let line;
    if(binding||source.kind==='auto'){
      line=el('div',binding?'management-value-binding':'management-value-origin');line.dataset.source=source.kind;line.title=source.detail;line.append(el('small','management-source-kind',binding?'连线':'自动'),el('span','management-source-text',source.text));row.append(line);
    }
    if(binding){
      const disconnect=button('×',()=>onChange(port,null,'binding'),'management-value-disconnect');disconnect.title='断开此参数的连线';disconnect.setAttribute('aria-label','断开连线 '+port.label);line.append(disconnect);controls.get(port.configKey)?.remove();
      const preview=record?.values?.[binding.nodeId]?.[binding.port];if(preview!==undefined)row.append(el('output','management-value-preview','上次试运行：'+preview));
    }else if(port.type==='stream'){
      row.append(el('small','management-input-connect','从画布连接事件流'));
    }else if(source.kind==='auto'||source.kind==='optional'){
      const editor=el('div','management-manual-editor');editor.hidden=true;let created=false;
      const edit=button('填写',()=>{const opening=editor.hidden;if(opening&&!created){manual(port,editor);created=true;}editor.hidden=!opening;edit.textContent=opening?'取消':'填写';edit.setAttribute('aria-expanded',String(opening));if(opening)editor.querySelector('input,textarea,select')?.focus();},'management-source-edit');edit.setAttribute('aria-label','改用固定值');edit.title='为'+port.label+'填写固定值';edit.setAttribute('aria-expanded','false');(line??row).append(edit);row.append(editor);
    }else{
      const fixed=el('div','management-fixed-value');if(Object.hasOwn(node.values??{},port.key))row.append(el('small','management-source-kind','固定值'));manual(port,fixed);row.append(fixed);
      if(Object.hasOwn(node.values??{},port.key)){const label=port.inherit?'恢复自动来源':'恢复默认值',reset=button('↶',()=>onChange(port,undefined,'value'),'management-source-reset');reset.setAttribute('aria-label',label);reset.title=label;fixed.append(reset);}
    }
    explanation(port,row,source);
  }}
  const outputs=allValuePorts(node,catalog,'outputs');if(outputs.length){const usedPorts=outputs.filter(port=>rule.nodes.some(n=>Object.values(n.bindings??{}).some(b=>b.nodeId===node.id&&b.port===port.key))),box=section(`结果 · ${outputs.length}`,!inputs.length||!!spec.pure),extra=outputs.filter(p=>p.visible===false&&!usedPorts.includes(p)),extraBox=extra.length?section(`其他结果 · ${extra.length}`,false):null;for(const port of outputs){
    const row=field(port,'outputs',extra.includes(port)?extraBox:box),info=explanation(port,row);if(port.iterationOnly)info.append(el('small','management-input-help','只在这个循环的“每项”路径中使用；循环结束后使用处理项数等汇总结果。'));if(port.optional)info.append(el('small','management-input-help','事件可能没有提供此项；可接“缺省值”设置备用内容。'));
    const preview=record?.values?.[node.id]?.[port.key];if(preview!==undefined)row.append(el('output','management-value-preview',preview));
  }}
  if(spec.pure){const calculation=el('details','management-value-explanation management-calculation-help');calculation.append(el('summary','','计算方式'),el('p','muted','连接到其他节点的参数后才计算，不会自行发送消息或处理成员。'));parent.append(calculation);}
}
