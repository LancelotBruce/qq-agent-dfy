// 读本机已有的东西：核心配置里的白名单、data/messages 里的原始聊天存档。
// 不依赖任何 hook 是否触发 —— 机器人白天不回话也照样有消息入库，这里直接读文件。
import fs from 'node:fs';
import path from 'node:path';

export function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch { return fallback; }
}

export function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch { return false; }
}

/** 白名单：config.allow.groups / config.allow.private（空且 allowAllWhenEmpty 才放开）。 */
export function loadWhitelist(configFile) {
  const cfg = readJson(configFile, {}) || {};
  const allow = cfg.allow && typeof cfg.allow === 'object' ? cfg.allow : {};
  const groups = (Array.isArray(allow.groups) ? allow.groups : []).map((x) => String(x).replace(/\D/g, '')).filter(Boolean);
  const privateIds = (Array.isArray(allow.private) ? allow.private : []).map((x) => String(x).replace(/\D/g, '')).filter(Boolean);
  const allowAll = cfg.allowAllWhenEmpty === true && groups.length === 0 && privateIds.length === 0;
  return { groups, private: privateIds, allowAll };
}

export function chatKeysOfWhitelist(allow) {
  const keys = [];
  for (const id of allow.groups) keys.push(`group:${id}`);
  for (const id of allow.private) keys.push(`private:${id}`);
  return keys;
}

function safeName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

export function messageFile(messagesDir, chatKey) {
  return path.join(messagesDir, `${safeName(chatKey)}.json`);
}

/** 读一个会话的原始消息（结构：{messages:[{id,ts,mid,self,senderId,senderName,text,media}]}）。 */
export function loadMessages(messagesDir, chatKey) {
  const file = messageFile(messagesDir, chatKey);
  const data = readJson(file, null);
  const list = data && Array.isArray(data.messages) ? data.messages : [];
  return list
    .filter((m) => m && Number(m.ts) > 0 && m.recalled !== true)
    .map((m) => ({
      id: Number(m.id) || 0,
      ts: Number(m.ts) || 0,
      mid: m.mid ?? null,
      self: m.self === true,
      uid: String(m.senderId ?? '').replace(/\D/g, ''),
      who: String(m.senderName ?? m.senderId ?? '?').slice(0, 24),
      text: withQuote(String(m.text ?? '').replace(/\s+/g, ' ').trim(), m.reply),
      at: normalizeAt(m.atNames),
      atMe: m.atMe === true || m.atMe === 'true',
      reply: m.reply && m.reply.mid != null
        ? { mid: String(m.reply.mid), sender: String(m.reply.sender ?? '').slice(0, 24), text: String(m.reply.text ?? '').slice(0, 60) }
        : null,
      media: Array.isArray(m.media) ? m.media.length : 0
    }))
    .filter((m) => m.text && !/^\[(图片|表情|贴图|语音|视频)\]$/.test(m.text))
    .sort((a, b) => (a.id - b.id) || (a.ts - b.ts));
}

/** 带引用回复的消息，把被引用的那一句接在正文前面，整理时模型才知道在回哪句。 */
function withQuote(text, reply) {
  const quote = String(reply?.text ?? '').replace(/\s+/g, ' ').trim();
  if (!quote) return text;
  const who = String(reply?.sender ?? '').trim();
  return `[引用${who ? ' ' + who : ''}「${quote.slice(0, 40)}」]${text}`;
}

/** @ 名单：存档里可能是字符串「@A」、也可能是数组，统一成去 @ 的名字列表。 */
function normalizeAt(value) {
  if (!value) return [];
  const parts = Array.isArray(value) ? value : String(value).split(/[，,；;\n]+/);
  return parts
    .map((x) => String(x ?? '').replace(/^@+/, '').trim())
    .filter(Boolean)
    .slice(0, 5);
}

/** 列目录里所有会话（备用：白名单为空又想全记时）。 */
export function listAllChatKeys(messagesDir) {
  try {
    return fs.readdirSync(messagesDir)
      .filter((f) => /^(group|private)_\d+\.json$/.test(f))
      .map((f) => {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        return `${m[1]}:${m[2]}`;
      });
  } catch { return []; }
}

export function chatKindOf(chatKey) {
  return String(chatKey).startsWith('private:') ? 'private' : 'group';
}

export function chatIdOf(chatKey) {
  return String(chatKey).replace(/^[a-z]+:/i, '');
}

export function fileStamp(file) {
  try {
    const st = fs.statSync(file);
    return `${st.mtimeMs}:${st.size}`;
  } catch { return ''; }
}
