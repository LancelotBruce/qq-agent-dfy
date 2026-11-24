import {ownPath} from './ports.js';
import {messageContent,stableJson} from './message-content.js';
const pin=(key,label,type,extra={})=>({key,label,type,...extra});
const field=(key,label,type,extra={})=>({key,label,type,...extra});
const select=(key,label,options,value=options[0][0])=>field(key,label,'select',{options,default:value});
const number=(key,label,value,min=-1e12,max=1e12)=>field(key,label,'number',{default:value,min,max});
const ops=[['eq','等于'],['ne','不等于'],['gt','大于'],['gte','大于等于'],['lt','小于'],['lte','小于等于'],['contains','包含'],['prefix','开头为'],['suffix','结尾为']];
const make=(type,label,pure,fields,inputs,outputs,description,example,extra={})=>({type,label,pure,primitive:true,featured:true,group:pure?'数据':'基础',category:pure?'基础运算':'基础控制',fields,valuePorts:{inputs,outputs},description,example,inputHint:pure?'使用明确的数据输入，按需计算':'执行线决定何时运行，数据线提供参数',outputHint:pure?'输出计算结果，不执行业务操作':'每项操作独立；完成后继续',...extra});
const scope=select('scope','状态范围',[['rule','当前规则'],['account','当前账号']]);
const stateKey=field('key','状态键','text',{required:true,maxLength:300});
const stateCommon=[pin('key','状态键','text',{configKey:'key',required:true}),pin('scope','状态范围','text',{configKey:'scope',default:'rule',options:scope.options})];
const ttl=number('ttl_seconds','保留秒数（0 为不过期）',0,0,2678400);
export const PRIMITIVE_NODES=[
  make('compare','比较',true,[select('operator','比较方式',ops)],[pin('a','左值','any',{required:true}),pin('b','右值','any',{required:true}),pin('operator','比较方式','text',{configKey:'operator',default:'eq',options:ops})],[pin('result','比较结果','boolean')],'比较传入的两个值。等于按类型与内容严格比较，大小比较要求两个数值。','昵称与名单文字比较；数值与阈值比较'),
  make('boolean_logic','逻辑运算',true,[select('operator','运算',[['and','并且'],['or','或者'],['not','取反']])],[pin('a','条件 A','boolean',{required:true}),pin('b','条件 B','boolean',{default:true,optional:true}),pin('operator','运算','text',{configKey:'operator',default:'and'})],[pin('result','结果','boolean')],'组合真假值；不读取群身份、关键词或任何业务状态。','两个比较结果 → 并且 → 按真假值分支'),
  make('number_math','数值运算',true,[select('operator','运算',[['add','相加'],['subtract','相减'],['multiply','相乘'],['divide','相除'],['min','最小值'],['max','最大值']])],[pin('a','数值 A','number',{required:true}),pin('b','数值 B','number',{required:true}),pin('operator','运算','text',{configKey:'operator',default:'add'})],[pin('value','结果','number')],'对两个数值进行一次运算；不绑定计数、时长或群管理用途。','价格 × 数量；已处理数量 + 1'),
  make('time_offset','时间偏移',true,[number('seconds','偏移秒数',5)],[pin('time','基准时间','timestamp',{required:true}),pin('seconds','偏移秒数','number',{configKey:'seconds',default:5})],[pin('time','偏移后的时间','timestamp')],'给任意时间戳增加或减少秒数。','触发时间 + 5 秒；到期时间 - 60 秒'),
  make('list_filter','筛选列表',true,[field('path','比较字段（空为元素本身）','text',{default:'',maxLength:120}),select('operator','比较方式',ops)],[pin('items','原列表','list',{required:true}),pin('value','比较值','any',{required:true}),pin('path','比较字段','text',{configKey:'path',default:''}),pin('operator','比较方式','text',{configKey:'operator',default:'eq'})],[pin('items','筛选结果','list'),pin('count','结果数量','number')],'逐项比较列表元素或其字段，输出符合条件的列表，不执行动作。','成员列表按 role 筛选；记录列表按状态筛选'),
  make('list_field','提取列表字段',true,[field('path','字段路径','text',{default:'user_id',required:true,maxLength:120})],[pin('items','原列表','list',{required:true}),pin('path','字段路径','text',{configKey:'path',required:true})],[pin('items','字段值列表','list')],'从列表的每个对象取同一字段，保留列表顺序。','成员对象列表 → user_id 列表'),
  make('list_tail_equal','取末尾相同项',true,[field('path','比较字段（空为元素本身）','text',{default:'content_key',maxLength:120})],[pin('items','原列表','list',{required:true,description:'按原顺序排列的列表；末项就是最新一项。不会按时间重新排序。'}),pin('path','比较字段','text',{configKey:'path',default:'content_key',description:'按此字段与末项作严格等值比较。留空比较元素本身；缺失字段不会当作相同。'})],[pin('items','末尾连续相同项','list'),pin('count','连续项数','number'),pin('value','相同的字段值','any',{optional:true})],'从末项向前取连续相同的一段；遇到不同项就停止，前面的相同项不会被拼进来。只是列表运算，不自行处罚。','a、a、b、a、a → 末尾两项；也可比较记录的状态、作者或内容键',{category:'列表处理'}),
  make('list_distinct','列表去重',true,[field('path','去重字段（空为元素本身）','text',{default:'user_id',maxLength:120})],[pin('items','原列表','list',{required:true}),pin('path','去重字段','text',{configKey:'path',default:'user_id',description:'同字段值只保留第一次出现的元素；留空按整个元素去重。缺失字段会明确报错。'})],[pin('items','去重后的列表','list'),pin('count','不同项数','number')],'按任意字段去重，保留原顺序。可用于不同发言人、不同标签或任务编号，不读取群成员身份。','连续消息 → 按 user_id 去重 → 不同发言人数',{category:'列表处理'}),
  make('message_content_key','消息内容键',true,[select('mode','比较内容',[['segments','完整内容'],['text','仅文字']])],[pin('message','消息内容','message',{inherit:'message',description:'默认取启动本轮的消息，也可接入消息段。不会发送或下载内容。'}),pin('mode','比较内容','text',{configKey:'mode',default:'segments'})],[pin('key','内容键','text'),pin('only_text','只含纯文字','boolean'),pin('comparable','能可靠比较','boolean')],'把消息转为可比较的内容键。完整内容保留文字、提及和媒体身份；媒体没有稳定标识时标记不可比较，不靠临时网址猜测同一张图。','内容键用于列表比较；只含纯文字用于安全复读，含 CQ 指令、提及或媒体时为否',{category:'消息数据'}),
  make('message_history','读取最近消息',false,[number('seconds','回看秒数',60,1,3600),number('limit','最多消息数',100,1,1000),field('include_self','包含机器人自身','boolean',{default:false})],[pin('seconds','回看秒数','number',{configKey:'seconds',default:60}),pin('limit','最多消息数','number',{configKey:'limit',default:100}),pin('include_self','包含机器人自身','boolean',{configKey:'include_self',default:false})],[pin('items','最近消息列表','list',{description:'当前会话截至本轮触发时的消息快照，按本机接收顺序排列，包含当前消息。每项有 user_id、message_id、time、received_at、text、message、content_key、only_text 和 comparable。'}),pin('count','消息数','number'),pin('observed','已观察当前会话','boolean',{description:'应用缓冲区中已有当前会话的观察记录时为是。筛选后没有符合条件的消息，仍可能是已观察；重启前或暂停期间不会补拉。'}),pin('complete','记录可用且未截断','boolean',{description:'当前会话已有观察记录、且没有因条数或内存上限丢弃本次范围中的数据时为是。排除自身消息或时间窗筛选后，正常空列表也可为是；完全没有观察记录则为否。'})],'读取当前群聊或私聊在应用中已观察到的消息。按本机接收时间回看，协议旧时间不会重排；快照不包含本轮开始后才到达的消息。','最近消息 → 取末尾相同项 → 按发言人去重 → 比较数量',{category:'读取数据'}),
  make('event_source','事件源',false,[select('event_type','事件类型',[['message','群消息'],['member_join','成员入群'],['member_leave','成员离群'],['ban','禁言变动'],['recall','消息撤回'],['poke','戳一戳'],['group_upload','群文件上传'],['admin_changed','管理员变动'],['join_request','入群申请']]),number('replay_seconds','回看秒数',60,0,3600)],[pin('group_id','群号','group_id',{inherit:'group',required:true}),pin('event_type','事件类型','text',{configKey:'event_type',default:'message'}),pin('replay_seconds','回看秒数','number',{configKey:'replay_seconds',default:60})],[pin('events','事件流','stream')],'提供当前群的持续事件流；不会自行结束，仅负责提供数据。可交给时间窗、逐项处理、记录或统计；不会自动撤回。','事件源 → 时间窗 → 逐项处理 → 任意操作'),
  make('stream_window','时间窗',true,[],[pin('events','事件流','stream',{required:true}),pin('start','开始时间','timestamp',{required:true,preflight:true}),pin('end','结束时间','timestamp',{required:true})],[pin('items','窗口内事件','stream')],'按事件时间截取 [开始, 结束)；到期停止接收并排空已入窗的数据，不包含消息处理策略。','同一窗口输出可连接统计、记录、通知或消息操作'),
  make('for_each','逐项处理',false,[select('on_error','单项失败',[['stop','停止'],['continue','记录后继续']]),number('max_items','最多处理项数',1000,1,2000)],[pin('items','列表或事件流','sequence',{required:true}),pin('on_error','单项失败','text',{configKey:'on_error',default:'stop'}),pin('max_items','最多处理项数','number',{configKey:'max_items',default:1000})],[pin('item','当前项','any',{iterationOnly:true}),pin('index','当前序号','number',{iterationOnly:true}),pin('processed','已处理项数','number'),pin('failed','失败项数','number')],'每一项都执行“每项”出口内的节点，列表遍历完或事件流关闭后走“完成”。每轮数据隔离，可处理名单、记录和事件流。','名单 → 逐项 → 发提醒；事件流 → 逐项 → 记录',{loop:true}),
  ...['read','write','add'].map(operation=>make('state_'+operation,({read:'读取状态',write:'写入状态',add:'数值累加'})[operation],false,[stateKey,scope,...(operation==='read'?[]:[ttl]),...(operation==='add'?[number('amount','增量',1),number('initial','初值',0)]:[])],[...stateCommon,...(operation==='read'?[pin('fallback','缺省值','any',{optional:true})]:operation==='write'?[pin('value','写入值','any',{required:true})]:[pin('amount','增量','number',{configKey:'amount',default:1}),pin('initial','初值','number',{configKey:'initial',default:0})]),...(operation==='read'?[]:[pin('ttl_seconds','保留秒数','number',{configKey:'ttl_seconds',default:0})])],[pin('value','当前值','any',{optional:operation==='read'}),pin('previous','原值','any',{optional:true})],({read:'按键读取一个值，不修改它。',write:'按键保存任意有界 JSON 值。',add:'对指定键的数值做一次原子加法；初次使用初值。日期、群号、用户都由键的连线决定。'})[operation],'日期 + 群号 → 状态键；也可保存开关、分数、对象或去重标记',{category:'基础状态'})),
];
export function compareValues(a,b,operator){
  const same=(a,b)=>{if(Object.is(a,b))return true;if(!a||!b||typeof a!=='object'||typeof b!=='object'||Array.isArray(a)!==Array.isArray(b))return false;const keys=Object.keys(a).sort(),other=Object.keys(b).sort();return keys.length===other.length&&keys.every((key,index)=>key===other[index]&&same(a[key],b[key]));};
  if(operator==='eq'||operator==='ne'){const equal=same(a,b);return operator==='eq'?equal:!equal;}
  if(['gt','gte','lt','lte'].includes(operator)){if(typeof a!=='number'||typeof b!=='number')throw Error('大小比较需要两个数值');return ({gt:a>b,gte:a>=b,lt:a<b,lte:a<=b})[operator];}
  if(typeof a!=='string'||typeof b!=='string')throw Error('文字比较需要两个文字值');return operator==='contains'?a.includes(b):operator==='prefix'?a.startsWith(b):operator==='suffix'?a.endsWith(b):false;
}
export function evaluatePrimitive(node,input,hooks={}){
  switch(node.type){
    case 'compare':return {result:compareValues(input.a,input.b,input.operator)};
    case 'boolean_logic':return {result:input.operator==='not'?!input.a:input.operator==='or'?input.a||input.b:input.a&&input.b};
    case 'number_math':{const value=({add:()=>input.a+input.b,subtract:()=>input.a-input.b,multiply:()=>input.a*input.b,divide:()=>input.a/input.b,min:()=>Math.min(input.a,input.b),max:()=>Math.max(input.a,input.b)})[input.operator]();if(!Number.isFinite(value))throw Error('数值运算结果无效');return {value};}
    case 'time_offset':return {time:input.time+input.seconds};
    case 'list_filter':{const items=input.items.filter(item=>compareValues(input.path?ownPath(item,input.path):item,input.value,input.operator));return {items,count:items.length};}
    case 'list_field':return {items:input.items.map(item=>ownPath(item,input.path)??null)};
    case 'list_tail_equal':{
      if(!input.items.length)return {items:[],count:0};
      const get=item=>input.path?ownPath(item,input.path):item,value=get(input.items.at(-1));
      if(value===undefined)throw Error('末项没有要比较的字段');let start=input.items.length-1;
      while(start>0){const previous=get(input.items[start-1]);if(previous===undefined||!compareValues(previous,value,'eq'))break;start--;}
      const items=input.items.slice(start);return {items,count:items.length,value};
    }
    case 'list_distinct':{
      const seen=new Set(),items=[];for(const item of input.items){const value=input.path?ownPath(item,input.path):item;if(value===undefined)throw Error('列表项没有去重字段');const key=typeof value+':'+(Object.is(value,-0)?'-0':stableJson(value));if(!seen.has(key)){seen.add(key);items.push(item);}}
      return {items,count:items.length};
    }
    case 'message_content_key':return messageContent(input.message,input.mode);
    case 'stream_window':return {items:hooks.window(input.events,input.start,input.end)};
    default:return null;
  }
}
