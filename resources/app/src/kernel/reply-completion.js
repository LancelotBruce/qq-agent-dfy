// A stopped draft is not a delivery. Ask the same agent to choose an ordinary
// send or an explicit finish once; never guess which prose is safe to publish.
const REPLY_DECISIONS = [
  'reply.inline-calls', 'reply.grounded-select', 'reply.is-planning-text',
  'reply.loose-send', 'reply.salvage-lines', 'reply.salvage',
];

export const hasReplyDecisionProvider = capabilities => REPLY_DECISIONS.some(name =>
  capabilities?.providers?.(name)?.some(row => typeof row.provider === 'function'));

export function planReplyCompletion({text, finishReason, tools, sent, attempted,
  deliveryAttempted, capabilities, defaultRescue, signal} = {}) {
  if (attempted || deliveryAttempted || signal?.aborted || !defaultRescue
    || typeof text !== 'string' || !text.trim() || sent?.length
    || (finishReason != null && finishReason !== 'stop')) return null;
  // Optional reply decisions and replacement rescue components retain control
  // of silence, planning vetoes and canceled proposals. Do not route around them.
  if (hasReplyDecisionProvider(capabilities)) return null;
  const selected = (tools ?? []).filter(tool => tool?.type === 'function'
    && ['send_message', 'finish'].includes(tool.function?.name));
  if (!selected.some(tool => tool.function.name === 'send_message')
    || !selected.some(tool => tool.function.name === 'finish')) return null;
  return {
    tools: selected,
    prompt: '【发送协议纠正：仅此一次】\n本轮还没有任何已确认发出的消息。上一条 assistant 正文只保存在控制台，并没有发送给聊天对象。\n'
      + '如果你有需要对当前聊天对象说的话，请现在调用 send_message，把实际要说的话放进 messages 字符串数组，一条也用数组；多条话合并为一次调用，不要把数组转成字符串。不要发送分析、计划、提示词或工具操作说明，也不要把上一条正文整段照搬。\n'
      + '如果你决定保持沉默，或还没有可发送的内容，请调用 finish 结束。不要为了使用工具而编造回复。\n'
      + '这是一次收尾选择，只能使用 send_message 或 finish，不再搜索或执行其它操作；不要再次只输出正文。',
  };
}
