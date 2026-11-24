import fs from 'node:fs';

export function installFailure(code,message,context={}) {
  return Object.assign(new Error(message),{installCode:code,installContext:context});
}

const ioCodes={EACCES:'ACCESS_DENIED',EPERM:'ACCESS_DENIED',ENOSPC:'DISK_FULL',ENAMETOOLONG:'PATH_TOO_LONG',EBUSY:'FILE_BUSY'};
export function installationDiagnostic(error,{target='',source=''}={}) {
  return {Code:error?.installCode??ioCodes[error?.code]??'MIGRATION_FAILED',Target:target,Source:source,
    ...(error?.path?{Path:error.path}:{}),...(error?.installContext??{})};
}

export function writeInstallationDiagnostic(file,diagnostic) {
  if(!file)return;
  // Share the preflight helper's Unicode INI format. Do not put raw exceptions,
  // config values or source-file contents into a distributable error report.
  const fields=['Code','Target','Source','Path','Entries','ProcessName','ProcessId'];
  const lines=fields.filter(key=>diagnostic[key]!==undefined&&diagnostic[key]!=='')
    .map(key=>key+'='+String(diagnostic[key]).replace(/[\x00-\x1f]/g,' '));
  fs.writeFileSync(file,'\uFEFF[Failure]\r\n'+lines.join('\r\n')+'\r\n','utf16le');
}
