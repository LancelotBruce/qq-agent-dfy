import {createHash} from 'node:crypto';

// Preserve every array's meaning (tools, required fields, enum preferences),
// while ignoring inconsequential object insertion order in the routing hint.
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
}

export function buildPromptCacheKey({baseUrl,model,accountScope,prefix='',messages=[],tools=[]}={}) {
  let url;
  try { url=new URL(baseUrl); } catch { return null; }
  // OpenAI-compatible gateways do not promise support for this field. In
  // particular, a DeepSeek/Claude model name does not select a cache protocol.
  if(url.protocol!=='https:'||url.hostname!=='api.openai.com'||url.port||url.username||url.password||url.search||url.hash||!['','/','/v1','/v1/'].includes(url.pathname))return null;
  if(typeof accountScope!=='string'||!/^[a-f0-9]{64}$/.test(accountScope))return null;
  // A short stable leading system paragraph partitions unrelated personas.
  // Dynamic extension sections/user messages never enter this key. The key is
  // a routing hint only: OpenAI still checks the actual exact prompt prefix.
  if(!prefix){const first=messages.find(message=>message?.role==='system'||message?.role==='developer');prefix=typeof first?.content==='string'?first.content.split(/\r?\n\s*\r?\n/,1)[0]:'';}
  const identity=canonical({accountScope,model:String(model??''),prefix,tools});
  return 'qqa-cache-v1-'+createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0,48);
}
