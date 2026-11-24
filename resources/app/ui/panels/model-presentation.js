// Consume resolved DTO names. Raw identities remain in request parameters and
// data attributes, never substituted with aliases when filtering a report.
export function providerLabel(record={}) {
  return record.providerName || (record.provider==='direct'||record.providerId==='direct'?'直接接入':record.providerId||record.provider||record.vendor?'历史渠道':'未记录渠道');
}
export function modelLabel(record={}) {
  return record.modelName || (record.model&&record.model!=='unknown'?record.model:'未记录模型');
}
