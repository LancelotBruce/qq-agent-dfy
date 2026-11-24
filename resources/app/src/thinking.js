import {host} from '../.compat-04/host.js'; import * as implementation from "file:///D:/%E5%A4%A7%E8%82%A5%E9%B1%BC%E4%B8%93%E7%94%A8/QQAgent-0.5/data-v05/extension-cache/cb9c4695-1393-4300-9358-7bf22632a227-hDpUu1/app/bundled/compat-04/host-modules.js";
host().use('src/thinking.js');
export function resolveThinkingRequest(api,context){return implementation.resolveThinkingRequest(api,context,host().dialect());}
export function buildThinkingParams(options){return implementation.buildThinkingParams(options,host().dialect());}
export function stripThinkingParams(body){return implementation.stripThinkingParams(body,host().dialect());}