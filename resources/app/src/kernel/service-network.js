// Shipped services declare their exact HTTPS API routes. This is separate from
// the agent's browsing whitelist and is never a grant to a user extension.
export function normalizeServiceNetwork(raw) {
  if(raw===undefined)return [];
  if(!Array.isArray(raw)||raw.length>16)throw Error('serviceNetwork 必须是至多 16 条固定服务地址');
  return raw.map(rule=>{
    if(!rule||typeof rule!=='object'||Array.isArray(rule)||Object.keys(rule).some(key=>!['origin','pathPrefix'].includes(key)))throw Error('serviceNetwork 地址声明无效');
    let url;try{url=new URL(rule.origin);}catch{throw Error('serviceNetwork origin 无效');}
    if(url.protocol!=='https:'||url.username||url.password||url.port||url.origin!==rule.origin)throw Error('serviceNetwork 只接受不含凭据或端口的 HTTPS origin');
    const prefix=rule.pathPrefix;
    if(typeof prefix!=='string'||prefix==='/'||!prefix.startsWith('/')||!prefix.endsWith('/')||/[%\\?#\x00-\x20]|\/\/|\/\.\.?(?:\/|$)/.test(prefix))throw Error('serviceNetwork 需要固定的服务目录前缀');
    return {origin:url.origin,pathPrefix:prefix};
  });
}

export function serviceNetworkPolicy(entry) {
  if(entry?.rootKind!=='bundled'||!entry.manifest?.serviceNetwork?.length)return null;
  const rules=normalizeServiceNetwork(entry.manifest.serviceNetwork);
  return {validateUrl(value){
    const url=value instanceof URL?value:new URL(value);
    if(url.username||url.password||/%(?:2e|2f|5c|25)/i.test(url.pathname)||!rules.some(rule=>url.origin===rule.origin&&url.pathname.startsWith(rule.pathPrefix)))throw Error('服务请求超出内置插件声明的 HTTPS 地址范围');
  }};
}
