const reasons = {
  recent:'距离上次聊天还不够久', quiet:'会话处于安静状态', unread:'还有未处理消息', busy:'正在处理其他会话',
  'no-chats':'没有可主动聊天的对象，请检查响应范围', 'no-groups':'没有可主动聊天的群，请检查响应范围', 'not-ready':'暂未满足发言条件',
  blocked:'联系人已被屏蔽',
  'disabled-chat':'会话主动聊天已关闭', 'not-due':'尚未到会话检查时间',
  'no-model':'尚未配置主模型', muted:'机器人在群里被禁言', changed:'条件已变化，本次已跳过',
  disconnected:'QQ 尚未连接，已跳过本次检查',
  checking:'模型正在判断是否开口', sent:'已主动发送消息', silent:'模型决定保持安静',
  error:'本次执行失败，可在会话或应用日志查看', aborted:'本次已中止',
};

// Absolute local time needs no polling or per-frame countdown. Runtime changes
// arrive through the existing authenticated status snapshot/SSE path.
export function createProactiveStatus(node,{getChatKey=()=>''}={}) {
  let current = null;
  function update(value) {
    if (!value) { if (!current) node.textContent = '当前编排器未提供主动聊天状态'; return; }
    if (current && value.generation === current.generation && Number(value.revision) < Number(current.revision)) return;
    current = value;
    const key=getChatKey(),local=key&&value.unified===false,plan=local?value.byChat?.[key]:null;
    const next = Number(local?plan?.nextCheckAt:value.nextCheckAt), valid = Number.isFinite(next) && next > 0;
    const time = valid ? new Date(next).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '';
    const scope = value.scope === 'groups' ? '仅群聊' : '私聊与群聊';
    const text = !value.enabled ? '主动聊天未启用' : value.paused ? '账号已暂停，恢复后继续检查'
      : local ? valid?`此会话下次检查 ${time}`:'此会话未排程，请检查响应范围和会话开关'
      : value.running && valid ? `下次检查 ${time} · ${reasons[value.lastOutcome] || '尚未进行首次检查'} · ${scope}`
      : `主动聊天尚未排程 · ${scope}`;
    if (node.textContent !== text) node.textContent = text;
    node.dataset.state = value.paused ? 'paused' : value.lastOutcome === 'error' ? 'error' : 'normal';
  }
  node.textContent = '正在读取主动聊天状态…';
  return { update,refresh:()=>{if(current)update(current);} };
}
