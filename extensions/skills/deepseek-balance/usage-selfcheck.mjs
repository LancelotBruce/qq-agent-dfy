// 自检：① 当日用量接口与格式化文本；② 主人判定（私聊 / 群聊 / 拿不到发送者）。
// 用法：node usage-selfcheck.mjs
import { getTodayUsage, fmtUsage, isOwnerCtx } from './index.js';

const data = await getTodayUsage();
const totals = data?.totals || {};
console.log('range =', data?.range, '| days =', (data?.days || []).map((d) => d.day).join(','));
console.log('totals.cost =', totals.cost, '| runs =', totals.runs, '| totalTokens =', totals.totalTokens);
console.log('--- 口令实际会发的文本 ---');
console.log(fmtUsage(data));

console.log('--- 主人判定 ---');
const cases = [
  ['私聊主人', { chatKey: 'private:1000000000' }, true],
  ['私聊别人', { chatKey: 'private:123456789' }, false],
  ['群里主人说话', { chatKey: 'group:2000000000', session: { trigger: [{ senderId: '1000000000', text: '当日用量' }] } }, true],
  ['群里别人说话', { chatKey: 'group:2000000000', session: { trigger: [{ senderId: '999888' }] } }, false],
  ['群聊多人只取最后一条', { chatKey: 'group:2000000000', session: { trigger: [{ senderId: '1000000000' }, { senderId: '999888' }] } }, false],
  ['无触发上下文', {}, false],
];
let failed = 0;
for (const [label, ctx, expect] of cases) {
  const got = isOwnerCtx(ctx);
  const ok = got === expect;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}: got=${got} expect=${expect}`);
}
if (failed) { console.error(`\n${failed} 项断言失败`); process.exitCode = 1; } else { console.log('\n全部通过'); }
