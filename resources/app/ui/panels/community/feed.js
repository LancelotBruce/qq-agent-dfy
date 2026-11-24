import {request,notify,onLeave} from '../panel-client.js';
import {node,action} from '../catalog-view.js';
import {createQuotePost} from './quote-post.js';
import {createIcon} from '../icons.js';

const PAGE_SIZE=20;

export function mountCommunityFeed(host){
  let loaded=false,busy=false,ticket=0,page=1,items=[],stale=false,likesStale=false,disposed=false;
  const toolbar=node('div','','community-feed-toolbar'),search=node('input');
  search.type='search';search.placeholder='搜索语录或发布者';search.setAttribute('aria-label','搜索雷霆语录');
  const searchWrap=node('label','','community-feed-search');searchWrap.append(createIcon('search',{size:16}),search);
  const refresh=action('刷新',()=>load(true),'ghost');refresh.title='刷新雷霆语录';refresh.setAttribute('aria-label','刷新');refresh.replaceChildren(createIcon('refresh',{size:16}));toolbar.append(searchWrap,refresh);
  const status=node('p','','muted'),list=node('div','','community-feed-list'),info=node('div','','community-feed-info');status.setAttribute('role','status');list.setAttribute('aria-label','完整语录列表');
  const browse=node('div','','community-feed-browse'),sort=node('select');sort.setAttribute('aria-label','语录排序');
  for(const [value,label] of [['default','默认排序'],['likes','点赞最多']]){const option=node('option',label);option.value=value;sort.append(option);}
  let pageCount=1;
  const random=action('随机一页',()=>{if(pageCount<=1)return;const choice=1+Math.floor(Math.random()*(pageCount-1));page=choice>=page?choice+1:choice;render();toolbar.scrollIntoView({block:'start'});});random.title='随机跳转到其他页';
  const topPaging=node('nav','','community-feed-page-top'),paging=node('nav','','market-pagination community-feed-pagination'),pageChoices=node('div','','community-feed-page-choices'),topPosition=node('span');
  topPaging.setAttribute('aria-label','语录顶部翻页');paging.setAttribute('aria-label','语录底部翻页');
  function goPage(change,scroll=false){page+=change;render();if(scroll)toolbar.scrollIntoView({block:'start'});}
  const previous=action('上一页',()=>goPage(-1,true)),next=action('下一页',()=>goPage(1,true)),topPrevious=action('上一页',()=>goPage(-1)),topNext=action('下一页',()=>goPage(1));
  topPrevious.setAttribute('aria-label','上一页');topNext.setAttribute('aria-label','下一页');topPrevious.replaceChildren(node('span','‹'));topNext.replaceChildren(node('span','›'));
  topPosition.setAttribute('aria-live','polite');topPaging.append(topPrevious,topPosition,topNext);paging.append(previous,pageChoices,next);browse.append(random,sort,topPaging);info.append(status,browse);host.append(toolbar,info,list,paging);
  function renderPageChoices(pages){
    const focused=pageChoices.contains(document.activeElement),numbers=new Set([1,pages]),fragment=document.createDocumentFragment();
    for(let number=Math.max(1,page-3);number<=Math.min(pages,page+3);number++)numbers.add(number);
    function add(number){const button=action(String(number),()=>{page=number;render();toolbar.scrollIntoView({block:'start'});},'community-feed-page-number');button.dataset.page=String(number);button.setAttribute('aria-label',`第 ${number} 页`);button.title=number===1?'第一页':number===pages?'最后一页':`第 ${number} 页`;if(number===page)button.setAttribute('aria-current','page');fragment.append(button);}
    let last=0;
    for(const number of [...numbers].sort((a,b)=>a-b)){if(number-last===2)add(last+1);else if(last&&number-last>2){const gap=node('span','…','community-feed-page-gap');gap.setAttribute('aria-hidden','true');fragment.append(gap);}add(number);last=number;}
    pageChoices.replaceChildren(fragment);if(focused)pageChoices.querySelector('[aria-current=page]')?.focus({preventScroll:true});
  }
  function render(){
    if(disposed)return;
    const query=search.value.trim().toLocaleLowerCase(),rows=items.filter(item=>!query||[item.nickname,item.text,...(item.messages||[]).map(message=>message.text)].some(value=>String(value??'').toLocaleLowerCase().includes(query)));
    if(sort.value==='likes'){const count=item=>Number.isSafeInteger(item.likes)&&item.likes>=0?item.likes:-1;rows.sort((a,b)=>count(b)-count(a));}
    const pages=Math.max(1,Math.ceil(rows.length/PAGE_SIZE));pageCount=pages;page=Math.min(pages,Math.max(1,page));random.disabled=!loaded||pages<=1;sort.disabled=!loaded;list.replaceChildren();
    for(const item of rows.slice((page-1)*PAGE_SIZE,page*PAGE_SIZE))list.append(createQuotePost(item,{
      offline:stale,
      onLike:liked=>request('POST','/api/community/feed/like',{kind:'quotes',id:item.id,liked}),
      onReply:body=>request('POST','/api/community/feed/reply',{kind:'quotes',id:item.id,...body}),
      onNotify:notify,
    }));
    if(!rows.length)list.append(node('p',loaded?(query?'没有匹配的语录':'还没有语录'):'正在加载…','empty'));
    previous.disabled=topPrevious.disabled=page<=1;next.disabled=topNext.disabled=page>=pages;topPosition.textContent=page+' / '+pages;renderPageChoices(pages);paging.hidden=topPaging.hidden=rows.length<=PAGE_SIZE;
    if(loaded)status.textContent=(query?rows.length+' / ':'')+items.length+' 条语录'+(stale?' · 离线缓存':likesStale?' · 点赞数暂未刷新':'');
  }
  async function load(force=false){
    if(disposed)return;const current=++ticket;busy=true;refresh.disabled=true;status.textContent='正在读取雷霆语录…';
    try{const data=await request('GET','/api/community/feed',undefined,{kind:'quotes',...(force?{force:'1'}:{})});if(current!==ticket)return;if(data?.ok!==true||data.kind!=='quotes'||!Array.isArray(data.items))throw Error('语录响应格式异常');const reactions=new Map(items.map(item=>[item.id,item.liked===true]));items=data.items.map(item=>({...item,liked:reactions.get(item.id)??false,replies:[...(item.replies||[])]}));loaded=true;stale=data.stale===true;likesStale=data.likesStale===true;render();}
    catch(error){if(current===ticket){status.textContent=error.message;list.replaceChildren(node('p','语录服务暂不可用，可稍后刷新。','empty'));}}
    finally{if(current===ticket){busy=false;refresh.disabled=false;}}
  }
  search.addEventListener('input',()=>{page=1;render();});sort.addEventListener('change',()=>{page=1;render();});render();
  onLeave(()=>{disposed=true;++ticket;items=[];});
  return{open(){if(!disposed&&!loaded&&!busy)void load();},refresh:()=>load(true)};
}
