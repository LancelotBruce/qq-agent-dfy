// Presets are server-owned metadata. This form only collects the selected
// provider and never reads credentials or automatically calls a model service.
import {providerEndpointIdentity} from './model-catalog-data.js';
export function mountProviderPresets({host,name,base,key,request}){
  const doc=host.ownerDocument,el=(tag,cls,value)=>{const n=doc.createElement(tag);if(cls)n.className=cls;if(value!==undefined)n.textContent=value;return n;};
  const root=el('div','provider-preset-form'),tabs=el('div','provider-preset-tabs'),presetPanel=el('div','provider-preset-picker'),choice=el('select'),extra=el('div','provider-preset-extra'),note=el('p','provider-preset-note'),keyHint=el('small','provider-preset-key-hint'),advanced=el('details','provider-preset-advanced'),status=el('p','provider-preset-status'),retry=el('button','','重试读取预设');
  const nameWrap=name.closest('label'),baseWrap=base.closest('label'),keyWrap=key.closest('label');
  let mode='custom',presets=[],selected='',disposed=false,flight=null,ticket=0,custom={name:name.value,base:base.value},presetAdvanced=false;
  const drafts=new Map(),inputs=new Map();root.dataset.mode=mode;tabs.setAttribute('role','group');tabs.setAttribute('aria-label','渠道接入方式');
  const presetTab=tab('提供商预设','preset'),customTab=tab('自定义 API','custom');
  function tab(label,value){const b=el('button','',label);b.type='button';b.setAttribute('aria-pressed',String(mode===value));b.addEventListener('click',()=>switchMode(value));tabs.append(b);return b;}
  choice.setAttribute('aria-label','模型提供商');
  status.setAttribute('role','status');note.setAttribute('role','status');retry.type='button';retry.hidden=true;retry.addEventListener('click',()=>void load());
  const chooseLabel=el('label','provider-preset-choice');chooseLabel.append(el('span','','提供商'),choice);presetPanel.append(chooseLabel,status,retry,extra,note);
  advanced.append(el('summary','','地址与名称'),nameWrap,baseWrap);keyWrap.classList.add('provider-preset-key');keyWrap.append(keyHint);key.autocomplete='new-password';key.setAttribute('aria-label','API Key');key.dataset.managerKey='';
  root.append(tabs,presetPanel,keyWrap,advanced);host.replaceChildren(root);
  function current(){return presets.find(p=>p.id===selected);}
  function remember(){if(mode==='custom')custom={name:name.value,base:base.value};else if(selected)drafts.set(selected,{name:name.value,base:base.value,fields:Object.fromEntries([...inputs].map(([id,input])=>[id,input.value])),advanced:advanced.open});}
  function clearSecret(){key.type='password';key.value='';}
  function switchMode(next){if(disposed||mode===next)return;remember();clearSecret();mode=next;root.dataset.mode=mode;presetTab.setAttribute('aria-pressed',String(mode==='preset'));customTab.setAttribute('aria-pressed',String(mode==='custom'));presetPanel.hidden=mode!=='preset';
    if(mode==='custom'){name.value=custom.name;base.value=custom.base;base.placeholder='https://example.com/v1';advanced.open=true;key.placeholder='输入 API Key';keyHint.textContent='';}
    else{void load();applyPreset();} }
  function template(p,values){return String(p?.baseUrl||'').replace(/\{([A-Za-z][A-Za-z0-9_-]*)\}/g,(_all,id)=>values[id]?.trim()?encodeURIComponent(values[id].trim()):'{'+id+'}');}
  function updateHint(){const p=current();if(mode!=='preset'||!p){keyHint.textContent='';return;}const env=p.apiKeyEnv;
    const values=Object.fromEntries([...inputs].map(([id,input])=>[id,input.value.trim()])),expected=template(p,values);
    const matching=p.status!=='gateway'&&!(p.fields||[]).some(field=>field.required&&!values[field.key])&&!expected.includes('{')&&!!providerEndpointIdentity(expected)&&providerEndpointIdentity(base.value)===providerEndpointIdentity(expected);
    key.placeholder=p.configured&&matching?'留空使用服务器中已配置的密钥':'输入 API Key';
    keyHint.textContent=p.configured&&matching?`已检测到 ${env||'提供商环境变量'}，留空即可使用。`:env&&matching?`也可在启动 QQA 前设置 ${env}。`:'密钥可稍后填写。';
  }
  function applyPreset(){const p=current(),draft=drafts.get(selected);inputs.clear();extra.replaceChildren();note.textContent=p?.note||'';note.dataset.gateway=String(p?.status==='gateway');
    name.value=draft?.name??p?.name??'';base.value=draft?.base??(p?.status==='gateway'?'':p?.baseUrl||'');
    for(const field of p?.fields||[]){const row=el('label','setting-field'),input=el('input');row.append(el('span','',field.label+(field.required?' *':'')),input);input.type='text';input.placeholder=field.placeholder||'';input.value=draft?.fields?.[field.key]||'';input.dataset.previous=input.value;input.required=field.required===true;input.setAttribute('aria-label',field.label);inputs.set(field.key,input);extra.append(row);input.addEventListener('input',()=>{const old=template(p,Object.fromEntries([...inputs].map(([id,n])=>[id,n.dataset.previous??n.value])));if(!base.value||base.value===old||base.value===p.baseUrl||base.value.includes('{'))base.value=template(p,Object.fromEntries([...inputs].map(([id,n])=>[id,n.value])));input.dataset.previous=input.value;clearSecret();updateHint();});}
    if(p?.status==='gateway'){note.textContent=p.note||'此提供商的原生接口暂不能直连，请填写兼容 OpenAI 的网关地址。';advanced.open=true;base.placeholder='兼容 OpenAI 的网关地址';}
    else{advanced.open=draft?.advanced??presetAdvanced;base.placeholder=p?.baseUrl||'https://example.com/v1';}
    updateHint();
  }
  function renderChoices(){choice.replaceChildren();const empty=el('option','',presets.length?'选择提供商':'暂无提供商预设');empty.value='';choice.append(empty);
    for(const [kind,label]of [['ready','直接接入'],['gateway','需兼容网关']]){const group=el('optgroup');group.label=label;for(const p of presets.filter(p=>(p.status==='gateway'?'gateway':'ready')===kind)){const item=el('option','',p.name);item.value=p.id;group.append(item);}if(group.childElementCount)choice.append(group);}
    choice.value=selected;choice.disabled=!presets.length;status.textContent='';
  }
  async function load(){if(disposed||presets.length)return;if(flight)return flight;const version=++ticket;status.textContent='正在读取提供商预设…';retry.hidden=true;
    flight=(async()=>{try{const result=await request('GET','/api/providers/presets');if(disposed||version!==ticket||!root.isConnected)return;presets=(result.presets||[]).filter(p=>p&&typeof p.id==='string'&&typeof p.name==='string');renderChoices();if(mode==='preset'&&selected)applyPreset();}
      catch(error){if(!disposed&&version===ticket){status.textContent='预设读取失败，可重试或使用自定义 API。';retry.hidden=false;}}
      finally{if(version===ticket)flight=null;}})();return flight;
  }
  choice.addEventListener('change',()=>{remember();clearSecret();selected=choice.value;applyPreset();});base.addEventListener('input',updateHint);advanced.addEventListener('toggle',()=>{if(mode==='preset'&&current()?.status!=='gateway')presetAdvanced=advanced.open;});
  presetPanel.hidden=true;advanced.open=true;
  return{root,clearSecret,payload(){if(disposed)throw Error('添加渠道窗口已关闭');const value={displayName:name.value.trim(),baseUrl:base.value.trim(),apiKey:key.value.trim()};if(mode==='custom')return value;const p=current();if(!p)throw Error('请选择模型提供商');const values=Object.fromEntries([...inputs].map(([id,input])=>[id,input.value.trim()]));for(const field of p.fields||[])if(field.required&&!values[field.key])throw Error('请填写'+field.label);if(p.status==='gateway'&&!value.baseUrl)throw Error('请填写兼容 OpenAI 的网关地址');if(!value.baseUrl||value.baseUrl.includes('{'))throw Error('请填写完整的接口地址');return{...value,presetId:p.id,presetFields:values};},dispose(){disposed=true;++ticket;clearSecret();drafts.clear();inputs.clear();}};
}
