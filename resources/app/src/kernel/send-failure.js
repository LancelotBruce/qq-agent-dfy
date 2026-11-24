// A transport can attach a small public diagnostic. Never carry its raw response,
// arguments, stack, URL, headers or arbitrary error text into application logs.
const categories={network:'协议端网络连接异常',timeout:'等待协议端响应超时',authorization:'协议端认证失败',unavailable:'协议端暂不可用',rejected:'协议端未确认发送成功'};
export function safeSendDiagnostic(value){
  if(!value||typeof value!=='object'||typeof value.category!=='string'||!Object.hasOwn(categories,value.category))return null;
  const result={category:value.category};
  if(Number.isSafeInteger(value.status)&&value.status>=0&&value.status<=65535)result.status=value.status;
  return result;
}
export function sendFailureError(row,fallback){
  const error=new Error(row?.error??fallback),diagnostic=safeSendDiagnostic(row?.diagnostic);
  if(diagnostic)error.diagnostic=diagnostic;
  return error;
}
export function describeSendDiagnostic(value){
  const diagnostic=safeSendDiagnostic(value);
  return diagnostic?`回复发送失败：${categories[diagnostic.category]}${diagnostic.status===undefined?'':`（状态码 ${diagnostic.status}）`}`:'未返回可公开的错误码';
}
