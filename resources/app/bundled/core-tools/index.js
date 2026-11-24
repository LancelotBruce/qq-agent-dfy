// core-tools：机器人本职工具（send_message / send_to / send_poke / finish / report_feedback）。
// 契约：SPEC §8 T-01/T-02/T-04/T-21/T-08；0.4 行为等价。
// 仅消费公共配置与发送能力。
import {messageInput} from './message-input.js';
import {rewriteOutgoing} from './flavor-bridge.js';
export default {
  setup(ctx) {
    const K = {
      cfg: () => ctx.capability('host.config').get(),
      get send() { return ctx.capability('core.send'); },
    };

    // T-01 send_message：模型统一传数组；旧 SDK 的字符串/别名仍兼容。
    ctx.registerTool({
      id: 'send_message', name: '发送消息', category: 'messaging',
      description: '把回复实际发给当前聊天对象。messages 必填，始终传字符串数组，一条消息也放进数组。确认记忆、提醒及后续操作均已完成才可设 endTurn:true 申请直接收尾；系统要求继续时仍需 finish。仅输出正文不会发送。',
      params: {
        type: 'object',
        properties: {
          messages: { type: ['string', 'array'], description: '要发送的文字（数组 = 分多条发出）' },
          texts: { type: ['string', 'array'], description: '旧调用兼容参数；新调用请传 messages' },
          endTurn: { type: 'boolean', description: '全部发送成功后结束本轮；默认 false' },
          atUserId: { type: 'string', description: '要在第一条里 @ 的 QQ 号（可省）' },
          replyToMessageId: { type: 'string', description: '要引用的消息 id（可省）' },
        },
        required: [], // messages/texts 二选一，在执行时校验（兼容旧调用）
      },
      // The model sees one unambiguous parameter name. Runtime validation below
      // still accepts legacy aliases from 0.4 extensions and direct SDK calls.
      modelParams: {
        type: 'object',
        properties: {
          messages: { type: 'array', items: {type:'string',minLength:1}, minItems:1, description:'每项是一条完整消息；单条也用数组，例如 ["在的"]。不要 JSON.stringify 或把数组包成字符串。要展示 JSON 原文，将原文放在数组的一项中' },
          endTurn: { type:'boolean',description:'无待办时填 true 申请直接结束；还有记忆/提醒/后续操作则省略；需正常收尾时系统会提示' },
          atUserId: {type:'string',description:'第一条中要 @ 的 QQ 号，可省略'},
          replyToMessageId: {type:'string',description:'要引用的消息 ID，可省略'},
        },
        required: ['messages'], additionalProperties: false,
      },
      scopes: ['qq.send'],
      execute: async (args, c) => {
        let texts = messageInput(args.messages ?? args.texts ?? args.text ?? args.message, {fromModel:c.argumentSource==='model'});
        if (texts === undefined || texts === null) return { ok: false, error: '发送失败：缺少 messages 参数' };
        texts = await rewriteOutgoing(texts, K.cfg());
        const sender = c.send ?? K.send;
        const res = await sender.sendTextBatch(c.chatKey, texts, {
          atUserId: args.atUserId, replyToMessageId: args.replyToMessageId, signal: c.signal,
        });
        c.session.sent = c.session.sent ?? [];
        c.session.sent.push(...(res.sent ?? []));
        if (res.deduped) return { ok: true, result: { sent: [], failed: [], deduped: true, note: res.note ?? '内容重复，已跳过' } };
        const endTurn = args.endTurn === true && res.ok !== false && res.sent?.length > 0 && !(res.failed?.length);
        return { ok: res.ok !== false, error: res.failed?.[0]?.error, result: { sent: res.sent ?? [], failed: res.failed ?? [], deduped: false, note: res.note ?? null,
          ...(endTurn ? {endTurn:true} : {}) } };
      },
    });

    // T-02 send_to：跨会话发送（受白名单三重校验；tools.crossChatSend 关闭时工具不可见）。
    ctx.registerTool({
      id: 'send_to', name: '跨会话发送', category: 'messaging', defaultEnabled: true,
      description: '把消息发到另一个群或私聊；必须填写 targetChatKey 和 messages 字符串数组，一条消息也放进数组。当前会话请用 send_message。目标须在白名单内，跨会话发送默认关闭。',
      params: {
        type: 'object',
        properties: {
          targetChatKey: { type: 'string', description: '目标会话键（group:<群号> 或 private:<QQ号>）' },
          messages: { type: ['string', 'array'], description: '要发送的文字' },
          texts: { type: ['string', 'array'], description: '旧调用兼容参数；新调用请传 messages' },
        },
        required: ['targetChatKey'],
      },
      modelParams: {
        type:'object',
        properties:{
          targetChatKey:{type:'string',description:'目标 group:<群号> 或 private:<QQ号>，必须在白名单内'},
          messages:{type:'array',items:{type:'string',minLength:1},minItems:1,description:'每项是一条完整消息；单条也用数组，不要将数组转成字符串'},
        },
        required:['targetChatKey','messages'],additionalProperties:false,
      },
      scopes: ['qq.send'],
      execute: async (args, c) => {
        const cfg = K.cfg();
        const target = String(args.targetChatKey ?? '');
        const m = target.match(/^(group|private):(\d+)$/);
        if (!m) return { ok: false, error: `目标会话格式不对：${target}（应为 group:<群号> 或 private:<QQ号>）` };
        const [kind, id] = [m[1], m[2]];
        // 白名单三重校验：跨会话目标必须不同于当前会话，且必须显式列入 allow。
        if (target === c.chatKey) return { ok: false, error: '目标会话必须不同于当前会话，当前会话请用 send_message' };
        const allowList = cfg.allow?.[kind === 'group' ? 'groups' : 'private'] ?? [];
        if (!Array.isArray(allowList) || !allowList.map(String).includes(id)) {
          return { ok: false, error: `目标 ${target} 不在白名单内，已拒绝发送` };
        }
        const denyList = cfg.deny?.[kind === 'group' ? 'groups' : 'private'] ?? [];
        if (denyList.map(String).includes(id)) {
          return { ok: false, error: `目标 ${target} 在黑名单内，已拒绝发送` };
        }
        let texts = messageInput(args.messages ?? args.texts ?? args.text, {fromModel:c.argumentSource==='model'});
        if (texts === undefined || texts === null) return { ok: false, error: '发送失败：缺少 messages 参数' };
        texts = await rewriteOutgoing(texts, K.cfg());
        const sender = c.send ?? K.send;
        const res = await sender.sendTextBatch(target, texts, { signal: c.signal });
        c.session.sent = c.session.sent ?? [];
        c.session.sent.push(...(res.sent ?? []));
        return { ok: res.ok !== false, error: res.failed?.[0]?.error, result: { targetChatKey: target, sent: res.sent ?? [], failed: res.failed ?? [], note: res.note ?? null } };
      },
    });

    // T-04 send_poke：拍一拍。群聊传 targetUserId（运行时校验），私聊可省。
    // SUSPECT 复刻（C-05）：schema 未把 targetUserId 标 required（0.4 行为）——模型可能不传参白吃一次错误往返。
    ctx.registerTool({
      id: 'send_poke', name: '拍一拍', category: 'messaging',
      description: '拍一拍群友。群聊必须传 targetUserId；私聊可省。',
      params: {
        type: 'object',
        properties: {
          targetUserId: { type: ['integer', 'string'], description: '要拍的 QQ 号（群聊必填，须为正整数）' },
        },
        required: [], // SUSPECT 复刻：0.4 schema 未标 required
      },
      scopes: ['qq.send'],
      execute: async (args, c) => {
        const isGroup = c.chatKey.startsWith('group:');
        const uid = args.targetUserId ?? args.userId;
        if (isGroup && uid == null) return { ok: false, error: '群聊里拍人需要传 targetUserId（QQ 号）' };
        const groupId = isGroup ? c.chatKey.split(':').pop() : null;
        const userId = uid ?? (isGroup ? '' : c.chatKey.split(':').pop());
        // OneBot 将 QQ 号编码为 Number，不能把非法值或有精度损失的目标下传。
        const numericId = typeof userId === 'string' || typeof userId === 'number' ? Number(userId) : NaN;
        if (!Number.isSafeInteger(numericId) || numericId <= 0) return { ok: false, error: `targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(userId)}）` };
        await K.send.poke(c.chatKey, { groupId, userId: String(numericId) });
        return { ok: true, result: '已拍一拍' };
      },
    });

    // T-21 finish：明确结束本次处理（可带话题总结供活跃期判定）。
    ctx.registerTool({
      id: 'finish', name: '结束本轮', category: 'system',
      allowAfterSendCompletion: true,
      description: '保持沉默或完成收尾；此工具不会发消息，reason/summary 仅写入控制台。要回复对方用 send_message；endTurn:true 只是省略结束轮的申请，系统要求继续时仍需调用本工具。延续话题填写 activeTopic；结束话题时 reason 写明“话题结束”。',
      params: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: '本轮小结（≤300 字，可省）' },
          reason: { type: 'string', description: '结束原因（如"说完了""话题结束"）' },
          activeTopic: { type: 'string', description: '想继续深聊的话题（≤60 字）' },
        },
        required: [],
      },
      scopes: [],
      execute: async (args, c) => {
        if (args.summary) c.session.finishReason = String(args.summary).slice(0, 300);
        if (args.reason) c.session.finishReason = String(args.reason);
        if (args.activeTopic) c.session.activeTopic = String(args.activeTopic).slice(0, 60);
        return { ok: true, result: { finished: true } };
      },
    });

    // T-08 report_feedback：向管理员/控制台反馈（不用于聊天）。
    ctx.registerTool({
      id: 'report_feedback', name: '反馈问题', category: 'system',
      description: '向管理员反馈问题或建议（不用于聊天）。',
      params: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'], description: '级别' },
          message: { type: 'string', description: '反馈内容（≤500 字）' },
        },
        required: ['message'],
      },
      scopes: [],
      execute: async (args, c) => {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        const message = String(args.message ?? '').slice(0, 500);
        c.session.feedbacks = c.session.feedbacks ?? [];
        c.session.feedbacks.push({ level, message, at: Date.now() });
        ctx.capability('host.feedback')?.report({ level, message, chatKey: c.chatKey });
        return { ok: true, result: { reported: true } };
      },
    });
  },
};
