// 社区面板：登录后在账号页管理自己的作品。
// 全部动作走面板 RPC（后端按 manifest 白名单放行），UI 只负责收集参数与呈现结果。
import {createLiveRefresh} from '../live-refresh.js';
import { onShellEvent, request, authenticateMarket, cancelMarketAuthentication, onLeave, contentReady, notify } from '../panel-client.js';
import { $, clear, text, error, capability, confirmAction, button, bindDestructiveAction } from '../ui.js';
import {bindAuthoringGuide} from '../extension-authoring.js';
import {mountCommunityLibrary} from './library.js';
import {openWorkDialog} from '../work-dialog.js';
bindAuthoringGuide({parent:document.querySelector('main > header .actions')});

const meta = $('#meta');
let accounts = [];
let library=null;
let accountVersion=0,disposed=false,accountSignature='',accountsLoaded=false;
const authRoot=$('#account-auth'),authHome=document.createComment('community account form');authRoot.before(authHome);
let authDialog=null;

/* ---------- 账号 ---------- */
let selected = '';
let selectedAccountTarget = null;
let loggingOut = false;
const logout = document.createElement('button'); logout.type = 'button'; logout.textContent = '退出所选账号';
const logoutControl = bindDestructiveAction(logout, {
  clicks: 2, target: () => selectedAccountTarget, key: () => selected,
  canActivate: () => !loggingOut && !!selected && accounts.some(item => item.username === selected),
  impact: () => `移除账号 ${selected} 在本机保存的登录凭据，并尝试吊销登录令牌；社区账号仍然保留。`,
  action: async () => {
    const username = selected;
    loggingOut = true; renderAccounts();
    try { await request('POST', '/api/market/logout', { username }); await loadAccounts(); }
    finally { loggingOut = false; renderAccounts(); }
  },
});
function renderAccounts() {
  if(disposed)return;
  renderAccountContents();
  const host = $('#account-state');
  selectedAccountTarget = null;
  clear(host);
  logout.disabled = loggingOut || !selected || !accounts.some(item => item.username === selected);
  if (accounts.length === 0) {
    text(host, '未登录社区账号');
    return;
  }
  const wrap = document.createElement('div');
  wrap.className = 'actions';
  accounts.forEach((item) => {
    const account = document.createElement('div'); account.className = 'actions';
    const choose = button(item.username, async () => {
      if (loggingOut) return;
      if (selected !== item.username) logoutControl.reset();
      selected = item.username;
      renderAccounts();
      library?.accountChanged();
    }, item.username === selected ? 'primary' : '');
    choose.disabled = loggingOut;choose.setAttribute('aria-pressed',String(item.username===selected));account.append(choose);
    if (item.username === selected) selectedAccountTarget = account;
    wrap.append(account);
  });
  const add=button('添加账号',openLoginDialog);add.disabled=loggingOut||authenticating;add.setAttribute('aria-haspopup','dialog');wrap.append(add,logout);
  host.append(wrap);
}

function renderAccountContents(){
  const signedIn=accounts.some(item=>item.username===selected);
  authRoot.hidden=signedIn&&!authDialog;$('#account-works').hidden=!signedIn;$('#account-work-types').hidden=!signedIn;
  if(signedIn&&!authDialog)$('#login-password').value='';
}
function openLoginDialog(){
  if(loggingOut)return;if(authDialog&&!authDialog.closed){authDialog.dialog.focus();return;}
  const view=openWorkDialog({id:'community-account-login',name:'添加社区账号'},{metadata:false,onClosed(){
    if(authenticating&&!view.completed)void cancelMarketAuthentication().catch(()=>{});
    authDialog=null;authHome.after(authRoot);$('#login-password').value='';renderAccountContents();
  }});
  authDialog=view;view.dialog.classList.add('community-auth-dialog');view.body.append(authRoot);authRoot.hidden=false;
  for(const id of ['#login-id','#login-password','#login-name'])$(id).value='';text($('#login-note'),'');$('#login-id').focus();
}

async function loadAccounts() {
  const version=++accountVersion;
  const data = await capability(() => request('GET', '/api/market/accounts'), meta);
  if(disposed||version!==accountVersion)return null;
  if(!data){if(!accountsLoaded)text($('#account-state'),'暂时无法读取登录状态，请刷新重试');void contentReady();return null;}
  accountsLoaded=true;
  accounts = data.accounts ?? [];
  if (!selected || !accounts.some((a) => a.username === selected)) {
    logoutControl.reset(); selected = accounts[0]?.username ?? '';
  }
  const signature=JSON.stringify([accounts,selected,loggingOut]);if(signature!==accountSignature){accountSignature=signature;renderAccounts();}
  text(meta,`已登录 ${accounts.length} 个账号`);
  library?.accountChanged();
  void contentReady();
  return accounts;
}

let authenticating=false;
$('#login-cancel').addEventListener('click',async()=>{try{await cancelMarketAuthentication();}catch(e){error($('#login-note'),e.message||'无法取消登录等待');}});
onLeave(()=>authenticating?cancelMarketAuthentication():undefined);
async function authenticate(mode){
  if(authenticating)return;
  const payload = {
    loginId: $('#login-id').value.trim(),
    password: $('#login-password').value,
    displayName: $('#login-name').value.trim() || undefined,
    mode,
  };
  if(!payload.loginId||!payload.password){error($('#login-note'),'请填写社区账号和密码');return;}
  if(mode==='register'&&!payload.displayName){error($('#login-note'),'注册时请填写显示名称');return;}
  authenticating=true;$('#login').disabled=true;$('#register').disabled=true;
  try {
    if(mode==='register'&&!await confirmAction(`注册社区账号 ${payload.loginId}？\n\n账号用于发布与安装扩展，请勿复用重要密码。`))return;
    $('#login-cancel').hidden=false;text($('#login-note'),'等待人机验证与认证结果…');
    const result=await authenticateMarket(payload);
    if(disposed)return;
    if(result.account?.username&&selected!==result.account.username){logoutControl.reset();selected=result.account.username;}
    if($('#login-password').value===payload.password)$('#login-password').value = '';
    await loadAccounts();
    if(disposed)return;
    if(authDialog){authDialog.completed=true;authDialog.close();}
    text($('#login-note'),mode==='register'?'注册成功':'登录成功');
    void notify(mode==='register'?'注册成功':'登录成功');
  } catch (e) { error($('#login-note'), e.message || '社区认证失败'); }
  finally{authenticating=false;$('#login').disabled=false;$('#register').disabled=false;$('#login-cancel').hidden=true;renderAccounts();}
}
$('#login').addEventListener('click',()=>authenticate('login'));
$('#register').addEventListener('click',()=>authenticate('register'));

const live=createLiveRefresh(()=>loadAccounts());
onShellEvent((name,payload)=>{if(name==='community-view'&&['works','account','feed','browser'].includes(payload?.tab))library?.select(payload.tab);if(name==='hello'||name==='status'&&payload?.communityAccountsUpdated)live.request();if(name==='status'&&payload?.communityWorksUpdated)void library?.refresh();});
onLeave(() => {disposed=true;++accountVersion;live.dispose();logoutControl.dispose();});
$('#refresh').addEventListener('click',()=>{void loadAccounts();void library?.refresh();});
library=mountCommunityLibrary({getAccount:()=>selected});

/* ---------- 启动 ---------- */
(async () => {
  const list = await loadAccounts();
  text(meta, list === null ? '环境未提供社区能力' : `社区就绪 · 已登录 ${accounts.length} 个账号`);
})().catch((e) => {if(!disposed){error(meta, e.message || '加载失败');void contentReady();}});
