// OneBot extension actions. Read-only detection never adds/deletes a favorite.
const actionNames=['addCustomFace','modifyCustomFace','deleteCustomFace','fetchCustomFaces','fetchCustomFaceDetails'];
const cancelled=(result)=>Object.assign(new Error('表情操作期间账号、协议连接或操作状态已更改'),{code:'QQ_EMOJI_CANCELLED',...(result?.emojiId?{remoteEffect:'added',emojiId:result.emojiId}:{})});
function confirmed(response,action){
  if(!response||typeof response!=='object'||Array.isArray(response)||
    response.status!=null&&response.status!=='ok'||response.retcode!=null&&Number(response.retcode)!==0||
    response.status!=='ok'&&response.retcode!==0&&response.retcode!=='0')
    throw Object.assign(new Error(`OneBot ${action} 未确认成功`),{code:'QQ_EMOJI_PROTOCOL_ERROR'});
  return response.data;
}
function emojiId(value){
  if(!['string','number'].includes(typeof value)||typeof value==='number'&&!Number.isFinite(value))throw Object.assign(new Error('协议端未返回合法 emoji_id，无法确认收藏结果'),{code:'QQ_EMOJI_NO_ID'});
  const id=String(value).trim();if(!id||id.length>256||/[\x00-\x1f]/.test(id))throw Object.assign(new Error('协议端未返回合法 emoji_id，无法确认收藏结果'),{code:'QQ_EMOJI_NO_ID'});return id;
}
export function createFavoritesActions({client,identity,ready=()=>client.connected&&client.transportReady}){
  let dialect=null;
  async function call(action,params,{signal,added=false}={}){
    const account=identity();if(!account||!ready())throw Object.assign(new Error('QQ 连接尚未就绪'),{code:'QQ_EMOJI_UNAVAILABLE'});
    if(signal?.aborted)throw cancelled();
    const response=await client.call(action,params,{signal});
    const data=confirmed(response,action);
    const receipt=added?{emojiId:emojiId(data?.emoji_id??data?.qianqian_emoji??data?.emojiId)}:null;
    if(signal?.aborted||account!==identity()||!ready())throw cancelled(receipt);
    return added?receipt:data;
  }
  const actions={
    async fetchCustomFaceDetails({limit=100,signal}={}){
      const count=Math.max(1,Math.min(500,Math.floor(Number(limit)||100)));
      const data=await call('fetch_custom_face_detail',{count},{signal});
      if(!Array.isArray(data))throw Error('收藏表情详情不是数组');
      const entries=data.slice(0,count).map(item=>{
        if(!item||typeof item!=='object'||Array.isArray(item))throw Error('收藏表情详情格式不正确');
        const id=emojiId(item.emoji_id??item.emojiId??item.resId??item.id);
        for(const key of ['resId','qqFile','file','url','md5','desc'])if(item[key]!=null&&typeof item[key]!=='string'&&!(key==='resId'&&typeof item[key]==='number'&&Number.isFinite(item[key])))throw Error('收藏表情详情字段不正确');
        return{id,emojiId:id,resId:String(item.resId??id).slice(0,256),qqFile:String(item.qqFile??item.file??'').slice(0,2048),url:String(item.url??'').slice(0,8192),md5:String(item.md5??'').slice(0,128).toUpperCase(),desc:String(item.desc??'').slice(0,300)};
      });
      return{entries,complete:false}; // A bounded read never proves removals.
    },
    async fetchCustomFaces(count=48,{signal}={}){
      const data=await call('fetch_custom_face',{count:Math.max(1,Math.min(500,Math.floor(Number(count)||48)))},{signal});
      if(!Array.isArray(data)||data.some(value=>typeof value!=='string'))throw Error('收藏表情地址列表格式不正确');return data.slice(0,500);
    },
    async addCustomFace(file,{signal}={}){
      if(typeof file!=='string'||!file.trim())throw Error('收藏表情的图片地址为空');
      if(!dialect)throw Object.assign(new Error('尚未确认协议端的收藏接口'),{code:'QQ_EMOJI_UNAVAILABLE'});
      return call('add_custom_face',{file},{signal,added:true});
    },
    async modifyCustomFace(id,desc,{signal}={}){
      if(!dialect)throw Object.assign(new Error('尚未确认协议端的收藏接口'),{code:'QQ_EMOJI_UNAVAILABLE'});
      await call('modify_custom_face',{emoji_id:emojiId(id),desc:String(desc??'')},{signal});return{ok:true};
    },
    async deleteCustomFace(id,{signal}={}){if(!dialect)throw Object.assign(new Error('尚未确认协议端的收藏接口'),{code:'QQ_EMOJI_UNAVAILABLE'});await call('delete_custom_face',{emoji_id:emojiId(id)},{signal});return{ok:true};},
    async checkCustomFaceSupport({signal}={}){
      dialect=null;const account=identity();
      const version=await call('get_version_info',{},{signal}),name=String(version?.app_name??'').toLowerCase();
      // NapCat's similarly named actions require local paths and extra resource
      // identifiers. Do not advertise its write interface using SnowLuma's DTO.
      const candidate=name.includes('snowluma')?'snowluma':null;
      if(!candidate)throw Object.assign(new Error('尚未适配此协议端的账号表情收藏接口'),{code:'QQ_EMOJI_UNSUPPORTED'});
      await actions.fetchCustomFaceDetails({limit:1,signal});
      if(account!==identity()||signal?.aborted||!ready())throw cancelled();dialect=candidate;return{supported:true,implementation:candidate};
    },
  };
  return actions;
}

// Publish only after a verified account and a successful read-only interface
// check. Each binding owns its in-flight check; stale connections cannot revive it.
export function createFavoritesCapability({register,changed=()=>{},retryMs=30000}){
  let binding=null,epoch=0,controller=null,verified=null,pending=null,timer=null,published;
  const isLive=()=>binding&&binding.current()===true;
  const identity=()=>isLive()?binding.instance.actions.getAccountIdentity?.()??null:null;
  const favorites=Object.fromEntries(actionNames.map(name=>[name,async(...args)=>{
    const instance=binding?.instance,account=identity();
    if(!instance||!account||verified!==account||!isLive())throw Object.assign(new Error('QQ 收藏接口尚未就绪'),{code:'QQ_EMOJI_UNAVAILABLE'});
    const result=await instance.actions[name](...args),signal=args.find(value=>value&&typeof value==='object'&&value.signal)?.signal;
    if(signal?.aborted||binding?.instance!==instance||!isLive()||identity()!==account)throw cancelled(name==='addCustomFace'?result:null);return result;
  }]));
  favorites.getAccountIdentity=()=>verified===identity()?identity():null;
  function publish(provider){if(published===provider)return;register(provider);published=provider;changed();}
  function invalidate(){++epoch;controller?.abort();controller=null;pending=null;verified=null;if(timer)clearTimeout(timer);timer=null;publish(null);}
  function refresh(instance){
    if(!binding||binding.instance!==instance||!isLive())return;
    const status=instance.status(),account=identity();
    if(!status.connected||status.transportReady!==true||!account){invalidate();return;}
    if(account===verified||account===pending)return;
    invalidate();const ticket=epoch,probe=new AbortController();controller=probe;pending=account;
    Promise.resolve().then(()=>instance.actions.checkCustomFaceSupport({signal:probe.signal})).then(result=>{
      if(ticket!==epoch||probe.signal.aborted||binding?.instance!==instance||!isLive()||identity()!==account||result?.supported!==true)return;
      verified=account;publish(favorites);
    }).catch(()=>{
      if(ticket===epoch&&isLive()&&retryMs>0){timer=setTimeout(()=>{timer=null;refresh(instance);},retryMs);timer.unref?.();}
    }).finally(()=>{if(ticket===epoch){controller=null;pending=null;}});
  }
  publish(null);
  return{bind(instance,current){invalidate();binding={instance,current};refresh(instance);},refresh,
    clear(instance){if(instance&&binding?.instance!==instance)return;invalidate();binding=null;}};
}
