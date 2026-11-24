import {parse} from 'parse5';

const SKIP_TEXT=new Set(['script','style','noscript','template']);
const STOP_WORDS=new Set('a an the and or not of to in on for with is are how what why official documentation docs document reference tutorial guide example examples latest version query search searches searching result results vs versus http https www'.split(' '));
const attr=(node,name)=>node?.attrs?.find(item=>item.name===name)?.value??'';
const hasClass=(node,name)=>attr(node,'class').split(/\s+/).includes(name);
const clean=value=>String(value??'').replace(/\s+/gu,' ').trim();
function* elements(root){
  const stack=[root];let count=0;
  while(stack.length&&++count<=100000){
    const node=stack.pop();if(node?.tagName)yield node;
    if(SKIP_TEXT.has(node?.tagName))continue;
    const children=node?.childNodes??[];for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
  }
}
function textOf(root){
  const stack=[root],parts=[];let size=0;
  while(stack.length&&size<16000){
    const node=stack.pop();if(SKIP_TEXT.has(node?.tagName))continue;
    if(node?.nodeName==='#text'){parts.push(node.value);size+=node.value.length;continue;}
    if(/^(?:br|p|div|li|h[1-6]|tr)$/.test(node?.tagName??''))parts.push(' ');
    const children=node?.childNodes??[];for(let i=children.length-1;i>=0;i--)stack.push(children[i]);
  }
  return clean(parts.join(''));
}
const bingHost=host=>host==='bing.com'||host.endsWith('.bing.com');
export function normalizeBingResultUrl(value,baseUrl='https://cn.bing.com/search'){
  let url;try{url=new URL(String(value??'').trim(),baseUrl);}catch{return null;}
  if(bingHost(url.hostname)&&url.pathname==='/ck/a'){
    let target=url.searchParams.get('u')??'';
    if(target.startsWith('a1')){
      const encoded=target.slice(2);if(encoded.length>8192||!/^[-\w]+={0,2}$/.test(encoded))return null;
      try{target=Buffer.from(encoded,'base64url').toString('utf8');}catch{return null;}
    }
    try{url=new URL(target);}catch{return null;}
  }
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
  if(bingHost(url.hostname)&&/^\/(?:ck\/a|aclick|search|images\/search|videos\/search|account)(?:\/|$)/.test(url.pathname))return null;
  for(const key of [...url.searchParams.keys()])if(/^utm_/i.test(key)||/^(?:gclid|fbclid|msclkid)$/i.test(key))url.searchParams.delete(key);
  return url.href;
}
function resultKey(value){const url=new URL(value);url.hash='';url.searchParams.sort();return url.href;}

// A real HTML tree keeps nested lists, neighbouring results and entities apart.
// Parsing is inert: scripts, styles and templates are never executed or quoted.
export function readBingPage(html,{limit=20,baseUrl='https://cn.bing.com/search'}={}){
  const root=parse(String(html)),nodes=[...elements(root)],results=[],seen=new Set();
  const blocked=nodes.some(node=>/^(?:b_captcha|b_captcha_frame|challenge-form)$/.test(attr(node,'id'))||hasClass(node,'b_captcha'))
    ||/\/(?:turing\/captcha|captcha|challenge)\b/i.test(new URL(baseUrl).pathname);
  if(blocked)return{results,status:'blocked'};
  for(const node of nodes){
    if(!hasClass(node,'b_algo')||hasClass(node,'b_ad'))continue;
    const children=[...elements(node)],heading=children.find(item=>item.tagName==='h2');
    const anchor=heading&&[...elements(heading)].find(item=>item.tagName==='a'&&attr(item,'href'));
    const url=anchor&&normalizeBingResultUrl(attr(anchor,'href'),baseUrl),title=anchor&&textOf(anchor).slice(0,320);
    if(!url||!title||seen.has(resultKey(url)))continue;
    const caption=children.find(item=>hasClass(item,'b_caption'));
    const paragraphs=[...elements(caption??node)].filter(item=>item.tagName==='p');
    const snippet=clean(paragraphs.map(textOf).filter(Boolean).join(' ')).slice(0,700);
    results.push({title,url,snippet});seen.add(resultKey(url));
    if(results.length>=Math.max(1,Math.min(50,Number(limit)||20)))break;
  }
  if(results.length)return{results,status:'ok'};
  const body=nodes.find(node=>node.tagName==='body')??root,bodyText=textOf(body);
  const empty=nodes.some(node=>hasClass(node,'b_no')||attr(node,'id')==='b_no')
    ||/^(?:no results|没有搜到结果)\s*[.!。]?$/i.test(bodyText)
    ||/there are no results for|no results found for|未找到.*相关.*结果|没有与.{0,100}相关的结果/i.test(bodyText);
  return{results,status:empty?'empty':'unexpected'};
}
export function parseBingHtml(html,limit=6,options={}){return readBingPage(html,{...options,limit}).results;}

function queryParts(query){
  const tokens=String(query).match(/"[^"]*"|\S+/g)??[],positive=[],negative=[];
  const complex=tokens.some(token=>/^(?:OR|NOT)$/i.test(token)||/[()]/.test(token));
  if(!complex)for(const token of tokens){
    const match=/^(-?)site:(.+)$/i.exec(token);if(!match)continue;
    try{
      const target=new URL(/^https?:\/\//i.test(match[2])?match[2]:'https://'+match[2]);
      if(target.username||target.password||!target.hostname||target.search||target.hash)continue;
      (match[1]?negative:positive).push({host:target.hostname,path:target.pathname});
    }catch{}
  }
  // Enforce only unambiguous simple filters; complex expressions stay intact
  // for Bing rather than being silently reinterpreted as a different query.
  const site=positive.length===1?positive[0]:null;
  const words=tokens.filter(token=>!/^[-]|^[a-z]+:|^(?:AND|OR|NOT)$/i.test(token));
  const terms=[...new Map(words.flatMap(word=>[...word.matchAll(/[a-z][a-z\d_.+#-]{2,}/gi)].map(match=>[match[0].toLowerCase(),match[0]]))
    .filter(([key])=>!STOP_WORDS.has(key))).values()];
  return{tokens,site,negative,terms,complex:complex||tokens.some(token=>/["()]|^(?:AND|NOT|OR|NEAR|vs\.?|versus)$/i.test(token))};
}
function siteMatches(value,site){
  const url=new URL(value);if(url.hostname!==site.host&&!url.hostname.endsWith('.'+site.host))return false;
  return site.path==='/'||url.pathname.startsWith(site.path);
}
const resultText=row=>{let url=row.url;try{url=decodeURIComponent(url);}catch{}return clean(`${row.title} ${url} ${row.snippet}`).normalize('NFKC').toLowerCase();};
export function selectBingResults(rows,query,limit=6){
  const parts=queryParts(query),seen=new Set(),accepted=[];
  for(const row of rows){
    if(parts.site&&!siteMatches(row.url,parts.site)||parts.negative.some(site=>siteMatches(row.url,site)))continue;
    const key=resultKey(row.url);if(seen.has(key))continue;seen.add(key);
    const text=resultText(row),coverage=parts.terms.filter(term=>text.includes(term.toLowerCase())).length;
    accepted.push({row,index:accepted.length,coverage});
  }
  accepted.sort((a,b)=>b.coverage-a.coverage||a.index-b.index);
  return accepted.slice(0,limit).map(item=>item.row);
}
export function focusedBingQuery(query,rows){
  const parts=queryParts(query);if(parts.complex)return null;
  if(parts.site&&!rows.some(row=>siteMatches(row.url,parts.site))&&!parts.tokens[0]?.startsWith(parts.site.host))return`${parts.site.host} ${query}`;
  const missing=parts.terms.filter(term=>!rows.some(row=>resultText(row).includes(term.toLowerCase())));
  const anchor=missing.sort((a,b)=>(/[a-z][A-Z]|[._]/.test(b)?1:0)-(/[a-z][A-Z]|[._]/.test(a)?1:0)||b.length-a.length)[0];
  if(!anchor)return null;
  const index=parts.tokens.findIndex(token=>token.replace(/^\+/,'').toLowerCase()===anchor.toLowerCase());
  if(index<=0)return null;
  const tokens=[...parts.tokens],first=tokens.splice(index,1)[0];return[first,...tokens].join(' ');
}

export async function searchBing(query,{searchUrl,limit=6,timeoutMs=20000,signal,request,network={}}){
  const q=String(query??'').trim();if(!q)throw Error('搜索关键词不能为空');
  const deadline=AbortSignal.timeout(timeoutMs),combined=signal?AbortSignal.any([signal,deadline]):deadline;
  const count=Math.min(20,Math.max(10,limit*2)),queries=[],rows=[];let partialFailure='',truncated=false;
  async function retrieve(term){
    if(combined.aborted)throw combined.reason;
    const url=new URL(searchUrl||'https://cn.bing.com/search');
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Bing 地址必须为不含账号密码的 HTTP(S) 地址');
    url.searchParams.set('q',term);url.searchParams.set('count',String(count));
    queries.push(term);
    const result=await request(url.href,{...network,signal:combined,timeoutMs,maxBytes:2*1024*1024,headers:{accept:'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'}});
    if(result.status>=400)throw Error('Bing 搜索失败：HTTP '+result.status);
    const page=readBingPage(result.body,{limit:count,baseUrl:result.finalUrl||url.href});
    if(page.status==='blocked')throw Error('Bing 要求验证，当前页面不是搜索结果；请稍后重试或使用其他搜索源');
    if(page.status==='unexpected')throw Error(result.truncated?'Bing 页面被截断，未能读取完整搜索结果':'Bing 返回了无法识别的页面，不能按“没有结果”处理');
    truncated ||=result.truncated===true;return page;
  }
  const first=await retrieve(q);rows.push(...first.results);
  const focused=first.status==='ok'?focusedBingQuery(q,first.results):null;
  if(focused&&focused!==q){
    try{rows.push(...(await retrieve(focused)).results);}
    catch(error){
      if(combined.aborted||/验证|白名单|内网|授权|权限|实例|停止|中止/.test(String(error.message)))throw error;
      partialFailure='补充检索暂时失败，以下保留首次检索结果。';
    }
  }
  if(combined.aborted)throw combined.reason;
  const results=selectBingResults(rows,q,limit),parts=queryParts(q),notes=[];
  if(!results.length)notes.push(parts.site?'Bing 未返回符合指定站点的结果；没有用站外结果替代。':'没有搜到结果，试试更具体的关键词。');
  else{
    const missing=parts.terms.filter(term=>!results.some(row=>resultText(row).includes(term.toLowerCase())));
    if(missing.length)notes.push('结果尚未覆盖关键词：'+missing.join('、')+'；引用前请打开网页核对。');
  }
  if(partialFailure)notes.push(partialFailure);
  if(truncated)notes.push('搜索页面达到大小上限，结果可能不完整。');
  return{query:q,results,...(queries.length>1?{searchQueries:queries}:{}),...(truncated?{truncated:true}:{}),...(notes.length?{note:notes.join(' ')}:{})};
}
