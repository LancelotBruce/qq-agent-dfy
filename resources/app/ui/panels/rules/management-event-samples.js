// Synthetic OneBot fields used only by the rule simulator. They never change
// the saved rule or dispatch an event to the live QQ transport.
const notices={
  member_join:{notice:'group_increase',subtypes:[['approve','管理员同意入群'],['invite','被邀请入群']],operator:true},
  member_leave:{notice:'group_decrease',subtypes:[['leave','主动退出'],['kick','被管理员移出'],['kick_me','机器人被移出']],operator:true},
  member_muted:{notice:'group_ban',subtypes:[['ban','被禁言']],operator:true,duration:true},
  member_unmuted:{notice:'group_ban',subtypes:[['lift_ban','解除禁言']],operator:true},
  admin_changed:{notice:'group_admin',subtypes:[['set','设为管理员'],['unset','取消管理员']],operator:false},
  message_recalled:{notice:'group_recall',operator:true},
  group_poke:{notice:'notify',subtypes:[['poke','群内戳一戳']],operator:false},
  group_upload:{notice:'group_upload',operator:false},
};
export const eventSampleSpec=type=>notices[type]??null;

export function buildSimulationEvent({trigger,chatKind='group',userId,text='',botId='10000',now=Date.now(),subType,operatorId='',nickname='模拟用户',card='',userRole='member',segment='text',duration=60}){
  const base={post_type:'message',message_type:chatKind,user_id:String(userId),self_id:String(botId),time:now/1000};
  const notice=eventSampleSpec(trigger);
  if(notice){
    if(notice.operator&&String(operatorId).trim()&&!/^\d{1,15}$/.test(String(operatorId).trim()))throw Error('操作者 QQ 应为数字，未提供时可以留空');
    if(notice.duration&&(!Number.isInteger(Number(duration))||Number(duration)<1||Number(duration)>2592000))throw Error('事件禁言时长应为 1 到 2592000 之间的整数秒');
    const event={...base,post_type:'notice',notice_type:notice.notice,message:[],sender:null};delete event.message_type;
    if(notice.subtypes)event.sub_type=subType??notice.subtypes[0][0];
    if(notice.operator&&String(operatorId).trim())event.operator_id=String(operatorId).trim();
    if(trigger==='member_muted')event.duration=Number(duration);if(trigger==='member_unmuted')event.duration=0;
    if(trigger==='group_poke')event.target_id=String(botId);
    if(trigger==='group_upload')event.file={id:'simulation-only',name:'模拟文件.txt',size:0};
    if(trigger==='member_leave'&&event.sub_type==='kick_me')event.user_id=String(botId);
    return event;
  }
  if(trigger==='join_request')return {...base,post_type:'request',request_type:'group',sub_type:'add',comment:text,flag:'simulation-only',message:[],sender:null};
  if(trigger==='interval')return {time:now/1000,self_id:String(botId),message:[],sender:null};
  const message=[{type:'text',data:{text}}];
  if(segment!=='text')message.push({type:segment,data:segment==='at'?{qq:String(botId)}:{file:'simulation-only',id:'1'}});
  return {...base,sender:{user_id:String(userId),nickname,card,role:userRole},message};
}
