import {verifyPublicCaptcha} from './public-captcha.js';

// Only installed IDs are accepted; identity, ownership, versions and paths come
// from the authenticated backend, never from an iframe's claimed author.
export async function publishInstalledFromHost(api,payload,{signal,verify=verifyPublicCaptcha,review,onLoginRequired=()=>{}}={}){
  if(!payload||typeof payload!=='object'||Array.isArray(payload)||Object.keys(payload).some(key=>!['id','kind'].includes(key))||!['skill','plugin'].includes(payload.kind)||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(payload.id||''))throw Error('上传参数无效');
  const request=(method,path,body,query,timeout=20000)=>api.request(method,path,body,query,{signal,timeout});
  const login=()=>{onLoginRequired();return{ok:false,needsLogin:true};};
  signal?.throwIfAborted();
  const saved=await request('GET','/api/market/accounts');if(!saved.accounts?.length)return login();
  const view=await request('GET','/api/extensions/market',undefined,{id:payload.id,kind:payload.kind,force:'1'}),offer=view.items?.find(item=>item.id===payload.id&&item.kind===payload.kind);
  if(!offer)throw Error('扩展已不存在，请刷新后重试');
  if(offer.needsLogin)return login();
  if(offer.action==='none')return{ok:true,unchanged:true};
  if(!['upload','push'].includes(offer.action))throw Error(offer.reason||'当前状态不能上传，请先检查市场版本');
  const path=`/api/extensions/${encodeURIComponent(payload.id)}/publish`;
  const prepared=await request('POST',path+'/prepare',{checkId:offer.checkId});if(prepared.needsLogin)return login();
  signal?.throwIfAborted();
  if(typeof review!=='function')throw Error('上传确认界面尚未就绪');
  const confirmed=await review({title:prepared.action==='push'?'推送市场更新':'上传到市场',text:`${prepared.name}\n版本：${prepared.remoteVersion?prepared.remoteVersion+' → ':''}${prepared.localVersion}\n发布账号：${prepared.accountUsername}\n\n将打包这个扩展目录并上传，随后按市场审核流程处理。`,accept:'继续验证并上传'},{signal});
  signal?.throwIfAborted();if(!confirmed)return{ok:false,canceled:true};
  const captchaVerifyParam=await verify({signal});signal?.throwIfAborted();
  return request('POST',path,{checkId:prepared.checkId,captchaVerifyParam},undefined,180000);
}
