const record=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:{};
const numeric=(value,fallback,min,max=Infinity)=>typeof value==='number'&&Number.isFinite(value)?Math.min(max,Math.max(min,value)):fallback;

// The account switch is always authoritative. Per-chat overrides are sparse:
// missing fields continue to follow the global defaults, including after edits.
export function proactivePolicy(config,chatKey='') {
  const base=record(config?.proactive),split=base.unified===false;
  const local=split&&/^(group|private):[1-9]\d{0,14}$/.test(chatKey)?record(record(base.byChat)[chatKey]):{};
  const value=key=>Object.hasOwn(local,key)?local[key]:base[key];
  const min=numeric(value('checkIntervalMinMs'),1_800_000,60_000);
  return {enabled:base.enabled===true&&local.enabled!==false,
    idleThresholdMs:numeric(value('idleThresholdMs'),1_800_000,300_000),
    checkIntervalMinMs:min,checkIntervalMaxMs:Math.max(min,numeric(value('checkIntervalMaxMs'),5_400_000,60_000))};
}
