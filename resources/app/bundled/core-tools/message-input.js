// This compatibility repair belongs to the model tool boundary, not SendQueue:
// SDK callers may deliberately send JSON as literal text. Typed array items are
// also literal; never recursively decode them or guess at broken JSON.
const formatError=()=>new Error('messages 必须是非空字符串数组，例如 {"messages":["第一条","第二条"]}；不要把数组转成字符串。若要展示 JSON 原文，请把原文作为数组中的一条文字。');

export function messageInput(value,{fromModel=false}={}) {
  if(!fromModel)return value;
  if(typeof value==='string'){
    const text=value.trim();
    if(text.startsWith('[')){
      try{value=JSON.parse(text);}catch{throw formatError();}
    }else{
      // A second layer of JSON string encoding is ambiguous. Refuse it rather
      // than repeatedly parsing until something executable-looking appears.
      if(text.startsWith('"')){
        let decoded;try{decoded=JSON.parse(text);}catch{}
        if(typeof decoded==='string'&&decoded.trimStart().startsWith('['))throw formatError();
      }
      value=[value]; // Legacy one-message calls remain compatible.
    }
  }
  if(!Array.isArray(value)||!value.length||value.some(item=>typeof item!=='string'||!item.trim()))throw formatError();
  return value;
}
