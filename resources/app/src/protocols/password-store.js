import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';

const fail=(message,status=500)=>Object.assign(new Error(message),{status,expose:true});
const MAX_FILE=2*1024*1024,MAX_ENTRIES=32;
const scripts={
  protect:"Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::Protect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))",
  unprotect:"Add-Type -AssemblyName System.Security; $bytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $result=[Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))",
};
// Secrets travel over stdin only. The command line is fixed; errors deliberately
// omit child output. Windows binds the encrypted bytes to the current OS user.
export function createWindowsPasswordProtector(){
  const invoke=(mode,bytes)=>new Promise((resolve,reject)=>{
    const exe=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    let child,settled=false,size=0;const chunks=[];
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(fail('无法使用系统加密保存或读取协议端密码'));else resolve(value);};
    const timer=setTimeout(()=>{child?.kill();finish(true);},10000);
    try{child=spawn(exe,['-NoLogo','-NoProfile','-NonInteractive','-Command',scripts[mode]],{windowsHide:true,stdio:['pipe','pipe','ignore']});}
    catch{finish(true);return;}
    child.once('error',()=>finish(true));child.stdin.on('error',()=>finish(true));
    child.stdout.on('data',chunk=>{size+=chunk.length;if(size>256*1024){child.kill();finish(true);}else chunks.push(chunk);});
    child.once('close',code=>{
      if(code!==0){finish(true);return;}
      const raw=Buffer.concat(chunks).toString('ascii').trim();
      if(!raw||! /^[A-Za-z0-9+/]+={0,2}$/.test(raw)){finish(true);return;}
      finish(null,Buffer.from(raw,'base64'));
    });
    child.stdin.end(bytes.toString('base64'));
  });
  return{protect:bytes=>invoke('protect',bytes),unprotect:bytes=>invoke('unprotect',bytes)};
}

function scopeKey(scope){
  if(!['snowluma','napcat'].includes(scope?.provider)||typeof scope.binding!=='string'||!scope.binding||scope.binding.length>8192)throw fail('协议端密码保存范围无效',400);
  let url;try{url=new URL(scope.origin);}catch{throw fail('协议端管理地址无效',400);}
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.origin!==scope.origin)throw fail('协议端管理地址无效',400);
  return crypto.createHash('sha256').update(JSON.stringify([scope.provider,scope.origin,scope.binding])).digest('hex');
}

export function createProtocolPasswordStore({dataDir,protector=null,platform=process.platform}={}){
  const codec=protector??(platform==='win32'?createWindowsPasswordProtector():null),directory=path.join(path.resolve(dataDir),'protocol-secrets'),file=path.join(directory,'passwords.json');
  let tail=Promise.resolve(),closed=false,closing=false;
  const assertOpen=()=>{if(closed)throw fail('协议端密码服务已停止',409);};
  async function plainDirectory(target){const stat=await fs.lstat(target);if(stat.isSymbolicLink()||!stat.isDirectory())throw fail('协议端密码保存目录不可用');}
  async function load(){
    assertOpen();await plainDirectory(path.resolve(dataDir));
    try{await plainDirectory(directory);}catch(error){if(error.code==='ENOENT')return{version:1,entries:{}};throw error;}
    let handle;
    try{
      const stat=await fs.lstat(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.size>MAX_FILE)throw fail('已保存的协议端密码文件不可用');
      handle=await fs.open(file,constants.O_RDONLY|(constants.O_NOFOLLOW||0));const opened=await handle.stat();
      if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size>MAX_FILE)throw fail('协议端密码文件已变化，请重试',409);
      const value=JSON.parse(await handle.readFile('utf8'));
      if(value?.version!==1||!value.entries||typeof value.entries!=='object'||Array.isArray(value.entries)||Object.keys(value.entries).length>MAX_ENTRIES)throw Error();
      for(const [key,item]of Object.entries(value.entries))if(!/^[a-f0-9]{64}$/.test(key)||typeof item?.revision!=='string'||typeof item.ciphertext!=='string'||item.ciphertext.length>128*1024||! /^[A-Za-z0-9+/]+={0,2}$/.test(item.ciphertext))throw Error();
      return value;
    }catch(error){if(error.code==='ENOENT')return{version:1,entries:{}};if(error.expose)throw error;throw fail('已保存的协议端密码文件不可用');}
    finally{await handle?.close();}
  }
  const statusOf=item=>({supported:!!codec,configured:!!item,revision:item?.revision??null});
  async function status(scope){if(closing)throw fail('协议端密码服务已停止',409);await tail;return statusOf((await load()).entries[scopeKey(scope)]);}
  async function read(scope){
    if(closing)throw fail('协议端密码服务已停止',409);
    await tail;const key=scopeKey(scope),item=(await load()).entries[key];if(!item)return null;
    if(!codec)throw fail('当前系统无法解密已保存的协议端密码');
    let plain;
    try{plain=await codec.unprotect(Buffer.from(item.ciphertext,'base64'));const value=JSON.parse(plain.toString('utf8'));
      if(value?.version!==1||value.scope!==key||typeof value.password!=='string'||!value.password||value.password.length>8192)throw Error();
      return{password:value.password,revision:item.revision};
    }catch{throw fail('已保存的协议端密码无法解密，请重新设置');}finally{plain?.fill(0);}
  }
  function write(scope,{password,clear=false,expectedRevision,guard=()=>true}={}){
    if(closing||closed)return Promise.reject(fail('协议端密码服务已停止',409));
    const work=tail.then(async()=>{
      assertOpen();const key=scopeKey(scope);if(!codec)throw fail('当前系统未提供安全密码存储，请手动验证协议端',501);
      if(expectedRevision!==null&&typeof expectedRevision!=='string')throw fail('请重新打开协议端密码设置',400);
      if(!clear&&(typeof password!=='string'||!password||password.length>8192))throw fail('请输入有效的协议端密码',400);
      let data=await load(),previous=data.entries[key];if((previous?.revision??null)!==expectedRevision)throw fail('协议端密码已在其他窗口更新，请重新打开',409);
      let encrypted;
      if(!clear){const bytes=Buffer.from(JSON.stringify({version:1,scope:key,password}));try{encrypted=await codec.protect(bytes);if(!Buffer.isBuffer(encrypted)||!encrypted.length||encrypted.length>96*1024)throw Error();}catch{throw fail('系统加密失败，协议端密码未保存');}finally{bytes.fill(0);}}
      assertOpen();data=await load();previous=data.entries[key];if((previous?.revision??null)!==expectedRevision)throw fail('协议端密码已在其他窗口更新，请重新打开',409);
      if(guard()!==true)throw fail('协议端实例已变化，请重新打开密码设置',409);
      if(clear)delete data.entries[key];else data.entries[key]={ciphertext:encrypted.toString('base64'),revision:crypto.randomUUID()};
      if(Object.keys(data.entries).length>MAX_ENTRIES)throw fail('已保存的协议端过多，请先清除不再使用的密码',409);
      const payload=JSON.stringify(data);if(Buffer.byteLength(payload)>MAX_FILE)throw fail('协议端密码文件超过大小限制');
      await plainDirectory(path.resolve(dataDir));await fs.mkdir(directory,{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});await plainDirectory(directory);
      const temporary=path.join(directory,`${crypto.randomUUID()}.tmp`);let handle;
      try{handle=await fs.open(temporary,'wx',0o600);await handle.writeFile(payload);await handle.sync();await handle.close();handle=null;await fs.rename(temporary,file);}
      catch{throw fail('协议端密码未能保存，请重试');}
      finally{await handle?.close();await fs.unlink(temporary).catch(()=>{});}
      return statusOf(data.entries[key]);
    });
    tail=work.catch(()=>{});return work;
  }
  async function close(){closing=true;await tail;closed=true;}
  return{status,read,write,close};
}
