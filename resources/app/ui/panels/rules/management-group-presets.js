// Recipes only describe choices and wires. Detection and QQ actions remain
// independent reusable nodes in the management runtime.
export const GROUP_RULE_TEMPLATES = Object.freeze([
  ['group-welcome','成员入群 → 欢迎','把新成员 QQ 填进欢迎文字，不需要群管理权限。'],
  ['group-leave','成员离群 → 通知','区分主动退出和被移出；操作人未提供时明确显示未知。'],
  ['group-echo','文字指令 → 复读','发送“/复读 内容”时，只复述其中的纯文字。'],
  ['group-repeat-notice','多人连续复读 → 提醒','最近 60 秒内，连续相同内容且至少 3 位群友；每群 60 秒最多提醒一次。'],
  ['group-repeat-recall','多人连续复读 → 撤回','沿用相同检测，只撤回当前这条消息；需要群管理权限。'],
  ['group-repeat-mute','多人连续复读 → 禁言','沿用相同检测，只禁言触发的普通成员 60 秒；需要群管理权限。'],
]);

export function createGroupRule(template,id=()=>crypto.randomUUID()){
  const recipe=GROUP_RULE_TEMPLATES.find(([key])=>key===template);
  if(!recipe)return null;
  const nodes=[];
  const make=(type,config={},extra={})=>{const node={id:id(),type,config,...extra};nodes.push(node);return node;};
  const wire=(target,key,source,port)=>{(target.bindings??={})[key]={nodeId:source.id,port};};
  const flow=(...steps)=>steps.forEach((step,index)=>step.next=steps[index+1]?.id??'$end');
  const compare=(source,port,operator,b)=>{const node=make('compare',{operator},{values:{b}});wire(node,'a',source,port);return node;};
  const branch=predicate=>{const node=make('branch_value',{condition:false},{next:'$end',otherwise:'$end'});wire(node,'condition',predicate,'result');return node;};
  const textSend=(trigger,text,slots={})=>{const format=make('format_text',{template:text}),send=make('send_text',{text:''},{next:'$end'});for(const [key,[source,port]]of Object.entries(slots))wire(format,key,source,port);wire(send,'text',format,'text');return send;};
  if(template==='group-welcome'){
    const event=make('member_join'),send=textSend(event,'欢迎新成员（QQ：{{a}}）加入群聊！',{a:[event,'user_id']});flow(event,send);
  }else if(template==='group-leave'){
    const event=make('member_leave'),left=branch(compare(event,'sub_type','eq','leave')),kicked=branch(compare(event,'sub_type','eq','kick'));
    const operator=make('default_value',{fallback:'未知操作者'});wire(operator,'value',event,'operator_id');
    const voluntary=textSend(event,'成员 {{a}} 已主动退出群聊。',{a:[event,'user_id']}),removed=textSend(event,'成员 {{a}} 被 {{b}} 移出群聊。',{a:[event,'user_id'],b:[operator,'value']}),unknown=textSend(event,'成员 {{a}} 已离开群聊（协议端未提供具体原因）。',{a:[event,'user_id']});
    event.next=left.id;left.next=voluntary.id;left.otherwise=kicked.id;kicked.next=removed.id;kicked.otherwise=unknown.id;
  }else if(template==='group-echo'){
    const event=make('message'),decode=make('message_text'),prefix=compare(decode,'text','prefix','/复读 '),both=make('boolean_logic',{operator:'and'}),slice=make('text_slice',{start:4}),trim=make('text_trim',{mode:'both'}),length=make('text_length_value'),nonempty=compare(length,'length','gt',0),ready=make('boolean_logic',{operator:'and'}),gate=branch(ready),send=make('send_text',{text:''},{next:'$end'});
    wire(decode,'message',event,'message');wire(both,'a',prefix,'result');wire(both,'b',decode,'only_text');wire(slice,'text',decode,'text');wire(trim,'text',slice,'text');wire(length,'text',trim,'text');wire(ready,'a',both,'result');wire(ready,'b',nonempty,'result');wire(send,'text',slice,'text');flow(event,gate,send);
  }else{
    const event=make('message'),history=make('message_history',{seconds:60,limit:100,include_self:false}),tail=make('list_tail_equal',{path:'content_key'}),members=make('list_distinct',{path:'user_id'});
    wire(tail,'items',history,'items');wire(members,'items',tail,'items');
    const enoughMessages=compare(tail,'count','gte',3),enoughMembers=compare(members,'count','gte',3),both=make('boolean_logic',{operator:'and'}),complete=make('boolean_logic',{operator:'and'}),gate=branch(complete),cooldown=make('cooldown_gate',{seconds:60,scope:'group'},{otherwise:'$end'});
    wire(both,'a',enoughMessages,'result');wire(both,'b',enoughMembers,'result');wire(complete,'a',both,'result');wire(complete,'b',history,'complete');flow(event,history,gate,cooldown);
    if(template==='group-repeat-notice'){
      const send=textSend(event,'已有 {{a}} 位群友连续发送相同内容，请先暂停复读。',{a:[members,'count']});cooldown.next=send.id;
    }else{
      const profile=make('member_info'),ordinary=branch(compare(profile,'role','eq','member')),action=make(template==='group-repeat-mute'?'mute':'recall',template==='group-repeat-mute'?{seconds:60}:{},{next:'$end'});
      gate.next=profile.id;flow(profile,ordinary,cooldown,action);cooldown.otherwise='$end';
    }
  }
  const visiblePorts={};
  for(const node of nodes)visiblePorts[node.id]={inputs:Object.keys(node.bindings??{}),outputs:[...new Set(nodes.flatMap(target=>Object.values(target.bindings??{}).filter(binding=>binding.nodeId===node.id).map(binding=>binding.port)))]};
  return {id:id(),name:recipe[1],enabled:false,groups:[],private:[],cooldownSeconds:0,eventMode:'serial',nodes,layout:{version:1,positions:{},visiblePorts}};
}
