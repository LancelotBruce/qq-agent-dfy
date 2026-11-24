export function registerDesktopBrowser(http,{desktopBrowser}={}){
  http.route('GET','/api/console/browser',()=>({available:desktopBrowser?.available?.()===true}));
  http.route('POST','/api/console/browser',async({body})=>{
    if(!body||Object.keys(body).some(key=>key!=='target')||body.target!=='author')throw Object.assign(Error('不支持的浏览器入口'),{expose:true,status:400});
    if(desktopBrowser?.available?.()!==true)throw Object.assign(Error('内置浏览器需要在 QQA 桌面客户端运行时使用'),{expose:true,status:503});
    return desktopBrowser.open();
  });
}
