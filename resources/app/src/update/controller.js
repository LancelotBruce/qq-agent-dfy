import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { safeFetch } from '../kernel/safe-fetch.js';
import { verifyUpdateManifest } from './manifest.js';
import { assertOrdinaryDirectory, programUnits, within, updateHome } from './layout.js';

const fail = (message, status = 409) => Object.assign(new Error(message), { status, expose: true });
const terminal = new Set(['complete', 'rolledBack', 'error', 'cancelled', 'rollbackFailed']);
const powershell = () => path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
function atomic(file, value) { const temp = file + '.' + crypto.randomUUID() + '.tmp'; fs.writeFileSync(temp, JSON.stringify(value), { flag: 'wx', mode: 0o600 }); fs.renameSync(temp, file); }
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function runStage(helper, jobFile, signal, action='Stage') {
  return new Promise((resolve, reject) => {
    const log = fs.openSync(path.join(path.dirname(jobFile), 'stage.log'), 'a', 0o600);
    const child = spawn(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action, '-Job', jobFile], { windowsHide: true, stdio: ['ignore', 'ignore', log] });
    let logClosed=false;const closeLog=()=>{if(!logClosed){logClosed=true;fs.closeSync(log);}};
    const abort = () => child.kill(); signal.addEventListener('abort', abort, { once: true });
    child.once('error', error=>{closeLog();reject(error);}); child.once('exit', code => { closeLog();signal.removeEventListener('abort', abort); code === 0 && !signal.aborted ? resolve() : reject(fail(read(path.join(path.dirname(jobFile), 'state.json'))?.error || '更新包准备失败，请查看更新暂存目录中的 stage.log')); });
  });
}
async function launchHelper(helper, jobFile) {
  const log=fs.openSync(path.join(path.dirname(jobFile),'launch.log'),'a',0o600);
  try{
    const child=spawn(powershell(),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',helper,'-Action','Launch','-Job',jobFile],{windowsHide:true,stdio:['ignore',log,log]});
    await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',code=>code===0?resolve():reject(fail('更新助手启动失败')));});
    const receipt=read(path.join(path.dirname(jobFile),'launch.json'));
    if(!Number.isSafeInteger(receipt?.pid)||receipt.pid<1||receipt.nonce!==read(jobFile)?.nonce)throw fail('更新助手未返回匹配的进程凭据');return receipt.pid;
  }finally{fs.closeSync(log);}
}

export function createAppUpdateController({ appRoot, dataDir, extensionRoot = appRoot, env = process.env, version, readRelease,
  runtime = null, publish = () => {}, fetchImpl, dnsLookup, now = Date.now, stage = runStage, launch = launchHelper } = {}) {
  const platform = runtime?.platform ?? process.platform, arch = runtime?.arch ?? process.arch;
  const kind = runtime?.kind ?? 'source', installRoot = path.resolve(runtime?.installRoot ?? appRoot);
  const home = path.resolve(runtime?.updateHome ?? updateHome(installRoot,env));
  const lock = path.join(home, 'update.lock'), last = path.join(home, 'last.json');
  let publicKey = '', supported = true, reason = '', offer = null, closed = false, flight = null, checking = null, cancelController = null, handoff = false;
  const phase = () => { const id = read(last)?.id; return typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id) ? read(path.join(home, id, 'state.json')) : null; };
  try {
    if (platform !== 'win32') throw Error('自动安装目前支持 Windows 客户端');
    if (!runtime?.shutdown || !runtime?.restart?.exe) throw Error('请使用 QQA 正式启动入口以启用自动安装');
    if (!['source','desktop'].includes(kind) || !path.isAbsolute(runtime.restart.exe) || !fs.statSync(runtime.restart.exe).isFile()) throw Error('更新后的启动程序无效');
    assertOrdinaryDirectory(installRoot); assertOrdinaryDirectory(home, { exists: false });
    if (within(home, installRoot) || within(installRoot, home)) throw Error('更新暂存目录必须与安装目录分开');
    if (fs.existsSync(path.join(appRoot, '.git')) || fs.existsSync(path.join(installRoot, '.git'))) throw Error('当前为 Git 开发目录，请使用发行版进行自动更新');
    if (kind === 'source' && within(runtime.restart.exe, installRoot)) throw Error('源码客户端需要使用安装目录之外的 Node.js 运行时');
    for (const protectedRoot of [dataDir, env.QQ_AGENT_PROTOCOL_DIR || path.join(kind === 'desktop' ? installRoot : appRoot, 'protocols'),
      ...['plugins', 'skills', 'overrides'].map(name => path.join(extensionRoot, name))]) {
      assertOrdinaryDirectory(protectedRoot, { exists: false });
      if (within(protectedRoot, home) || within(home, protectedRoot)) throw Error('用户数据与更新暂存目录重叠');
      if (programUnits(kind).some(unit => within(protectedRoot, path.join(installRoot, unit))) || within(installRoot, protectedRoot)) throw Error('用户数据目录与程序文件重叠，不能自动替换');
    }
    publicKey = fs.readFileSync(path.join(appRoot, 'assets', 'update-public-key.pem'), 'utf8');
    if (crypto.createPublicKey(publicKey).asymmetricKeyType !== 'ed25519') throw Error('更新签名公钥类型无效');
    if (!fs.statSync(path.join(appRoot,'scripts','apply-app-update.ps1')).isFile()) throw Error('更新助手缺失');
  } catch (error) { supported = false; reason = error.message; }

  function snapshot() {
    const state = phase(), active = state && state.phase!=='downloaded' && !terminal.has(state.phase);
    const jobDetails=state?.id?read(path.join(home,state.id,'job.json')):null,cached=state?.phase==='downloaded'?jobDetails:null;
    const downloadReady=Boolean(cached?.schema===1&&cached.oldVersion===version&&cached.kind===kind&&cached.appRoot===path.resolve(appRoot)&&fs.existsSync(path.join(home,state.id,'package.zip')));
    return { supported, reason, currentVersion:version,available: Boolean(offer), offerId: offer?.id ?? null, offerVersion:offer?.version??null,offerSize:offer?.asset.size??null,
      version: active||downloadReady?state.version:offer?.version ?? state?.version ?? null,
      notes: cached?.releaseManifest?.notes??offer?.notes??'', size: downloadReady?state.total:offer?.asset.size ?? state?.total ?? null, phase: state?.phase ?? 'idle', busy: Boolean(flight || active),downloadReady,deferred:downloadReady&&state.deferred===true,installRequested:jobDetails?.installRequested===true,
      received: Number(state?.received) || 0, total: Number(state?.total) || 0, error: String(state?.error || '').slice(0, 1000),
      notificationPending: Boolean(state && !state.notified && ['complete','rolledBack','rollbackFailed'].includes(state.phase)), previousVersion: state?.oldVersion ?? null, installedVersion: state?.installedVersion ?? null, jobId: state?.id ?? null };
  }
  const announce = () => { if (!closed) publish('status', { appUpdate: snapshot() }); };
  function observe(result) {
    if (!supported || !result?.releaseManifest || closed) { if (!result?.releaseManifest) offer = null; return; }
    try {
      const verified = verifyUpdateManifest(result.releaseManifest, { publicKey, currentVersion: version, platform, arch, kind, channel: runtime.channel ?? 'stable' });
      if (!verified.newer) { offer = null; reason = ''; return; }
      if (!offer || offer.identity !== verified.identity || now() - offer.createdAt > 15 * 60 * 1000) offer = { ...verified, manifest:structuredClone(result.releaseManifest),id: crypto.randomUUID(), createdAt: now() };
      reason = '';
    } catch (error) { offer = null; reason = error.message; }
  }
  async function check() {
    if (checking) return checking;
    checking = (async () => {
      const result = await readRelease(); observe(result); announce();
      const { releaseManifest, ...view } = result;
      return { ...view, ...(releaseManifest ? { automatic: snapshot() } : {}) };
    })().finally(() => { checking = null; }); return checking;
  }
  function releaseLock(id) { if (read(lock)?.id === id) fs.rmSync(lock, { force: true }); }
  function acquire(id){
    fs.mkdirSync(home,{recursive:true});assertOrdinaryDirectory(home);const held=read(lock);
    if(held){
      if(typeof held.id!=='string'||!/^[a-f0-9-]{36}$/.test(held.id))throw fail('更新锁无效，请先检查更新恢复目录');
      const previous=read(path.join(home,held.id,'state.json'));
      if(alive(held.pid)||held.helperPid&&alive(held.helperPid)||previous&&previous.phase!=='downloaded'&&!terminal.has(previous.phase))throw fail('此安装目录已有更新任务，请稍候；上次任务中断时请先恢复旧版');
      fs.rmSync(lock);
    }
    const fd=fs.openSync(lock,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({id,pid:process.pid}));}finally{fs.closeSync(fd);}
  }
  function updateState(directory,id,next){atomic(path.join(directory,'state.json'),{...(read(path.join(directory,'state.json'))||{}),id,oldVersion:version,...next});announce();}
  function roots(){return [...new Set([dataDir,env.QQ_AGENT_PROTOCOL_DIR||path.join(kind==='desktop'?installRoot:appRoot,'protocols'),...['plugins','skills','overrides'].map(name=>path.join(extensionRoot,name))].map(value=>path.resolve(value)).filter(value=>!within(value,installRoot)))];}
  function environment(){return Object.fromEntries(['QQ_AGENT_DATA_DIR','QQ_AGENT_PROFILE','QQ_AGENT_PORT','QQ_AGENT_PROTOCOL_DIR','QQ_AGENT_EXTENSION_ROOT','QQ_AGENT_RUNTIME_CACHE_ROOT','QQ_AGENT_MIGRATE_FROM','QQ_AGENT_DISABLE_GPU'].filter(key=>env[key]!==undefined).map(key=>[key,String(env[key])]));}
  function start(input = {}) {
    if (!supported || closed) throw fail(reason || '当前客户端不能自动安装');
    if (input.confirmed !== true || !offer || input.offerId !== offer.id || now() - offer.createdAt > 15 * 60 * 1000) throw fail('请重新检查版本并确认本次更新');
    if (flight) throw fail('更新正在进行，请勿重复提交');
    const id = crypto.randomUUID(), directory = path.join(home, id), selected = structuredClone(offer);
    acquire(id);
    const jobFile = path.join(directory, 'job.json'), helper = path.join(directory, 'apply-update.ps1');
    const externalRoots = roots();
    const job = { schema: 1, id, nonce: crypto.randomBytes(32).toString('hex'), appRoot: path.resolve(appRoot), installRoot, oldVersion: version,
      version: selected.version, kind, parentPid: process.pid, units: programUnits(kind), externalRoots, bootMode: 'upgrade',
      asset: selected.asset,releaseManifest:selected.manifest,installRequested:false,restart: { ...runtime.restart, args: runtime.restart.args ?? [] },env:environment(),
      healthTimeoutMs: runtime.healthTimeoutMs ?? 90000, shutdownTimeoutMs: runtime.shutdownTimeoutMs ?? 60000 };
    try{
      fs.mkdirSync(directory);fs.copyFileSync(path.join(appRoot, 'scripts', 'apply-app-update.ps1'), helper, fs.constants.COPYFILE_EXCL);
      atomic(jobFile,job);atomic(last,{id});
    }catch(error){releaseLock(id);throw fail('无法准备更新文件：'+error.message);}
    cancelController = new AbortController(); handoff = false;
    const state=next=>updateState(directory,id,next);
    state({ phase: 'downloading',version:selected.version,total: selected.asset.size, received: 0 });
    flight = (async () => {
      const download = path.join(directory, 'package.zip.part'); let handle;
      try {
        handle = fs.openSync(download, 'wx', 0o600); const hash = crypto.createHash('sha256'); let received = 0, lastProgress = 0;
        const response = await safeFetch(selected.asset.url, { maxBytes: selected.asset.size + 1, timeoutMs: 20 * 60 * 1000,
          fetchImpl, dnsLookup, signal: cancelController.signal, headers: { 'accept-encoding': 'identity' }, onChunk: chunk => {
            received += chunk.length; if (received > selected.asset.size) throw fail('更新包超过声明大小');
            for(let offset=0;offset<chunk.length;)offset+=fs.writeSync(handle,chunk,offset,chunk.length-offset);hash.update(chunk);
            if (now() - lastProgress >= 100) { lastProgress = now(); state({ phase: 'downloading', received }); }
          } });
        fs.closeSync(handle); handle = null;
        if(response.hops.some(url=>new URL(url).protocol!=='https:'))throw fail('更新下载不能跳转至非 HTTPS 地址');
        if (response.status !== 200 || response.truncated || received !== selected.asset.size) throw fail('更新包下载不完整，原版未修改');
        state({ phase: 'verifying', received });
        if (hash.digest('hex') !== selected.asset.sha256) throw fail('更新包校验失败，原版未修改');
        fs.renameSync(download, path.join(directory, 'package.zip'));
        state({ phase: 'staging' }); await stage(helper, jobFile, cancelController.signal,'Validate');
        if (cancelController.signal.aborted) throw fail('更新已取消');
        state({phase:'downloaded',deferred:false,error:''});releaseLock(id);
      } catch (error) {
        if (handle !== null && handle !== undefined) fs.closeSync(handle);
        fs.writeFileSync(path.join(directory, 'cancel'), 'cancel', { mode: 0o600 });
        state({ phase: cancelController.signal.aborted ? 'cancelled' : 'error', error: String(error.message).slice(0, 1000) }); releaseLock(id);
        if (!handoff) {
          for (const filename of ['package.zip.part', 'package.zip']) { const candidate = path.join(directory, filename); try { fs.rmSync(candidate, { force: true }); } catch {} }
          const payload = path.join(directory, 'payload'); if (within(payload, directory) && payload !== directory) try { fs.rmSync(payload, { recursive: true, force: true }); } catch {}
        }
      } finally { flight = null; cancelController = null; announce(); }
    })();
    return { ok: true, ...snapshot() };
  }
  function install(input={}){
    if(!supported||closed)throw fail(reason||'当前客户端不能自动安装');
    const current=snapshot();
    if(input.confirmed!==true||!current.downloadReady||input.jobId!==current.jobId)throw fail('请确认安装已下载的更新');
    if(flight)throw fail('更新正在准备，请稍候');
    const directory=path.join(home,current.jobId),jobFile=path.join(directory,'job.json'),helper=path.join(directory,'apply-update.ps1'),job=read(jobFile),id=current.jobId;
    const verified=verifyUpdateManifest(job.releaseManifest,{publicKey,currentVersion:version,platform,arch,kind,channel:runtime.channel??'stable'});
    if(!verified.newer||verified.version!==job.version||JSON.stringify(verified.asset)!==JSON.stringify(job.asset)||job.installRoot!==installRoot)throw fail('下载缓存与已签名版本不符，请重新下载');
    const probe=path.join(installRoot,'.qqa-update-write-'+crypto.randomUUID());
    try{fs.writeFileSync(probe,'',{flag:'wx'});fs.unlinkSync(probe);}catch{throw fail('安装目录不可写，请使用有写入权限的账户启动 QQA 后重试');}
    acquire(id);cancelController=new AbortController();handoff=false;
    const state=next=>updateState(directory,id,next);state({phase:'staging',error:'',deferred:false});
    flight=(async()=>{
      try{
        // Cached downloads can outlive a process or profile. Bind the shutdown,
        // data backup and restart to this installation's current root process.
        const allRoots=[...new Set([...job.externalRoots,...roots()])];job.externalRoots=allRoots.filter(root=>!allRoots.some(other=>other!==root&&within(root,other)));
        Object.assign(job,{parentPid:process.pid,bootMode:'upgrade',installRequested:true,restart:{...runtime.restart,args:runtime.restart.args??[]},env:environment()});delete job.parentStartedAt;
        atomic(jobFile,job);fs.copyFileSync(path.join(appRoot,'scripts','apply-app-update.ps1'),helper);
        for(const filename of ['cancel','helper.ready','shutdown.ok','launch.json','health.json'])fs.rmSync(path.join(directory,filename),{force:true});
        await stage(helper,jobFile,cancelController.signal,'Stage');if(cancelController.signal.aborted)throw fail('安装已取消');
        state({phase:'ready'});const helperPid=await launch(helper,jobFile);atomic(lock,{id,pid:process.pid,helperPid});
        const until=Date.now()+10000;while(!fs.existsSync(path.join(directory,'helper.ready'))){if(Date.now()>until)throw fail(read(path.join(directory,'state.json'))?.error||'更新助手未能启动，原版未修改');await new Promise(resolve=>setTimeout(resolve,50));}
        if(fs.readFileSync(path.join(directory,'helper.ready'),'utf8')!==job.nonce)throw fail('更新助手身份不匹配，原版未修改');
        if(cancelController.signal.aborted)throw fail('安装已取消');
        handoff=true;state({phase:'stopping'});
        const stopped=await runtime.shutdown(()=>fs.writeFileSync(path.join(directory,'shutdown.ok'),job.nonce,{flag:'wx',mode:0o600}));
        if(stopped?.ok===false)throw fail(stopped.error||'设置尚未保存，已取消安装');
      }catch(error){
        fs.writeFileSync(path.join(directory,'cancel'),'cancel',{mode:0o600});state({phase:cancelController.signal.aborted?'cancelled':'error',error:String(error.message).slice(0,1000)});releaseLock(id);
      }finally{flight=null;cancelController=null;announce();}
    })();return{ok:true,...snapshot()};
  }
  function defer(id){if(closed||flight||!snapshot().downloadReady||phase()?.id!==id)throw fail('可安装的更新已变化，请重新读取');updateState(path.join(home,id),id,{deferred:true});return{ok:true,...snapshot()};}
  function cancel() { if (handoff) throw fail('安装已开始，请等待重启'); cancelController?.abort(Error('用户取消更新')); return { ok: true }; }
  function acknowledge(id) {
    const state = phase(); if (!state || state.id !== id || !terminal.has(state.phase)) throw fail('更新结果已变化，请重新读取');
    atomic(path.join(home, id, 'state.json'), { ...state, notified: true }); return { ok: true };
  }
  async function close() { closed = true; if (!handoff) { cancelController?.abort(Error('应用退出，更新已取消')); await flight; } }
  return { snapshot, check, observe, start, install,defer,cancel, acknowledge, close };
}
