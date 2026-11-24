import { isChatQuiet } from './command-mute-state.js';
import {describeSendDiagnostic} from './send-failure.js';

export const commandReplyToEntry = Symbol('commandReplyToEntry');

// A command occupies the entire message. Mentions and reply metadata may
// address it, but a caption, attachment or quotation cannot execute it.
export function readSlashCommand(event, selfId) {
  let text = '', addressed = false;
  if (Array.isArray(event?.message)) {
    for (const segment of event.message) {
      const data = segment?.data ?? segment;
      if (segment?.type === 'text') text += String(data.text ?? '');
      else if (segment?.type === 'at' && selfId && String(data.qq ?? data.id) === String(selfId)) { addressed = true; text += ' '; }
      else if (segment?.type === 'reply') text += ' ';
      else return null;
    }
  } else {
    text = String(event?.raw_message ?? event?.message ?? '');
    if (text.includes('[CQ:')) {
      let foreign = false;
      text = text.replace(/\[CQ:([^,\]]+)([^\]]*)\]/g, (_, type, attrs) => {
        if (type === 'at' && selfId && /(?:^|,)qq=([^,]+)/.exec(attrs)?.[1] === String(selfId)) addressed = true;
        else if (type !== 'reply') foreign = true;
        return ' ';
      });
      if (foreign) return null;
    }
  }
  text = text.trim();
  if (!text.startsWith('/')) return null;
  const match = /^(\/[\p{L}\p{N}_-]{1,48})(?:\s+([\s\S]*))?$/u.exec(text);
  return match ? { name: match[1], args: match[2] ?? '', text, addressed } : null;
}

export function matchPluginCommand(message, { loader, selfId, config }) {
  if (message?.type !== 'message') return null;
  const parsed = readSlashCommand(message.event, selfId);
  if (!parsed) return null;
  const run = loader.commandOf?.(parsed.name);
  if (!run) return null;
  const mute = config().commandMute;
  if (mute?.enabled !== false && [mute?.command ?? '/安静', mute?.resumeCommand ?? '/活跃'].some(value => String(value).trim() === parsed.text)) return null;
  return { ...parsed, run };
}

export async function dispatchPluginCommand(command, { kind, id, event }, { ingest, orchestrator, cfg, log, selfId, signal, current = () => true, memberCommandAccess = null }) {
  const senderId = String(event.user_id ?? event.sender?.user_id ?? '');
  if (!senderId || senderId === String(selfId) || (selfId && event.self_id != null && String(event.self_id) !== String(selfId))
    || (kind === 'private' && String(id) !== senderId)) return;
  const active = () => !signal?.aborted && current();
  if (!active()) return;
  const memberSubcommand = command.args.trim().split(/\s+/u)[0];
  const allowMemberPrivate = kind === 'private' && command.run.privateFromAllowedGroups?.includes(memberSubcommand)
    && typeof memberCommandAccess === 'function';
  // Only the command name is retained. Arguments may contain private input.
  const result = await ingest.ingestMessage({ kind, id, signal, handledCommand: true,
    commandAccess: allowMemberPrivate ? options => !(orchestrator.isPaused?.() ?? orchestrator.status?.().paused)
      && memberCommandAccess(senderId, { ...options, groupHint: event.group_id ?? event.sender?.group_id }) : null,
    event: {
    user_id: senderId, sender: event.sender, message_id: event.message_id, time: event.time,
    message: [{ type: 'text', text: command.name }], raw_message: command.name,
  } });
  if (!result.accepted) return;
  const canReply = () => active() && !(orchestrator.isPaused?.() ?? orchestrator.status?.().paused)
    && (command.addressed || !isChatQuiet(cfg().commandMute, result.chatKey));
  if (!canReply()) return;
  try {
    await command.run({ args: command.args, chatKey: result.chatKey, senderId, signal }, canReply, result.entry.id);
  } catch (error) {
    // Plugin exceptions can include the original arguments. No model fallback
    // here: a failed or cancelled command must never run a second time.
    if (canReply()) log.warn?.(`[plugin] 指令 ${command.name} 执行或发送失败；${describeSendDiagnostic(error?.diagnostic)}。未自动重跑指令。`);
  }
}
