'use strict';
// A startup marker is not an OpenAI billing record. It is a fail-closed local
// safety guard: after an unexpected process exit we cannot prove remote close.
const UNRESOLVED_STATES=new Set(['creating','active','closing','unconfirmed']);
function recoverLiveJournal(record) {
  if(!record||typeof record!=='object'||Array.isArray(record))return null;
  if(!UNRESOLVED_STATES.has(record.state))return null;
  if(record.state==='unconfirmed')return record;
  return {
    state:'unconfirmed',
    sessionId:typeof record.sessionId==='string'?record.sessionId:null,
    archiveId:typeof record.archiveId==='string'?record.archiveId:null,
    reason:'interrupted_'+record.state,
    at:new Date().toISOString()
  };
}
function canStartLive(record) {
  return !record || !UNRESOLVED_STATES.has(record.state);
}
module.exports={recoverLiveJournal,canStartLive};
