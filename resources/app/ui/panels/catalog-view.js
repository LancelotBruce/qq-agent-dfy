import {createIcon} from './icons.js';

export const workName=item=>item.name||item.title||item.id;
export const workState=item=>({approved:'已通过',pending:'审核中',rejected:'未通过'}[item.status]||'待确认');
export const workDate=value=>{const time=new Date(value);return Number.isFinite(time.getTime())?time.toLocaleDateString('zh-CN'):'—';};
export function node(tag,value='',className=''){const el=document.createElement(tag);el.className=className;if(value!==undefined)el.textContent=String(value);return el;}
export function action(label,run,className=''){const el=node('button',label,className);el.type='button';el.addEventListener('click',run);return el;}
export function compareVersion(a,b){const parse=value=>/^(\d+)\.(\d+)\.(\d+)(?:[-+]([A-Za-z0-9.-]+))?$/.exec(String(value??'').replace(/^v/,''));const x=parse(a),y=parse(b);if(!x||!y)return null;for(let i=1;i<=3;i++)if(+x[i]!==+y[i])return +x[i]>+y[i]?1:-1;return x[4]===y[4]?0:!x[4]?1:!y[4]?-1:x[4].localeCompare(y[4]);}

// Bounded rendering keeps a large public catalog inexpensive. Toolbars and
// pagination controls retain their DOM/focus while cards change.
export function createCatalogView({host,kind='persona',onOpen,actions=()=>[],onAuthor,empty='暂时没有作品',compact=false}={}){
  const label={persona:'人设',plugin:'插件',skill:'技能'}[kind]||'作品';
  let data={items:[],categories:{}},page=1,owner='',disposed=false;
  const toolbar=node('div','','market-toolbar');
  const search=node('input');search.type='search';search.id='market-search';search.placeholder='搜索名称、简介或作者';search.setAttribute('aria-label',`搜索在线${label}`);
  const category=node('select');category.id='market-category';category.setAttribute('aria-label',`${label}分类`);
  const sort=node('select');sort.id='market-sort';sort.setAttribute('aria-label','作品排序');
  for(const[value,text]of [['updated','最近更新'],['downloads','下载最多'],['name','名称排序']]){if(kind==='persona'&&value==='downloads')continue;const option=node('option',text);option.value=value;sort.append(option);}
  const refresh=action('刷新目录',()=>{});refresh.id='market-refresh';refresh.replaceChildren(createIcon('refresh',{size:16}));refresh.title='刷新目录';refresh.setAttribute('aria-label','刷新目录');
  const status=node('p','','market-feedback');status.id='market-status';status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const feedback=node('p','','market-feedback');feedback.id='market-install-status';feedback.setAttribute('role','status');
  const ownerChip=action('',()=>{owner='';page=1;render();},'market-owner-filter');ownerChip.hidden=true;
  const list=node('div','','market-results');list.id='market-results';
  const paging=node('nav','','market-pagination');paging.setAttribute('aria-label','作品分页');
  const previous=action('上一页',()=>{page--;render(true);}),next=action('下一页',()=>{page++;render(true);}),position=node('span');position.setAttribute('aria-live','polite');
  paging.append(previous,position,next);toolbar.append(search,category,sort,refresh);if(!compact)host.append(toolbar,ownerChip,status);host.append(feedback,list,paging);
  function render(focus=false){
    if(disposed)return;const query=search.value.trim().toLocaleLowerCase();
    const rows=data.items.filter(item=>(!owner||item.authorId===owner)&&(!category.value||item.category===category.value)&&(!query||[workName(item),item.id,item.description,item.author].some(value=>String(value??'').toLocaleLowerCase().includes(query))))
      .sort((a,b)=>sort.value==='name'?workName(a).localeCompare(workName(b),'zh-CN'):sort.value==='downloads'?(b.downloads||0)-(a.downloads||0):String(b.updatedAt||b.createdAt||'').localeCompare(String(a.updatedAt||a.createdAt||'')));
    const pages=Math.max(1,Math.ceil(rows.length/24));page=Math.min(pages,Math.max(1,page));
    status.className=data.stale?'market-feedback warning':'market-feedback muted';
    status.textContent=`${rows.length} 项${label}${data.stale?' · 离线缓存':data.cached?' · 本地缓存':''}${data.stale&&data.fetchedAt?' · '+workDate(data.fetchedAt):''}`;
    ownerChip.hidden=!owner;if(owner)ownerChip.textContent=`${data.items.find(item=>item.authorId===owner)?.author||'作者'}的作品 ×`;
    list.replaceChildren();
    for(const item of rows.slice((page-1)*24,page*24)){
      const card=node('article','','market-card');card.dataset.marketId=item.id;
      const open=action('',()=>onOpen?.(item),'market-card-main');open.setAttribute('aria-label',`查看${label} ${workName(item)}`);
      const head=node('div','','market-card-head'),badge=node('span',workState(item),'market-state');badge.dataset.state=item.status;
      head.append(node('span',item.categoryName||data.categories?.[item.category]||item.category||'其他','market-category-label'),badge);
      const title=node('h3',workName(item)),description=node('p',item.description||'暂无简介','market-description');
      const details=node('div','','market-card-meta');details.append(node('span',kind==='persona'?`${item.promptLength||0} 字`:`v${item.version||'未声明'}`),node('span',workDate(item.updatedAt||item.createdAt)));
      open.append(head,title,description,details);
      const footer=node('div','','market-card-footer');const author=action(item.author||'未署名',()=>{if(onAuthor)onAuthor(item);else{owner=item.authorId||'';page=1;render();}},'market-author');author.disabled=!item.authorId||(compact&&!onAuthor);
      const buttons=node('div','','actions');for(const button of actions(item)||[])buttons.append(button);footer.append(author,buttons);card.append(open,footer);list.append(card);
    }
    if(!rows.length)list.append(node('p',data.items.length?'没有匹配的作品，试试其他关键词。':empty,'empty'));
    previous.disabled=page<=1;next.disabled=page>=pages;position.textContent=`${page} / ${pages}`;paging.hidden=rows.length<=24;
    if(focus)list.querySelector('button')?.focus();
  }
  function setData(value){
    const categories=value?.categories||{};
    data={...value,items:(Array.isArray(value?.items)?value.items:[]).map(item=>({...item,categoryName:Object.hasOwn(categories,item.category)?categories[item.category]:item.categoryName})),categories};
    const selected=category.value;category.replaceChildren();const all=node('option','全部分类');all.value='';category.append(all);
    const cats=Object.assign(Object.create(null),data.categories);for(const item of data.items)if(item.category&&!Object.hasOwn(cats,item.category))cats[item.category]=item.categoryName||item.category;
    for(const[key,title]of Object.entries(cats)){const option=node('option',title);option.value=key;category.append(option);}category.value=[...category.options].some(option=>option.value===selected)?selected:'';render();
  }
  for(const field of [search,category,sort])field.addEventListener(field===search?'input':'change',()=>{page=1;render();});
  setData(data);
  return{host,list,search,category,sort,refresh,status,feedback,setData,render,setBusy(value){refresh.disabled=value;list.setAttribute('aria-busy',String(value));if(value&&!data.fetchedAt&&!data.items.length)status.textContent='正在加载在线目录…';},message(value,failed=false){feedback.textContent=value;feedback.className=failed?'market-feedback error':'market-feedback muted';},dispose(){disposed=true;},get data(){return data;}};
}
