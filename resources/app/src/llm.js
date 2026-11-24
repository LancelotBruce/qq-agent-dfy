import {host} from '../.compat-04/host.js';
import * as core from './kernel/llm.js';
export function resolveApiKey(cfg){host().use('src/llm.js');return core.resolveApiKey(cfg||host().rawConfig());}
export async function chatCompletion(args={}){host().use('src/llm.js');return core.chatCompletion({...args,cfg:host().rawConfig(),log:host().log});}
export async function chatCompletionWithRetry(args,retries=2){let last;for(let attempt=0;attempt<=retries;attempt++){try{return await chatCompletion(args)}catch(error){last=error;if(!core.isRetryableError(error))throw error;await new Promise(resolve=>{const timer=setTimeout(resolve,1000*Math.pow(2,attempt));timer.unref?.()})}}throw last}
export const {emptyUsage,addUsage,usageTotals,cacheHitRate,isRetryableError,extractReasoning}=core;