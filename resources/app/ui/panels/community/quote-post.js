import {node,action,workDate} from '../catalog-view.js';
import {installDisposableDialog} from '../dialog-lifecycle.js';
import {onLeave} from '../panel-client.js';

function openImage(src){
  const dialog=node('dialog','','quote-image-viewer'),head=node('div','','dialog-head'),image=node('img');dialog.setAttribute('aria-label','语录图片');
  head.append(node('h3','图片预览'),action('关闭',()=>dialog.close(),'ghost'));image.src=src;image.alt='语录原图';image.referrerPolicy='no-referrer';dialog.append(head,image);
  let unleave=()=>{};const life=installDisposableDialog(dialog,{dismissOnBackdrop:true,onClosed:()=>unleave()});unleave=onLeave(()=>life.close());document.body.append(dialog);dialog.showModal();
}

function imageSource(value){
  if(typeof value!=='string')return null;
  if(/^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/]+=*$/.test(value)&&value.length<1400000)return value;
  try{const url=new URL(value);return url.protocol==='https:'&&['kondius.cn','www.kondius.cn'].includes(url.hostname)&&!url.username&&!url.password&&!url.search&&!url.hash&&/^\/qq-agent\/(comment|holyshits)\/images\/[A-Za-z0-9_-]+\.(png|jpe?g|gif|webp)$/.test(url.pathname)?url.href:null;}catch{return null;}
}
function appendImages(host,values,seen,remaining=false){
  const sources=(values||[]).map(imageSource).filter(Boolean).filter(src=>!remaining||!seen.has(src));if(!sources.length)return;
  const gallery=node('div','','quote-images');
  for(const src of sources){seen.add(src);const figure=node('figure'),img=node('img'),error=node('figcaption','图片暂不可用','muted'),open=action('',()=>openImage(src),'quote-image-open');open.setAttribute('aria-label','放大查看图片');open.title='放大查看图片';img.src=src;img.alt='语录中的图片';img.loading='lazy';img.decoding='async';img.referrerPolicy='no-referrer';error.hidden=true;img.addEventListener('error',()=>{open.hidden=true;error.hidden=false;},{once:true});open.append(img);figure.append(open,error);gallery.append(figure);}
  host.append(gallery);
}

export function createQuotePost(item,{offline=false,onLike,onReply,onNotify=()=>{}}={}){
  const nickname=item.nickname||'匿名',post=node('article','','quote-post');post.dataset.feedId=item.id;
  const titleId='quote-author-'+String(item.id).replace(/[^\w-]/g,'_');post.setAttribute('aria-labelledby',titleId);
  const head=node('header','','quote-post-head'),avatar=node('span',Array.from(nickname)[0]||'·','quote-avatar');avatar.setAttribute('aria-hidden','true');
  const author=node('strong',nickname,'quote-author');author.id=titleId;const date=node('time',item.createdAt?workDate(item.createdAt):'—','quote-date');
  if(item.createdAt){const value=new Date(item.createdAt);if(Number.isFinite(value.getTime())){date.dateTime=value.toISOString();date.title=value.toLocaleString('zh-CN');}}
  head.append(avatar,author,date);post.append(head);
  const body=node('div','','quote-post-body'),seenImages=new Set();if(item.text)body.append(node('p',item.text,'quote-text'));
  const transcript=node('div','','quote-transcript');
  for(const message of item.messages||[]){
    const row=node('div','','quote-message'),content=node('div','','quote-message-content');row.dataset.self=String(message.self===true);
    if(message.text)content.append(node('p',message.text,'quote-text'));
    appendImages(content,message.images,seenImages);
    if(!content.childElementCount)content.append(node('p','［图片暂不可用］','quote-text muted'));
    row.append(node('strong',message.senderName||'发言者','quote-speaker'),content);transcript.append(row);
  }
  if(transcript.childElementCount)body.append(transcript);appendImages(body,item.images,seenImages,true);post.append(body);
  const footer=node('footer','','quote-post-actions'),status=node('p','','quote-post-status');status.setAttribute('role','status');
  let liked=item.liked===true,likes=Number.isSafeInteger(item.likes)&&item.likes>=0?item.likes:null,form=null,replies=null,replyCount=0;const alive=()=>post.isConnected;
  const likeLabel=node('span'),likeNumber=node('span','','quote-like-count'),replyNumber=node('span','','quote-comment-count');
  function paintCounts(){likeLabel.textContent=liked?'已赞':'赞';likeNumber.textContent=likes===null?'—':String(likes);like.setAttribute('aria-pressed',String(liked));like.setAttribute('aria-description',likes===null?'点赞数量暂不可用':likes+' 个赞');like.title=liked?'取消点赞':'点赞';replyNumber.textContent=String(replyCount);reply.setAttribute('aria-description',replyCount+' 条评论');}
  function addReply(value){if(!replies){replies=node('section','','quote-replies');replies.setAttribute('aria-label','评论列表');replies.append(node('h4','评论'));footer.after(replies);}const row=node('p','','quote-existing-reply');row.append(node('strong',value.nickname||'匿名'),node('span',value.text||''));replies.append(row);++replyCount;}
  const like=action('',async()=>{like.disabled=true;try{const result=await onLike(!liked);if(result?.ok!==true)throw Error('点赞结果未确认');liked=!liked;likes=Number.isSafeInteger(result.count)&&result.count>=0?result.count:likes===null?null:Math.max(0,likes+(liked?1:-1));item.liked=liked;item.likes=likes;if(!alive())return;paintCounts();status.textContent='';}catch(error){if(alive())status.textContent=error.message;}finally{like.disabled=offline;}});like.classList.add('ghost');like.setAttribute('aria-label','点赞');like.disabled=offline;like.append(likeLabel,likeNumber);
  const reply=action('',()=>{
    if(form){form.querySelector('textarea').focus();return;}
    form=node('div','','quote-reply-form');form.setAttribute('role','group');form.setAttribute('aria-label','评论语录');
    const name=node('input'),text=node('textarea'),actions=node('div','','actions');name.placeholder='昵称';name.maxLength=32;name.required=true;name.setAttribute('aria-label','评论昵称');text.placeholder='写一条评论';text.maxLength=500;text.required=true;text.rows=3;text.setAttribute('aria-label','评论内容');
    const send=action('发送评论',async()=>{
      if(!name.value.trim()||!text.value.trim()){status.textContent='请填写昵称和评论内容';return;}if(!name.reportValidity()||!text.reportValidity())return;
      send.disabled=true;cancel.disabled=true;
      try{const result=await onReply({nickname:name.value.trim(),text:text.value.trim()});if(result?.ok!==true)throw Error('评论结果未确认');const value=result.reply??{nickname:name.value.trim(),text:text.value.trim()};(item.replies??=[]).push(value);if(!alive())return;addReply(value);paintCounts();form.remove();form=null;reply.setAttribute('aria-expanded','false');status.textContent='评论已提交';await onNotify('评论已提交');}
      catch(error){if(alive())status.textContent=error.message;}
      finally{send.disabled=false;cancel.disabled=false;}
    },'primary');
    const cancel=action('取消',()=>{form.remove();form=null;reply.setAttribute('aria-expanded','false');reply.focus();},'ghost');actions.append(send,cancel);form.append(name,text,actions);post.append(form);reply.setAttribute('aria-expanded','true');name.focus();
  },'ghost');reply.setAttribute('aria-label','评论');reply.setAttribute('aria-expanded','false');reply.title='写评论';reply.disabled=offline;reply.append(node('span','评论'),replyNumber);footer.append(like,reply,status);post.append(footer);for(const value of item.replies||[])addReply(value);paintCounts();return post;
}
