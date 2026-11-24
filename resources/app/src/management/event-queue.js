// Optional serial trigger delivery. Existing saved rules keep drop-on-busy;
// this queue is chosen explicitly by eventMode, independently of node types.
export function createRuleEventQueue({canStart,canRun,run,onDiscard,onOverflow,maxEvents=256,maxBytes=8*1024*1024}){
  const groups=new Map();let count=0,bytes=0,retained=0,pumping=false;
  const release=entry=>{bytes-=entry.bytes;retained--;};
  function pump(){
    if(pumping)return;pumping=true;
    try{
      for(const [key,state] of groups){
        if(state.busy)continue;
        while(state.entries.length&&canStart()){
          const entry=state.entries.shift();count--;const issue=canRun(entry.context);
          if(issue){release(entry);onDiscard(entry.context,issue.reason,issue.status);continue;}
          state.busy=true;
          let work;try{work=run(entry.context);}catch(error){work=Promise.reject(error);}
          Promise.resolve(work).catch(error=>onDiscard(entry.context,error.message,'failed')).finally(()=>{
            release(entry);state.busy=false;if(groups.get(key)===state&&!state.entries.length)groups.delete(key);pump();
          });break;
        }
        if(!state.busy&&!state.entries.length)groups.delete(key);
      }
    }finally{pumping=false;}
  }
  return {
    offer(key,binding,context,size){
      if(!Number.isFinite(size)||size<0||size>maxBytes||retained>=maxEvents||bytes+size>maxBytes){onOverflow(context);return false;}
      let state=groups.get(key);if(state&&state.binding!==binding){this.cancel(item=>item.rule===state.binding,'规则已修改');state=null;}
      if(!state){state={binding,busy:false,entries:[]};groups.set(key,state);}
      state.entries.push({context,bytes:size});count++;retained++;bytes+=size;pump();return true;
    },
    cancel(predicate,reason='规则已停止'){
      for(const [key,state] of groups){state.entries=state.entries.filter(entry=>{if(!predicate(entry.context))return true;count--;release(entry);onDiscard(entry.context,reason,'cancelled');return false;});if(!state.busy&&!state.entries.length)groups.delete(key);}
    },
    pump,get count(){return count;},get bytes(){return bytes;},
  };
}
