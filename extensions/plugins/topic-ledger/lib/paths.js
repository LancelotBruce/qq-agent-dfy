// 路径常量：数据根必须与正在运行的那份进程一致（多实例/多 profile 下自己拼会写错目录）。
// lib/ → topic-ledger/ → plugins/ → app
import path from 'node:path';
import { DATA_DIR } from '../../../src/config.js';

export const LEDGER_ROOT = path.join(DATA_DIR, 'ledger');
export const STATE_FILE = path.join(LEDGER_ROOT, 'state.json');
export const ARCHIVE_DIR = path.join(LEDGER_ROOT, 'archive');
export const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
export const DEBUG_LOG = path.join(LEDGER_ROOT, 'debug.log');

export { DATA_DIR };
