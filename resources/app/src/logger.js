import {host} from '../.compat-04/host.js';
const flatten=args=>args.map(value=>{if(typeof value==='string')return value;try{return JSON.stringify(value)}catch{return String(value)}}).join(' ');
function emit(level,args){host().use('src/logger.js');try{const sink=host().log;const fn=sink&&(sink[level]||sink.info);if(typeof fn==='function')fn.call(sink,'[legacy] '+flatten(args))}catch{}}
export const logger={info:(...args)=>emit('info',args),warn:(...args)=>emit('warn',args),error:(...args)=>emit('error',args),debug:(...args)=>emit('debug',args),trace:(...args)=>emit('trace',args),child:()=>logger};
export const log=logger;
export default logger;