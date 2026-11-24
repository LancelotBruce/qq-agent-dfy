// Resolve only prerequisites with a known settings control. Runtime errors and
// extension guards keep their actual reason rather than guessing a repair.
export function toolAvailabilityTarget(tool,state,read){
  if(!state||state.enabled)return null;
  const field=(path,label,section='tools')=>({section,selector:`[data-path="${path}"]`,label});
  if(state.code==='tools-disabled')return field('tools.enabled','模型使用工具');
  if(state.code==='category-disabled'){
    const names={messaging:'消息',sticker:'表情',query:'查询',memory:'记忆',web:'联网',knowledge:'知识库',media:'媒体',system:'系统'};
    if(Object.hasOwn(names,tool.category))return field(`tools.categories.${tool.category}`,`${names[tool.category]}类工具`);
  }
  if(state.code==='tool-disabled'&&tool.id==='send_to'){
    const override=read('tools.overrides')?.[tool.id];
    // The per-tool override is checked before the separate cross-chat gate.
    if(override!==false&&(override!==undefined||tool.defaultEnabled!==false)&&read('tools.crossChatSend')!==true)
      return field('tools.crossChatSend','跨会话发言');
  }
  if(state.code==='no-search')return{section:'search',selector:'.search-enabled-toggle',label:'联网搜索'};
  if(state.code==='no-vision'&&read('api.vision')===false)return{section:'models',selector:'[data-model-media="vision"]',label:'图片输入'};
  return null;
}
