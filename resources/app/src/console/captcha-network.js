import {safeFetch} from '../kernel/safe-fetch.js';

// Fixed public destinations only. No caller can supply a URL, cookie, API key
// or payload. The SDK is loaded dynamically from the vendor's documented CDN.
export const CAPTCHA_PROBE_TARGETS=Object.freeze([
  {url:'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js',method:'GET',kind:'sdk'},
  {url:'https://captcha.cn-shanghai.aliyuncs.com/',method:'HEAD',kind:'api'},
]);
export function classifyCaptchaNetworkError(error){
  for(let depth=0;error&&depth<4;depth++,error=error.cause){
    const code=String(error.code??'').toUpperCase();
    if(error.name==='TimeoutError'||/TIMEOUT|ETIMEDOUT/.test(code)||error.message==='请求超时')return'timeout';
    if(/CERT|TLS|SSL/.test(code))return'tls';
    if(code==='ENOTFOUND'||code==='EAI_AGAIN')return'dns';
    if(/拒绝访问内网|私网|白名单/.test(String(error.message)))return'blocked';
  }
  return'network';
}
export async function probeCaptchaNetwork(fetchImpl=globalThis.fetch,{dnsLookup,signal,timeoutMs=5000}={}){
  signal?.throwIfAborted();
  const targets=await Promise.all(CAPTCHA_PROBE_TARGETS.map(async target=>{
    const start=Date.now();
    try{
      const response=await safeFetch(target.url,{method:target.method,fetchImpl,dnsLookup,signal,timeoutMs,maxBytes:4096,followRedirects:false});
      signal?.throwIfAborted();
      return{target:target.url,ok:true,status:response.status,contentType:response.headers.get('content-type')||'',latencyMs:Date.now()-start};
    }catch(error){signal?.throwIfAborted();return{target:target.url,ok:false,status:null,error:classifyCaptchaNetworkError(error),latencyMs:Date.now()-start};}
  }));
  return{ok:targets.some(target=>target.ok),targets,checkedAt:new Date().toISOString()};
}
