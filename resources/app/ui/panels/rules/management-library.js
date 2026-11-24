import {createIcon} from '../icons.js';
import {VALUE_TYPE_LABELS} from './management-values.js';
import {displayValue} from './management-sources.js';
export function createNodeLibrary({doc,candidates,context,onChoose,onError}){
  const el=(tag,cls,text)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;};
  const button=(label,fn,cls='')=>{const b=el('button',cls,label);b.type='button';b.addEventListener('click',fn);return b;};
  const root=el('div','management-catalog-browser'),search=el('input','management-catalog-search'),layout=el('div','management-library-layout'),nav=el('nav','management-catalog-nav'),list=el('div','management-node-catalog'),detail=el('section','management-library-detail'),footer=el('div','management-library-footer'),add=button('添加到画布',()=>choose(),'primary');
  search.type='search';search.placeholder='搜索节点，例如：字符串、数字、替换';search.setAttribute('aria-label','搜索节点');nav.setAttribute('aria-label','节点分类');list.setAttribute('aria-label','节点列表');detail.setAttribute('aria-label','节点详情');root.append(el('p','management-catalog-context',context),search,layout,footer);layout.append(nav,list,detail);footer.append(add);
  let category=candidates.some(s=>s.featured)?'常用':'全部',selected=null,visible=[];
  const groups=[...new Set(candidates.map(s=>s.category??s.group))],priority=['触发事件','消息数据','读取数据','基础值','文字处理','数值运算','基础运算','数据运算','列表处理','时间处理','基础控制','基础状态'];
  const categories=['常用','全部',...priority.filter(name=>groups.includes(name)),...groups.filter(name=>!priority.includes(name))];
  const inCategory=(s,c)=>c==='全部'||c==='常用'&&s.featured||(s.category??s.group)===c;
  function choose(){const s=candidates.find(s=>s.type===selected);if(s)Promise.resolve().then(()=>onChoose(s)).catch(onError);}
  function defaultValue(value,options){
    const text=displayValue(value,{options});return text.length>80?text.slice(0,77)+'…':text;
  }
  function defaultSource(port){
    if(port.configKey||port.default!==undefined){if(port.default===undefined||port.default===''&&port.required)return '填写固定值，或连接其他节点的结果';return '默认：'+defaultValue(port.default,port.options);}
    if(port.targetUser)return '自动：沿执行路径传来的待处理成员名单';
    if(port.inherit){const source={group:'启动这轮规则的群号',user:'触发这轮规则的 QQ',targets:'沿执行路径传来的待处理成员名单',event_time:'触发消息的发送时间',current_time:'执行到本节点的电脑时间',message:'触发这轮规则的完整消息',message_id:'触发消息的编号',text:'触发消息的纯文字',event:'触发本轮规则的完整事件',time:'本次事件的发生时间'}[port.inherit];return '自动：'+(source??'本轮流程提供的值');}
    if(port.type==='stream'||port.type==='sequence')return port.required?'连接其他节点提供的列表或事件流':'可不提供列表或事件流';
    return port.optional||!port.required?'留空时不提供这个参数':'填写固定值，或连接其他节点的结果';
  }
  function sourceState(port){if(port.inherit)return ['auto','自动'];if(port.default!==undefined&&(port.default!==''||!port.required))return ['preset','有默认值'];if(port.required)return ['required',port.type==='stream'?'需连线':'必填'];return ['optional','可选'];}
  function shortDescription(s){return s.summary||String(s.description??'').split(/[。；]/u).find(Boolean)||s.label;}
  function preview(){detail.replaceChildren();detail.scrollTop=0;const s=candidates.find(s=>s.type===selected);add.disabled=!s;if(!s){detail.append(el('p','muted','没有匹配节点，试试其他关键词。'));return;}
    detail.append(el('span','management-library-kind',s.category??s.group),el('h4','',s.label));if(s.ownerOnly||s.adminOnly||s.groupOnly)detail.append(el('span','management-owner-badge',s.ownerOnly?'仅机器人为群主时执行':s.adminOnly?'需要机器人有群管理权限':'仅支持群聊'));detail.append(el('p','management-library-description',s.description));
    const ports=el('div','management-library-ports');ports.append(el('span','',s.pure?'按需计算':s.trigger?'开始一轮规则':s.terminal?'结束这条执行路径':s.routeKind||s.branch?'按条件选择后续步骤':'到达后执行'));if(s.pure)ports.append(el('small','muted','连接结果后才会计算'));detail.append(ports);
    const example=el('div','management-library-example');example.append(el('strong','','例如'),el('p','',s.example));detail.append(example);
    const inputKeys=new Set((s.ports?.inputs??[]).map(port=>port.configKey)),extraFields=s.fields.filter(field=>!inputKeys.has(field.key));
    for(const direction of ['inputs','outputs']){
      const fields=s.ports?.[direction]??[],extra=direction==='inputs'?extraFields:[];if(!fields.length&&!extra.length)continue;
      const data=el('details','management-library-fields');data.dataset.direction=direction;data.append(el('summary','',(direction==='inputs'?'本节点使用的参数':'可交给其他节点的结果')+' · '+(fields.length+extra.length)));
      for(const port of fields){
        const row=el('div','management-library-field'),head=el('div','management-library-field-head');head.append(el('strong','',port.label),el('small','management-library-field-type',VALUE_TYPE_LABELS[port.type]));if(direction==='inputs'){const [kind,label]=sourceState(port),state=el('small','management-library-field-state',label);state.dataset.kind=kind;head.append(state);}row.append(head);
        if(direction==='inputs')row.append(el('p','management-library-default',defaultSource(port)));else if(port.optional)row.append(el('small','management-library-optional','本次执行可能没有这个结果'));
        if(port.description)row.append(el('p','management-value-description',port.description));if(port.example)row.append(el('p','management-value-example','例如：'+port.example));
        const technical=el('details','management-library-technical'),key=el('code','management-library-field-key',port.key);technical.append(el('summary','','字段名'),key);row.append(technical);data.append(row);
      }
      if(extra.length){const params=el('div','management-library-params');for(const field of extra){const row=el('div');row.append(el('span','',field.label),el('small','muted',field.default!==undefined&&field.default!==''?'默认：'+defaultValue(field.default,field.options):field.required?'需要填写':'可留空'));params.append(row);}data.append(params);}
      detail.append(data);
    }
  }
  function selectNode(type,focus=false){selected=type;for(const item of list.querySelectorAll('[data-node-type]')){const chosen=item.dataset.nodeType===selected;item.setAttribute('aria-pressed',String(chosen));item.tabIndex=chosen?0:-1;item.querySelector('.management-library-check').textContent=chosen?'✓':'';if(chosen&&focus){item.focus({preventScroll:true});item.scrollIntoView({block:'nearest'});}}preview();}
  function paintList(){const top=list.scrollTop;list.replaceChildren();for(const s of visible){const b=button('',()=>selectNode(s.type,true),'management-node-option');b.dataset.nodeType=s.type;b.setAttribute('aria-label',s.label);b.setAttribute('aria-pressed',String(selected===s.type));b.tabIndex=selected===s.type?0:-1;b.append(createIcon(({开始:'play',判断:'search',分流:'sessions',选择对象:'profile',时间:'clock',计数:'usage',执行:'shield',结束:'check'})[s.group]??'panel',{size:18}),el('strong','',s.label),el('small','',shortDescription(s)));const check=el('span','management-library-check',selected===s.type?'✓':'');check.setAttribute('aria-hidden','true');b.append(check);b.addEventListener('dblclick',choose);list.append(b);}if(!visible.length)list.append(el('p','muted','没有找到节点，试试其他关键词。'));list.scrollTop=top;}
  function paint(){const query=search.value.trim().toLowerCase();visible=candidates.filter(s=>(query||inCategory(s,category))&&`${s.label} ${s.aliases??''} ${s.description} ${s.example} ${s.type} ${[...(s.ports?.inputs??[]),...(s.ports?.outputs??[])].map(port=>port.label).join(' ')}`.toLowerCase().includes(query));if(!visible.some(s=>s.type===selected))selected=visible[0]?.type??null;nav.replaceChildren();for(const name of categories){const count=candidates.filter(s=>inCategory(s,name)).length;if(!count)continue;const b=button('',()=>{category=name;search.value='';list.scrollTop=0;paint();});b.dataset.category=name;b.setAttribute('aria-pressed',String(category===name&&!query));b.append(el('span','',name),el('small','',String(count)));nav.append(b);}paintList();preview();}
  search.addEventListener('input',paint);search.addEventListener('keydown',event=>{if(event.key==='Escape'&&search.value){event.preventDefault();event.stopPropagation();search.value='';paint();}else if(event.key==='ArrowDown'&&selected){event.preventDefault();selectNode(selected,true);}});
  list.addEventListener('keydown',event=>{if(!['ArrowDown','ArrowUp','Home','End'].includes(event.key)||!visible.length)return;event.preventDefault();const current=visible.findIndex(s=>s.type===selected),index=event.key==='Home'?0:event.key==='End'?visible.length-1:Math.max(0,Math.min(visible.length-1,current+(event.key==='ArrowDown'?1:-1)));selectNode(visible[index].type,true);});
  paint();return {root,focus:()=>search.focus()};
}
