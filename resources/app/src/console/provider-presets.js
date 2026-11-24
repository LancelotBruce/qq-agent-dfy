// Provider identities follow DSH's pi-ai chat catalog. Endpoints below are
// deliberately selected for QQA's existing Chat Completions transport; this
// catalog does not pretend to install DSH's native protocols or OAuth flows.
export const PROVIDER_PRESETS_SOURCE=Object.freeze({
  url:'https://github.com/deepseek-ai/deepseek-harness/blob/f3803c96974ad4a94195fb97e5c637e9c2a3afe3/packages/llm/llm-pi-ai/src/catalog.ts',
  revision:'f3803c96974ad4a94195fb97e5c637e9c2a3afe3',
  catalog:'@earendil-works/pi-ai@1.3.0',
  checkedAt:'2026-10-28',
});
const ready=(id,name,baseUrl,apiKeyEnv,options={})=>({id,name,baseUrl,apiKeyEnv,status:'ready',fields:[],note:'',docs:PROVIDER_PRESETS_SOURCE.url,...options});
const gateway=(id,name,note,nativeHosts,docs)=>({id,name,baseUrl:'',apiKeyEnv:'',status:'gateway',fields:[],note:note+' 请使用兼容 OpenAI 的网关地址和网关密钥；不能直接填写原生接口。',nativeHosts,docs:docs||PROVIDER_PRESETS_SOURCE.url});
const mixed='使用该服务的 Chat Completions 接口；可用模型以实际拉取和测试为准。';
const rows=[
  gateway('amazon-bedrock','Amazon Bedrock','原生接入需要 AWS 区域、凭据链或 Bedrock 令牌，QQA 尚未提供此认证流程。',['amazonaws.com'],'https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference.html'),
  ready('ant-ling','Ant Ling','https://api.ant-ling.com/v1','ANT_LING_API_KEY'),
  gateway('anthropic','Anthropic','Claude 原生 Messages 接口暂未接入。',['anthropic.com'],'https://platform.claude.com/docs/en/api/messages'),
  ready('azure','Azure OpenAI','https://{resource}.openai.azure.com/openai/v1','AZURE_OPENAI_API_KEY',{fields:[{key:'resource',label:'Azure 资源名',placeholder:'my-resource',required:true}],note:'使用 Azure v1 兼容接口。添加模型时填写你的部署名称，而非通用模型名称。',docs:'https://learn.microsoft.com/en-us/azure/foundry-classic/openai/how-to/switching-endpoints'}),
  ready('baseten','Baseten','https://inference.baseten.co/v1','BASETEN_API_KEY'),
  ready('cerebras','Cerebras','https://api.cerebras.ai/v1','CEREBRAS_API_KEY'),
  gateway('cloudflare-ai-gateway','Cloudflare AI Gateway','原生接入需要账号、网关 ID 与专用认证头，普通 API Key 不能直接替代。',['gateway.ai.cloudflare.com'],'https://developers.cloudflare.com/ai-gateway/'),
  ready('cloudflare-workers-ai','Cloudflare Workers AI','https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1','CLOUDFLARE_API_KEY',{fields:[{key:'accountId',label:'Cloudflare 账号 ID',placeholder:'32 位账号 ID',required:true}],note:'填写 Cloudflare 账号 ID 和有 Workers AI 权限的 API 令牌。',docs:'https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/'}),
  ready('deepseek','DeepSeek','https://api.deepseek.com/v1','DEEPSEEK_API_KEY'),
  ready('fireworks','Fireworks','https://api.fireworks.ai/inference/v1','FIREWORKS_API_KEY',{note:mixed}),
  gateway('github-copilot','GitHub Copilot','Copilot 订阅需要专用登录和令牌交换，QQA 尚未提供该登录流程。',['githubcopilot.com','api.github.com'],'https://docs.github.com/en/copilot'),
  ready('google','Google Gemini','https://generativelanguage.googleapis.com/v1beta/openai','GEMINI_API_KEY',{note:'使用 Gemini 的 OpenAI 兼容入口，填写 AI Studio 的 Gemini API Key。',docs:'https://ai.google.dev/gemini-api/docs/openai'}),
  gateway('google-vertex','Google Vertex AI','原生接入需要项目、区域及 Google Cloud 身份认证，QQA 尚未提供该流程。',['googleapis.com'],'https://cloud.google.com/vertex-ai/generative-ai/docs'),
  ready('groq','Groq','https://api.groq.com/openai/v1','GROQ_API_KEY'),
  ready('huggingface','Hugging Face','https://router.huggingface.co/v1','HF_TOKEN'),
  ready('kimi-coding','Kimi Coding','https://api.kimi.com/coding/v1','KIMI_API_KEY',{note:'需要 Kimi Coding 对应的密钥与套餐；普通 Moonshot 密钥请选择 Moonshot AI。'}),
  ready('meta','Meta','https://api.meta.ai/v1','META_API_KEY',{note:mixed,docs:'https://dev.meta.ai/docs/protocols/chat-completions'}),
  ready('minimax','MiniMax · 国际','https://api.minimax.io/v1','MINIMAX_API_KEY',{docs:'https://platform.minimax.io/docs/api-reference/text-openai-api'}),
  ready('minimax-cn','MiniMax · 中国','https://api.minimax.cn/v1','MINIMAX_CN_API_KEY',{docs:'https://platform.minimax.cn/docs/api-reference/text-openai-api'}),
  ready('mistral','Mistral','https://api.mistral.ai/v1','MISTRAL_API_KEY',{docs:'https://docs.mistral.ai/resources/migration-guides'}),
  ready('moonshotai','Moonshot AI · 国际','https://api.moonshot.ai/v1','MOONSHOT_API_KEY'),
  ready('moonshotai-cn','Moonshot AI · 中国','https://api.moonshot.cn/v1','MOONSHOT_API_KEY'),
  ready('nvidia','NVIDIA','https://integrate.api.nvidia.com/v1','NVIDIA_API_KEY'),
  ready('openai','OpenAI','https://api.openai.com/v1','OPENAI_API_KEY',{note:'使用 API 平台密钥；ChatGPT 订阅与 API 额度分开。仅支持提供 Chat Completions 的模型。'}),
  gateway('openai-codex','OpenAI Codex','Codex 订阅接入需要 OAuth 登录，不能拿订阅直接当作 API 密钥。',['chatgpt.com','openai.com']),
  ready('opencode','OpenCode Zen','https://opencode.ai/inference/v1','OPENCODE_API_KEY',{note:mixed}),
  ready('opencode-go','OpenCode Go','https://opencode.ai/inference/go/v1','OPENCODE_API_KEY',{note:mixed}),
  ready('openrouter','OpenRouter','https://openrouter.ai/api/v1','OPENROUTER_API_KEY',{note:mixed}),
  ready('qwen-token-plan','Qwen Token Plan · 国际','https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1','QWEN_TOKEN_PLAN_API_KEY'),
  ready('qwen-token-plan-cn','Qwen Token Plan · 中国','https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1','QWEN_TOKEN_PLAN_CN_API_KEY'),
  ready('qwen-token-plan-individual','Qwen Token Plan · 个人','https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1','QWEN_TOKEN_PLAN_API_KEY',{note:'与国际站共享接口地址；使用个人套餐对应的密钥。'}),
  gateway('radius','Radius','原生 pi-messages 接口暂未接入。',['radius.pi.dev']),
  ready('together','Together AI','https://api.together.ai/v1','TOGETHER_API_KEY'),
  ready('vercel-ai-gateway','Vercel AI Gateway','https://ai-gateway.vercel.sh/v1','AI_GATEWAY_API_KEY',{docs:'https://vercel.com/docs/ai-gateway/sdks-and-apis/openai-chat-completions'}),
  ready('xai','xAI','https://api.x.ai/v1','XAI_API_KEY',{note:mixed,docs:'https://docs.x.ai/developers/rest-api-reference/inference/chat-completions'}),
  ready('xiaomi','Xiaomi MiMo','https://api.xiaomimimo.com/v1','XIAOMI_API_KEY'),
  ready('xiaomi-token-plan-ams','Xiaomi Token Plan · 阿姆斯特丹','https://token-plan-ams.xiaomimimo.com/v1','XIAOMI_TOKEN_PLAN_AMS_API_KEY'),
  ready('xiaomi-token-plan-cn','Xiaomi Token Plan · 中国','https://token-plan-cn.xiaomimimo.com/v1','XIAOMI_TOKEN_PLAN_CN_API_KEY'),
  ready('xiaomi-token-plan-sgp','Xiaomi Token Plan · 新加坡','https://token-plan-sgp.xiaomimimo.com/v1','XIAOMI_TOKEN_PLAN_SGP_API_KEY'),
  ready('zai','Z.AI','https://api.z.ai/api/coding/paas/v4','ZAI_API_KEY'),
  ready('zai-coding-cn','智谱 Coding · 中国','https://open.bigmodel.cn/api/coding/paas/v4','ZAI_CODING_CN_API_KEY'),
];
export const PROVIDER_PRESETS=Object.freeze(rows.map(row=>Object.freeze({...row,fields:Object.freeze(row.fields.map(Object.freeze)),...(row.nativeHosts?{nativeHosts:Object.freeze(row.nativeHosts)}:{})})));
const usable=value=>typeof value==='string'&&!!value.trim()&&value.trim()!=='******';
const bad=message=>{throw Object.assign(new Error(message),{status:400,expose:true});};
function endpoint(value){
  if(typeof value!=='string'||value.length>1000||/[{}]/.test(value))return '';
  try{const url=new URL(value.trim());if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)return '';url.pathname=url.pathname.replace(/\/+$/,'')||'/';return url.href;}catch{return '';}
}
export function providerPresetsView(env=process.env){
  return{source:{...PROVIDER_PRESETS_SOURCE},presets:PROVIDER_PRESETS.map(({nativeHosts,...row})=>({...row,fields:row.fields.map(field=>({...field})),configured:row.status==='ready'&&usable(env[row.apiKeyEnv])}))};
}
export function resolveProviderPreset({presetId,presetFields={},baseUrl,apiKey}={},env=process.env){
  const preset=typeof presetId==='string'&&PROVIDER_PRESETS.find(p=>p.id===presetId);
  if(!preset)bad('请选择有效的模型提供商预设');
  if(!presetFields||typeof presetFields!=='object'||Array.isArray(presetFields)||Object.keys(presetFields).some(key=>!preset.fields.some(field=>field.key===key)))bad('提供商配置项无效');
  let official=preset.baseUrl;
  for(const field of preset.fields){
    const value=presetFields[field.key];
    if(typeof value!=='string'||!value.trim())bad('请填写'+field.label);
    const clean=value.trim(),valid=field.key==='resource'?/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(clean):/^[a-f0-9]{32}$/i.test(clean);
    if(!valid)bad(field.label+'格式不正确');
    official=official.replaceAll('{'+field.key+'}',encodeURIComponent(clean));
  }
  if(baseUrl!==undefined&&typeof baseUrl!=='string')bad('接口地址格式不正确');
  const target=endpoint(baseUrl?.trim()||official);
  if(!target)bad(preset.status==='gateway'?'请填写兼容 OpenAI 的网关地址':'请填写完整的 http(s) 接口地址');
  if(preset.status==='gateway'){
    const host=new URL(target).hostname;
    if(preset.nativeHosts.some(domain=>host===domain||host.endsWith('.'+domain)))bad('此提供商的原生接口暂不能直连，请填写兼容 OpenAI 的网关地址');
  }
  // Environment credentials are referenced only at the exact preset endpoint,
  // never inherited by a manually supplied gateway or another account path.
  const fromEnv=preset.status==='ready'&&endpoint(official)===target&&usable(env[preset.apiKeyEnv]);
  return{baseUrl:target,displayName:preset.name,presetId:preset.id,...(fromEnv?{apiKeyFrom:preset.apiKeyEnv}:{})};
}
