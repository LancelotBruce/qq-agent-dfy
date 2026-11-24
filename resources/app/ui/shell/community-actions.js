import {verifyPublicCaptcha} from './public-captcha.js';

export async function submitCommunityFromHost(api,payload,{signal,review,verify=verifyPublicCaptcha}={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload))throw Error('社区操作参数无效');
  const publish=payload.action==='publishPersona',remove=payload.action==='removeWork';
  const fields=publish?['action','accountUsername','title','description','prompt','category']:remove?['action','accountUsername','kind','id','revision']:[];
  if(!fields.length||Object.keys(payload).some(key=>!fields.includes(key)))throw Error('社区操作参数无效');
  signal?.throwIfAborted();
  if(typeof review!=='function')throw Error('社区确认界面未就绪');
  if(publish){
    if(typeof payload.prompt!=='string'||!payload.prompt.trim()||payload.prompt.length>100000||typeof payload.title!=='string'||!payload.title.trim()||payload.title.length>120||typeof payload.description!=='string'||!payload.description.trim()||payload.description.length>500)throw Error('请检查人设名称、简介和提示词');
    const profile=await api.request('GET','/api/community/profile',undefined,{username:payload.accountUsername},{signal});
    if(!profile.mine)throw Error('发布账号身份未确认');
    const accepted=await review({title:'公开发布人设',text:`发布账号：${profile.account.displayName||profile.account.username}\n名称：${payload.title}\n简介：${payload.description}\n\n以下提示词将公开发布，提交后需审核：\n\n${payload.prompt}`,accept:'验证并提交'},{signal});
    signal?.throwIfAborted();if(!accepted)return{ok:false,canceled:true};
    const captchaVerifyParam=await verify({signal});signal?.throwIfAborted();
    return api.request('POST','/api/community/personas/publish',{...Object.fromEntries(fields.filter(key=>key!=='action').map(key=>[key,payload[key]])),captchaVerifyParam},undefined,{signal,timeout:45000});
  }
  if(remove){
    if(!['skill','plugin'].includes(payload.kind)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.id??''))throw Error('作品类型或标识无效');
    const profile=await api.request('GET','/api/community/profile',undefined,{username:payload.accountUsername},{signal}),item=profile.works?.[payload.kind==='plugin'?'plugins':'skills']?.find(row=>row.id===payload.id);
    if(!profile.mine||item?.authorId!==profile.account.id||item.revision!==payload.revision)throw Error('作品或登录账号已变化，请重新打开');
    const accepted=await review({title:'删除已发布作品',text:`${item.name||item.id}\n发布账号：${profile.account.displayName||profile.account.username}\n\n删除后将无法通过市场下载此作品，本机已安装的副本保留。`,accept:'删除作品'},{signal});
    signal?.throwIfAborted();if(!accepted)return{ok:false,canceled:true};
    return api.request('POST','/api/community/works/remove',{...Object.fromEntries(fields.filter(key=>key!=='action').map(key=>[key,payload[key]])),confirmed:true},undefined,{signal});
  }
}

export function downloadCommunityJson(value,name,doc=document){
  const filename=String(name||'人设').replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,90).replace(/[. ]+$/,'')||'人设';
  const win=doc.defaultView,url=win.URL.createObjectURL(new win.Blob([JSON.stringify(value,null,2)],{type:'application/json'})),link=doc.createElement('a');
  link.href=url;link.download='QQA-'+filename+'.json';link.hidden=true;doc.body.append(link);
  try{link.click();}finally{link.remove();win.setTimeout(()=>win.URL.revokeObjectURL(url),1000);}
}
