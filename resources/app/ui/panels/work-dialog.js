import {installDisposableDialog} from './dialog-lifecycle.js';
import {node,action,workName,workState,workDate} from './catalog-view.js';
import {onLeave} from './panel-client.js';

export function openWorkDialog(item,{kind=item.type,onClosed,metadata=true}={}){
  const dialog=node('dialog','','work-dialog');dialog.setAttribute('aria-label',workName(item));
  const heading=node('div','','dialog-head work-dialog-head'),title=node('h3',workName(item));const close=action('关闭',()=>dialog.close(),'ghost');heading.append(title,close);
  const body=node('div','','work-dialog-body'),status=node('p','','muted');status.setAttribute('role','status');
  const description=item.description||(metadata?'暂无简介':''),summary=node('p',description,'work-description');
  const meta=node('dl','','work-metadata');
  for(const[label,value]of [['作者',item.author||'未署名'],['分类',item.categoryName||item.category||'其他'],['状态',workState(item)],['更新',workDate(item.updatedAt||item.createdAt)],...(kind==='persona'?[]:[['版本',item.version||'未声明']])]){const row=node('div');row.append(node('dt',label),node('dd',value));meta.append(row);}
  if(description.length>360){const more=node('details','','work-description-more');more.append(node('summary','作品简介'),summary);body.append(more);}else if(description)body.append(summary);if(metadata)body.append(meta);if(item.reviewNote)body.append(node('p','审核意见：'+item.reviewNote,'warning'));
  if(metadata){const details=node('details'),label=node('summary','作品标识');details.append(label,node('code',item.id));body.append(details);}
  const actions=node('div','','actions work-dialog-actions');dialog.append(heading,body,status,actions);
  let closed=false,unleave=()=>{};const life=installDisposableDialog(dialog,{dismissOnBackdrop:true,onClosed(){closed=true;unleave();onClosed?.();}});unleave=onLeave(()=>life.close());document.body.append(dialog);dialog.showModal();
  return{dialog,body,status,actions,close:()=>life.close(),get closed(){return closed;}};
}
