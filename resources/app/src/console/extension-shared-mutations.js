import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** Serialize package replacement across account processes; local switches never take this lock. */
export function createSharedExtensionMutationGate({isShared=()=>false,safeDirectory,timeoutMs=15000}={}){
  return async work=>{
    if(!isShared())return work();
    const file=path.join(safeDirectory('locks'),'catalog.lock'),nonce=crypto.randomUUID(),deadline=Date.now()+timeoutMs;
    let acquired=false;
    while(!acquired){
      try{const fd=fs.openSync(file,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));}finally{fs.closeSync(fd);}acquired=true;}
      catch(error){
        if(error.code!=='EEXIST')throw error;
        try{
          const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>512)throw Error('共享扩展锁不是有效的普通文件。');
          const text=fs.readFileSync(file,'utf8');let owner;try{owner=JSON.parse(text);}catch{}
          if(Number.isSafeInteger(owner?.pid)&&owner.pid>0){let alive=true;try{process.kill(owner.pid,0);}catch(probe){alive=probe.code!=='ESRCH';}if(!alive&&fs.readFileSync(file,'utf8')===text){fs.unlinkSync(file);continue;}}
        }catch(probe){if(probe.code==='ENOENT')continue;throw probe;}
        if(Date.now()>=deadline)throw Object.assign(Error('其它账号正在安装或更新共享扩展，请稍后重试。'),{status:409,expose:true});
        await new Promise(resolve=>setTimeout(resolve,25));
      }
    }
    try{return await work();}finally{try{if(JSON.parse(fs.readFileSync(file,'utf8')).nonce===nonce)fs.unlinkSync(file);}catch{}}
  };
}
