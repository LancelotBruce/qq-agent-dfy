// This stores layout boundaries, never a substitute for reading current data.
// A retained block is usable only while it is still an exact, whole-record
// prefix of today's source. Edits/removals rebuild it; additions stay at the
// tail until the bounded history window moves and gives us a free rebase.
export function partitionPromptContext(source, prefix, records = null) {
  const text = String(source ?? '');
  if (typeof prefix === 'string' && prefix) {
    if(text === prefix)return {prefix,suffix:''};
    // Do not infer records by splitting on newlines: a single saved impression
    // may itself contain several lines, including something looking like a list.
    if(text.startsWith(prefix+'\n') && Array.isArray(records) && records.every(x=>typeof x==='string') && records.join('\n')===text){
      let end=-1;
      for(const record of records){
        end+=record.length+1;
        if(end===prefix.length)return {prefix,suffix:text.slice(end+1)};
        if(end>prefix.length)break;
      }
    }
  }
  return { prefix: '', suffix: text };
}

export function createPromptContextPrefix({ maxChats = 64, maxSourceChars = 65536 } = {}) {
  const states = new Map();
  const chatLimit = Math.max(1, Math.min(64, Math.trunc(Number(maxChats) || 64)));
  const sourceLimit = Number.isFinite(Number(maxSourceChars)) ? Math.max(0, Math.min(65536, Math.trunc(Number(maxSourceChars)))) : 65536;
  const retain = (source, previous, reset, changes, records = null) => {
    const text = String(source ?? '');
    if (text.length > sourceLimit) return {text:'',changes};
    // An empty retained block deliberately stays empty until a window reset:
    // suddenly adding a new front section would invalidate all chat history.
    if (!reset && (previous === '' || partitionPromptContext(text, previous, records).prefix)) return {text:previous,changes};
    const changed=reset?0:changes+1;
    // Repeated rewrites mean this source is volatile. After one rebuild,
    // demote it for the remainder of this window rather than repeatedly
    // destroying the long transcript prefix. All current data still follows.
    return {text:changed>=2?'':text,changes:changed};
  };
  return {
    forChat(chatKey, { memText, memoryRecords = null, stickerListText, windowStart = null } = {}) {
      const previous = states.get(chatKey);
      const reset = !previous || previous.windowStart !== windowStart;
      const memory=retain(memText,previous?.memory,reset,reset?0:previous.memoryChanges,memoryRecords);
      const stickers=retain(stickerListText,previous?.stickers,reset,reset?0:previous.stickerChanges);
      const state = { windowStart,
        memory:memory.text,memoryChanges:memory.changes,
        stickers:stickers.text,stickerChanges:stickers.changes };
      states.delete(chatKey);
      states.set(chatKey, state);
      while (states.size > chatLimit) states.delete(states.keys().next().value);
      return { memory: state.memory, stickers: state.stickers };
    },
    delete: chatKey => states.delete(chatKey),
    clear: () => states.clear(),
  };
}
