// Presentation metadata only. Provider/model IDs remain the accounting and
// request identities; never infer a channel from its endpoint or display name.
export const providerDisplayName = provider => String(provider?.displayName || provider?.name || provider?.id || '未命名渠道');
export function modelDisplayName(provider, model) {
  const id=String(model??'').trim();
  const names=provider?.modelNames;
  const named=names&&typeof names==='object'&&!Array.isArray(names)&&Object.hasOwn(names,id)?names[id]:null;
  const entry=provider?.models?.find?.(item=>String(typeof item==='string'?item:item?.id??item?.model??'').trim()===id);
  return String(named || (entry&&typeof entry==='object'&&(entry.name||entry.displayName)) || (id&&id!=='unknown'?id:'未记录模型'));
}
export function createModelNameResolver(config={}) {
  const providers=new Map(),modelNames=new Map();
  for(const provider of config.providers??[]) {
    if(!provider||typeof provider.id!=='string')continue;
    providers.set(provider.id,providers.has(provider.id)?null:provider);
  }
  return (record={}) => {
    const id=record.providerId || record.provider;
    const source=id&&providers.get(id);
    const direct=id==='direct'||(!id&&(record.providerId===''||record.provider===''));
    const state=source?'configured':direct?'direct':id?'historical':'unassigned';
    const modelKey=source?JSON.stringify([id,record.model]):null;
    if(source&&!modelNames.has(modelKey))modelNames.set(modelKey,modelDisplayName(source,record.model));
    return {
      providerName:source?providerDisplayName(source):direct?'直接接入':state==='historical'?String(record.providerName||'历史渠道'):'未记录渠道',
      modelName:source?modelNames.get(modelKey):String(record.modelName||modelDisplayName(null,record.model)),
      providerState:state,
    };
  };
}
export function captureModelNames(record,config) {
  const {providerName,modelName}=createModelNameResolver(config)(record);
  return {providerName,modelName};
}
