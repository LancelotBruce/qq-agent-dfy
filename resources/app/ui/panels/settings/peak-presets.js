import {button,text} from '../ui.js';
import {createIcon} from '../icons.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {TransactionDraft,withinDraftBudget,packFields,restoreFields} from './transaction-draft.js';
import {createAutoSave,flushAutoSaves} from './auto-save.js';
export const PEAK_PRESETS=Object.freeze({workbuddy:{label:'workbuddy（08:00~23:00）',start:'08:00',end:'23:00',peak:10,valley:100},deepseek:{label:'deepseek（09:00~18:00）',start:'09:00',end:'18:00',peak:10,valley:100}});
const FIELDS=['enabled','start','end','peak','valley'],CUSTOM=FIELDS.slice(1);
const node=(tag,value)=>{const result=document.createElement(tag);if(value!==undefined)text(result,value);return result;};
const rawView=view=>({...view,values:Object.fromEntries(Object.entries(view.values).map(([key,value])=>[key,key==='enabled'?value:value==null?'':String(value)]))});
function convert(value,field){if(field==='enabled')return value;if(field==='start'||field==='end')return value.trim();if(!value.trim())return null;const number=Number(value);if(!Number.isFinite(number)||number<0||number>100)throw Error('峰谷点需为 0~100，分群留空跟随全局');return number;}
export function createPeakPresetEditor({request,beforeOpen=async()=>{},getTarget=()=> 'global',onSaved=()=>{}}){
  let dialog=null,current='global',ticket=0,saving=false,disposed=false,drawCurrent=()=>{},notice=()=>{},uncachedPrevious=false;
  const targets=new Map();
  function packed(){return{version:1,current,targets:[...targets].filter(([,state])=>state.draft.pending.size).map(([target,state])=>({target,...packFields(state.draft,FIELDS),customValues:CUSTOM.map(key=>state.custom.values[key]),customRevisions:CUSTOM.map(key=>state.custom.revisions[key])}))};}
  const cacheable=value=>value.targets.length<=2&&withinDraftBudget(value,2200);
  function snapshot(){const value=packed();return cacheable(value)?value:{version:1,current,overflow:true};}
  function restore(value){try{if(value?.version!==1)return;if(value.overflow===true){current=value.current||'global';uncachedPrevious=true;return;}if(!Array.isArray(value.targets)||!cacheable(value))return;current=value.current||'global';for(const item of value.targets){const draft=restoreFields(item,FIELDS),custom={values:Object.fromEntries(CUSTOM.map((key,index)=>[key,item.customValues[index]])),revisions:Object.fromEntries(CUSTOM.map((key,index)=>[key,item.customRevisions[index]]))};targets.set(item.target,{draft,custom,global:{peak:10,valley:100},groups:[]});}}catch{/* Untrusted or obsolete RAM state is ignored. */}}
  async function open(target){
    if(disposed||dialog)return;await beforeOpen();if(disposed||dialog)return;current=target||getTarget()||'global';
    const root=node('dialog'),body=node('article'),feedback=node('p'),host=node('div'),comparison=node('div');root.className='settings-spec-dialog settings-peak-presets';root.append(body);feedback.setAttribute('role','status');body.append(node('h3','峰谷时段与预设'),feedback,host,comparison);
    dialog=root;notice=message=>{if(dialog===root)text(feedback,message+(!cacheable(packed())?' 当前草稿超出跨页缓存容量，输入仍保留在当前页面；请先保存再离开。':uncachedPrevious?' 上次草稿超出跨页缓存容量，未跨页保留；旧缓存已失效，请核对服务器已保存的内容。':''));};
    host.className='peak-fields';
    const autoSave=createAutoSave({root,save:()=>commit('active'),dirty:()=>!!targets.get(current)?.draft.pending.size});
    installDisposableDialog(root,{beforeClose:()=>flushAutoSaves(root),onClosed:()=>{autoSave.dispose();if(dialog===root){dialog=null;drawCurrent=()=>{};notice=()=>{};++ticket;}}});document.body.append(root);root.showModal();
    function update(state,field,value){state.draft.set(field,value);autoSave.schedule();}
    function draw(){
      const state=targets.get(current);if(!state||dialog!==root)return;host.replaceChildren();
      for(const[field,label]of [['start','高峰开始'],['end','高峰结束']]){
        const wrap=node('label'),input=node('input');input.dataset.peakField=field;input.type='time';input.value=state.draft.value(field)||'';input.addEventListener('input',()=>update(state,field,input.value));wrap.append(node('span',label),input);host.append(wrap);
      }
      const picker=node('select'),label=node('label','选择峰谷预设'),blank=node('option','— 选择预设 —');label.className='peak-preset-picker';blank.value='';picker.append(blank);for(const[key,preset]of Object.entries(PEAK_PRESETS)){const option=node('option',preset.label);option.value=key;picker.append(option);}if(state.custom.values.start){const option=node('option',`自定义（${state.custom.values.start}~${state.custom.values.end} · ${state.custom.values.peak}/${state.custom.values.valley}）`);option.value='custom';picker.append(option);}label.append(picker);host.append(label);
      picker.addEventListener('change',()=>{const preset=picker.value==='custom'?state.custom.values:PEAK_PRESETS[picker.value];if(!preset)return;for(const field of CUSTOM)state.draft.set(field,String(preset[field]));draw();autoSave.schedule();});
    }
    drawCurrent=draw;
    async function read(){const generation=++ticket,target=current;host.replaceChildren();notice('正在读取峰谷配置…');try{const view=await request('GET','/api/peak-schedule',undefined,{target});if(dialog!==root||ticket!==generation||target!==current)return;const old=targets.get(target);targets.set(target,old?.draft.pending.size?{...old,global:view.global,groups:view.groups}:{draft:new TransactionDraft(rawView(view.active)),custom:rawView(view.custom),global:view.global,groups:view.groups});draw();notice(old?.draft.pending.size?'已恢复未保存草稿，读取没有覆盖输入。':'配置已读取；修改后需保存。');}catch(error){if(dialog!==root||ticket!==generation)return;notice(`读取失败：${error.message}；已有草稿保留。`);draw();}}
    async function commit(kind){
      const target=current,state=targets.get(target);if(!state||saving)return;let sent;
      try{
        if(kind==='custom'){const values=Object.fromEntries(CUSTOM.map(field=>[field,convert(state.draft.value(field),field)??state.global[field]]));sent={patch:values,expected:{...state.custom.revisions}};}
        else{sent=state.draft.snapshot(convert);if(!sent.fields.size)return;}
        saving=true;notice(kind==='custom'?'正在保存自定义预设…':'正在保存峰谷设置…');const receipt=await request('PUT','/api/peak-schedule',{target,kind,patch:sent.patch,expected:sent.expected});
        if(kind==='custom'){for(const value of targets.values())for(const field of CUSTOM){value.custom.values[field]=String(receipt.custom.values[field]);value.custom.revisions[field]=receipt.custom.revisions[field];}}
        else state.draft.accept(sent,rawView(receipt.active));
        uncachedPrevious=false;onSaved(receipt);if(dialog===root&&current===target){comparison.replaceChildren();if(kind==='custom')draw();feedback.hidden=true;}
      }catch(error){feedback.hidden=false;notice(error.message);if((error.status??error.data?.httpStatus)===409)await compare(kind);return false;}finally{saving=false;}
    }
    async function compare(kind){const target=current,state=targets.get(target);if(!state)return;try{const latest=await request('GET','/api/peak-schedule',undefined,{target});if(dialog!==root||current!==target)return;comparison.replaceChildren();const view=rawView(latest.active);if(kind==='active')for(const[field]of state.draft.pending)if(state.draft.base.revisions[field]!==view.revisions[field]){const box=node('fieldset');box.dataset.peakConflict=field;box.append(node('legend',({start:'高峰开始',end:'高峰结束',peak:'高峰回复',valley:'低谷回复'})[field]||field),node('p',`打开时：${state.draft.base.values[field]}；服务器：${view.values[field]}；草稿：${state.draft.value(field)}`),button('保留我的值并采用新版本',()=>{state.draft.resolve(field,view,true);box.remove();autoSave.schedule();}),button('采用服务器值',()=>{state.draft.resolve(field,view,false);box.remove();draw();autoSave.schedule();}));comparison.append(box);}if(kind==='custom'&&CUSTOM.some(field=>state.custom.revisions[field]!==latest.custom.revisions[field])){const box=node('fieldset');box.dataset.peakConflict='custom';box.append(node('legend','自定义预设已更新'),node('p',`服务器：${JSON.stringify(latest.custom.values)}；当前表单将作为新的自定义预设`),button('确认使用新版本保存自定义',()=>{state.custom=rawView(latest.custom);box.remove();notice('已确认新的自定义版本，可再次添加预设。');}));comparison.append(box);}if(!comparison.childElementCount)notice('提交字段版本一致；未自动修改保存基线，可重试。');}catch(error){notice(`对比失败：${error.message}；草稿保留。`);}}
    const actions=node('div'),addPreset=button('预设',async()=>{await autoSave.flush();await commit('custom');});addPreset.prepend(createIcon('plus',{size:16}));addPreset.setAttribute('aria-label','添加预设');actions.className='actions';actions.append(addPreset,button('完成',()=>root.close()));body.append(actions);feedback.hidden=true;await read();return root;
  }
  return{open,snapshot,restore,dispose(){disposed=true;++ticket;dialog?.close();},get dirty(){return[...targets.values()].some(state=>state.draft.pending.size);}};
}
