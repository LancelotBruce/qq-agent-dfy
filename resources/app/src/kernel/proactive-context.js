// Interaction metadata supplements the selected transcript without inserting
// extra historical prose or inspecting another conversation. Source references
// join the existing recall/invalidation boundary, and are never in the prompt.
export function proactiveActivity(entries=[],blockedIds=[]) {
  const blocked=new Set(blockedIds.map(String));
  let incoming=null,outgoing=null,pending=[];
  for(const entry of entries){
    if(entry.recalled||entry.read===false)continue;
    if(entry.self===true){outgoing=entry;pending.push(entry);}
    else if(!blocked.has(String(entry.senderId))){incoming=entry;pending=[];}
  }
  const time=entry=>typeof entry?.ts==='number'&&Number.isFinite(entry.ts)&&entry.ts>0?entry.ts:null;
  return {context:{lastIncomingAt:time(incoming),lastOutgoingAt:time(outgoing),unansweredOutgoingCount:pending.length},
    sources:[...new Set([incoming,outgoing,...pending].filter(Boolean))]};
}
