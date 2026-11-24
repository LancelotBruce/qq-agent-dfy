import fs from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';

// Remove only a newly created subtree below an explicit installation/staging
// boundary. Individual Unicode filesystem calls also avoid Windows recursive
// rm implementations silently leaving non-ASCII paths behind.
export function removeCreatedInstallTree(directory,boundary){
  const target=path.resolve(directory),parent=path.resolve(boundary),relative=path.relative(parent,target);
  if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw Error('清理路径超出了新安装目录');
  if(fs.existsSync(parent)&&path.relative(parent,fs.realpathSync(parent)))throw Error('清理边界不能经过链接');
  function remove(file){
    // existsSync follows the target and misses dangling directory links. lstat
    // lets us unlink the link itself without traversing its former destination.
    let stat;try{stat=fs.lstatSync(file);}catch(error){if(error.code==='ENOENT')return;throw error;}
    if(stat.isSymbolicLink()||stat.isFile()){
      if(!stat.isSymbolicLink())fs.chmodSync(file,0o600);
      fs.unlinkSync(file);
    }else if(stat.isDirectory()){
      for(const name of fs.readdirSync(file))remove(path.join(file,name));
      fs.rmdirSync(file);
    }else throw Error('新安装目录出现特殊文件，停止自动清理');
  }
  remove(target);
}

// Background videos and extension datasets can be large. Verification must not
// allocate the entire file in Electron's startup process.
export function sha256File(file) {
  const descriptor = fs.openSync(file, 'r'), hash = createHash('sha256');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let length;
    while ((length = fs.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) hash.update(buffer.subarray(0, length));
    return hash.digest('hex');
  } finally { fs.closeSync(descriptor); }
}
