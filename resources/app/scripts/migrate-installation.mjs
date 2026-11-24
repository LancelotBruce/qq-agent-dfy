import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {copyInstallData} from '../src/install/copy-install.js';
import {installFailure,installationDiagnostic,writeInstallationDiagnostic} from '../src/install/diagnostics.js';

const args=process.argv.slice(2),option=name=>{const i=args.indexOf(name);return i<0?null:args[i+1];};
let target=option('--target')||'',source='';
try{
  let plan;try{plan=JSON.parse(fs.readFileSync(option('--plan'),'utf8').replace(/^\uFEFF/,''));}catch{throw installFailure('PLAN_INVALID','安装迁移计划缺失或损坏');}
  target=path.resolve(target);
  if(!option('--target')||plan?.schema!==2||typeof plan.installRoot!=='string'||path.resolve(plan.installRoot)!==target||typeof plan.sourceRoot!=='string')throw installFailure('PLAN_INVALID','安装迁移计划无效');
  source=plan.sourceRoot;
  const version=JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../package.json'),'utf8')).version;
  const result=copyInstallData({installRoot:target,sourceRoot:plan.sourceRoot||null,version});
  console.log(JSON.stringify(result));
}catch(error){
  const diagnostic=installationDiagnostic(error,{target,source});
  try{writeInstallationDiagnostic(option('--error-report'),diagnostic);}catch{}
  console.error('['+diagnostic.Code+'] 安装迁移未完成：'+String(error?.message??error));process.exitCode=2;
}
