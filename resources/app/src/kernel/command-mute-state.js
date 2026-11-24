// Historical numeric keys belong to groups. Private chats have an explicit
// namespace so equal QQ/group numbers never share their quiet state.
export function commandMuteKey(chatKey){
  const match=/^(group|private):([1-9]\d{0,14})$/.exec(String(chatKey??''));
  return match?(match[1]==='group'?match[2]:`private:${match[2]}`):null;
}
export function commandMuteUntil(active,chatKey){
  const key=commandMuteKey(chatKey);if(!key||!active||!Object.hasOwn(active,key))return null;
  const raw=active[key];if(typeof raw!=='number'&&(typeof raw!=='string'||!raw.trim()))return null;
  const value=Number(raw);return Number.isFinite(value)&&value>=0?value:null;
}
export function isChatQuiet(commandMute,chatKey,now=Date.now()){
  if(commandMute?.enabled===false)return false;
  const until=commandMuteUntil(commandMute?.active,chatKey);return until!==null&&(until===0||until>now);
}

// Commands are complete messages, optionally addressed to this account. Read
// their text segments rather than searching a rendered message or quotation.
export function resolveQuietCommand({cfg,kind,id,event,entry,selfId,now=Date.now()}){
  const settings=cfg?.commandMute,chatKey=`${kind}:${id}`,key=commandMuteKey(chatKey);
  if(!key||settings?.enabled===false||selfId!=null&&String(entry?.senderId)===String(selfId))return null;
  const quiet=String(settings?.command??'/安静').trim(),resume=String(settings?.resumeCommand??'/活跃').trim();
  if(quiet&&quiet===resume)return null;
  const parts=Array.isArray(event?.message)?event.message:null;
  let text='';
  if(parts){
    for(const segment of parts){
      const data=segment?.data??segment;
      if(segment?.type==='text')text+=String(data?.text??'');
      else if(segment?.type==='at'){if(!selfId||String(data?.qq)!==String(selfId))return null;}
      else if(segment?.type!=='reply')return null;
    }
  }else text=String(event?.raw_message??entry?.text??'');
  let addressedElsewhere=false;
  text=text.replace(/\[CQ:([a-z_]+)([^\]]*)\]/gi,(raw,type,attributes)=>{
    if(type==='reply')return '';
    const qq=/(?:^|,)qq=([^,]+)/.exec(attributes)?.[1];
    if(type!=='at'||!selfId||qq!==String(selfId))addressedElsewhere=true;
    return '';
  }).trim();
  if(addressedElsewhere)return null;
  if(entry?.atMe===true){
    const names=[...(entry.atNames??[]),...['selfNickname','botName'].map(field=>cfg?.persona?.[field]).filter(Boolean).map(name=>'@'+name)].sort((a,b)=>b.length-a.length);
    for(const name of names)if(name&&text.startsWith(name))text=text.slice(name.length).trimStart();
  }
  const type=quiet&&text===quiet?'quiet':resume&&text===resume?'resume':null;
  if(!type)return null;
  const duration=Number(settings?.durationMin??30),minutes=Number.isFinite(duration)&&duration>=0?duration:30;
  const until=type==='resume'?1:minutes===0?0:now+minutes*60_000;
  return Number.isFinite(until)?{type,chatKey,key,until,command:text}:null;
}
