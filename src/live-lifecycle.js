'use strict';

const LIVE_LIMIT_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 20 * 1000;
const FIRST_QUESTION_RETRY_MS = 12 * 1000;
const WARNING_REMAINING_MS = 5 * 60 * 1000;
const CLOSE_GRACE_MS = 6500;

function formatClock(ms) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(seconds / 60)).padStart(2, '0') + ':' +
    String(seconds % 60).padStart(2, '0');
}
function cumulativeUsage(previous, event) {
  const seconds = event?.usage?.seconds;
  return Number.isFinite(seconds) && seconds >= 0
    ? Math.max(previous, seconds) : previous;
}

// Network and WebRTC events can arrive in any order.
function createReadyGate({onReady, onTimeout, delayMs = READY_TIMEOUT_MS,
  schedule = setTimeout, cancel = clearTimeout}) {
  let armed=false, started=false, remote=false, channel=false;
  let ready=false, disposed=false, timer=null;
  function check() {
    if(!armed || disposed || ready || !started || !remote || !channel)return;
    ready=true;
    if(timer!==null)cancel(timer);
    timer=null;
    onReady();
  }
  function markStarted(){started=true;check();}
  function markRemote(){remote=true;check();}
  function markChannel(){channel=true;check();}
  function arm() {
    if(armed || disposed)return;
    armed=true;
    timer=schedule(()=>{
      timer=null;
      if(ready || disposed)return;
      disposed=true;
      onTimeout();
    },delayMs);
    check();
  }
  function dispose(){disposed=true;if(timer!==null)cancel(timer);timer=null;}
  return {arm,markStarted,markRemote,markChannel,dispose,get ready(){return ready;}};
}

// WebRTC must terminate via the data channel's session.close followed by the
// server's session.closed. HTTP /hangup is documented for SIP; use it only as
// an emergency best-effort fallback, NEVER as proof a WebRTC session ended.
// Keep unresolved sessions locked until confirmed or explicitly acknowledged.
function createLiveGuard({
  fallbackHangup = async()=>{},
  notify = ()=>{}, onUnconfirmed = ()=>{},
  limitMs=LIVE_LIMIT_MS, closeGraceMs=CLOSE_GRACE_MS,
  now=Date.now, schedule=setTimeout, cancel=clearTimeout
}) {
  let active=null;
  let lastClosure=null;
  const waiters=new Set();
  function clearTimers(s) {
    if(s.deadlineTimer!==null)cancel(s.deadlineTimer);
    if(s.graceTimer!==null)cancel(s.graceTimer);
    s.deadlineTimer=s.graceTimer=null;
  }
  function settle(status) {
    for(const resolve of waiters)resolve(status);
    waiters.clear();
  }
  function snapshot(){
    if(!active)return {state:'idle',lastClosure};
    return {state:active.state,sessionId:active.id,
      deadlineAt:new Date(active.deadlineAt).toISOString(),
      requestedReason:active.reason, lastClosure};
  }
  function hasActive(){return active!==null;}
  function activate({id,key,startedAt}) {
    if(typeof id!=='string'||!id || typeof key!=='string'||!key)
      throw new Error('Missing Live session credentials.');
    if(active)throw new Error('Previous Live session is not confirmed closed.');
    const time=now();
    const createdAt=Number.isFinite(startedAt)?Math.min(time,startedAt):time;
    const s={id,key,createdAt,deadlineAt:createdAt+limitMs,state:'open',
      reason:null,deadlineTimer:null,graceTimer:null};
    active=s;
    s.deadlineTimer=schedule(()=>{
      if(active===s)requestClose('time_limit');
    },Math.max(0,s.deadlineAt-now()));
    return {sessionId:id,deadlineAt:new Date(s.deadlineAt).toISOString(),
      limitSeconds:limitMs/1000};
  }
  function markUnconfirmed(reason='no_session_closed') {
    if(!active)return snapshot();
    const s=active;
    if(s.state==='unconfirmed')return snapshot();
    s.state='unconfirmed';
    s.reason=s.reason||reason;
    clearTimers(s);
    lastClosure={sessionId:s.id,state:'unconfirmed',reason,at:new Date(now()).toISOString()};
    try{onUnconfirmed(snapshot());}catch{}
    settle(snapshot());
    return snapshot();
  }
  async function emergencyFallback(s) {
    if(active!==s || s.state!=='closing')return;
    // A successful SIP hangup response still does NOT confirm WebRTC finalization.
    try{await fallbackHangup(s.id,s.key);}
    catch{/* Expected on WebRTC-only endpoints or during network outages. */}
    if(active===s)markUnconfirmed('terminal_event_missing');
  }
  function requestClose(reason='manual') {
    if(!active)return snapshot();
    const s=active;
    if(s.state==='unconfirmed')return snapshot();
    if(s.state==='closing')return snapshot();
    s.state='closing';
    s.reason=reason;
    if(s.deadlineTimer!==null)cancel(s.deadlineTimer);
    s.deadlineTimer=null;
    try{notify({sessionId:s.id,reason,limitMs});}
    catch{/* Renderer might already have closed. */}
    s.graceTimer=schedule(()=>{void emergencyFallback(s);},closeGraceMs);
    return snapshot();
  }
  function confirmClosed({sessionId,reason='close_requested',usageSeconds=null}={}) {
    if(!active || active.id!==sessionId)return false;
    const s=active;
    clearTimers(s);
    active=null;
    lastClosure={sessionId:s.id,state:'confirmed',reason,
      usageSeconds:Number.isFinite(usageSeconds)?usageSeconds:null,
      at:new Date(now()).toISOString()};
    settle(snapshot());
    return true;
  }
  function transportLost(sessionId) {
    if(!active || active.id!==sessionId)return snapshot();
    // Closing a PeerConnection is not a terminal event from OpenAI.
    return markUnconfirmed('transport_lost_without_session_closed');
  }
  function acknowledgeUnknown() {
    if(!active || active.state!=='unconfirmed')return false;
    const s=active;
    clearTimers(s);active=null;
    lastClosure={sessionId:s.id,state:'unconfirmed_acknowledged',
      reason:'user_accepted_risk',at:new Date(now()).toISOString()};
    settle(snapshot());
    return true;
  }
  function waitForResolution(timeoutMs=8500) {
    if(!active || active.state==='unconfirmed')return Promise.resolve(snapshot());
    return new Promise(resolve=>{
      const t=setTimeout(()=>{waiters.delete(done);resolve(snapshot());},timeoutMs);
      function done(value){clearTimeout(t);resolve(value);}
      waiters.add(done);
    });
  }
  return {activate,requestClose,confirmClosed,transportLost,acknowledgeUnknown,
    markUnconfirmed,waitForResolution,snapshot,hasActive};
}

if(typeof module!=='undefined' && module.exports)
  module.exports={LIVE_LIMIT_MS,READY_TIMEOUT_MS,FIRST_QUESTION_RETRY_MS,
    WARNING_REMAINING_MS,CLOSE_GRACE_MS,formatClock,cumulativeUsage,createReadyGate,createLiveGuard};
if(typeof window!=='undefined')
  window.LiveLifecycle={LIVE_LIMIT_MS,READY_TIMEOUT_MS,FIRST_QUESTION_RETRY_MS,
    WARNING_REMAINING_MS,formatClock,cumulativeUsage,createReadyGate};
