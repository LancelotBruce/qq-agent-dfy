// Browser view of the optional per-kind configuration, including legacy files.
export function allChatsAllowed(cfg,kind){
  if(kind!=='group'&&kind!=='private')return false;
  const key=kind==='group'?'groups':'private',flag=cfg?.allow?.[kind==='group'?'allGroups':'allPrivate'];
  return flag!==undefined?flag===true:cfg?.allowAllWhenEmpty===true&&!(cfg?.allow?.[key]?.length);
}

// Match the runtime admission policy, including explicit allow-all flags and
// older empty-list settings. A stored preference is never admission itself.
export function chatAllowed(cfg,kind,id){
  if(kind!=='group'&&kind!=='private')return false;
  const key=kind==='group'?'groups':'private',has=list=>Array.isArray(list)&&list.map(String).includes(String(id));
  return !has(cfg?.deny?.[key])&&(allChatsAllowed(cfg,kind)||has(cfg?.allow?.[key]));
}
