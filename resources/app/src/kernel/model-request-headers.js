import crypto from 'node:crypto';

// The service expects a stable routing id, not a new id on each HTTP attempt.
// Hash local conversation keys so QQ numbers and group ids never become headers.
// Each account worker has its own process salt; nothing is stored in user config.
const sessionSalt=crypto.randomBytes(32),auxiliarySession=`qqagent-${crypto.randomUUID()}`;
function openCodeEndpoint(value){
  try{const url=new URL(value);return ['https:','http:'].includes(url.protocol)&&url.hostname.toLowerCase().replace(/\.$/,'')==='opencode.ai'&&!url.username&&!url.password;}catch{return false;}
}
export function buildModelRequestHeaders({baseUrl,apiKey,sessionId,headers={}}={}){
  const result={...headers,...(apiKey?{authorization:`Bearer ${apiKey}`}:{})};
  if(openCodeEndpoint(baseUrl)){
    const scope=typeof sessionId==='string'?sessionId.trim():'';
    result['x-opencode-session']=scope?'qqagent-'+crypto.createHmac('sha256',sessionSalt).update(scope).digest('hex'):auxiliarySession;
    result['user-agent']='qq-agent/0.5';
  }
  return result;
}
