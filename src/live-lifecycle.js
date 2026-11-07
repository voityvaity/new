'use strict';

const LIVE_LIMIT_MS = 30 * 60 * 1000;
const READY_TIMEOUT_MS = 20 * 1000;
const FIRST_QUESTION_RETRY_MS = 12 * 1000;
const WARNING_REMAINING_MS = 5 * 60 * 1000;

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

// A session is ready only after the OpenAI event, SDP answer and data channel
// are all ready. Signal order is not guaranteed in WebRTC.
function createReadyGate({onReady, onTimeout, delayMs = READY_TIMEOUT_MS,
  schedule = setTimeout, cancel = clearTimeout}) {
  let armed = false, started = false, remote = false, channel = false;
  let ready = false, disposed = false, timer = null;
  function check() {
    if (!armed || disposed || ready || !started || !remote || !channel) return;
    ready = true;
    if (timer !== null) cancel(timer);
    timer = null;
    onReady();
  }
  function markStarted() { started = true; check(); }
  function markRemote() { remote = true; check(); }
  function markChannel() { channel = true; check(); }
  function arm() {
    if (armed || disposed) return;
    armed = true;
    timer = schedule(() => {
      timer = null;
      if (ready || disposed) return;
      disposed = true;
      onTimeout();
    }, delayMs);
    check();
  }
  function dispose() {
    disposed = true;
    if (timer !== null) cancel(timer);
    timer = null;
  }
  return {arm, markStarted, markRemote, markChannel, dispose,
    get ready(){return ready;}};
}

// Main-process deadline cannot be bypassed by renderer throttling.
// On expiry, notify the renderer and independently issue the server hangup.
// The API call is intentionally best-effort; a network outage cannot guarantee
// an immediate remote termination.
function createLiveGuard({hangup, notify, onError = () => {},
  limitMs = LIVE_LIMIT_MS, now = Date.now,
  schedule = setTimeout, cancel = clearTimeout}) {
  let active = null;
  function hasActive() {return active !== null;}
  function activate({id, key, startedAt}) {
    if (!id || !key) throw new Error('Missing active Live session credentials.');
    if (active) throw new Error('Another Live session is still active.');
    // Include session-creation latency in the spending limit.
    const measuredNow=now();
    const createdAt=Number.isFinite(startedAt)
      ? Math.min(measuredNow,startedAt) : measuredNow;
    const session = {id, key, createdAt, deadlineAt:createdAt+limitMs, timer:null};
    active = session;
    session.timer = schedule(() => {
      if (active !== session) return;
      try {notify({sessionId:session.id, limitMs});}
      catch(error) {onError(error);}
      void close().catch(onError);
    }, Math.max(0,session.deadlineAt-now()));
    return {sessionId:id, deadlineAt:new Date(session.deadlineAt).toISOString(),
      limitSeconds:limitMs/1000};
  }
  async function close({requestHangup = true} = {}) {
    if (!active) return false;
    const old = active;
    active = null;
    if (old.timer !== null) cancel(old.timer);
    if (requestHangup) await hangup(old.id,old.key);
    return true;
  }
  return {activate, close, hasActive};
}

if (typeof module !== 'undefined' && module.exports)
  module.exports = {LIVE_LIMIT_MS, READY_TIMEOUT_MS, FIRST_QUESTION_RETRY_MS,
    WARNING_REMAINING_MS, formatClock, cumulativeUsage, createReadyGate, createLiveGuard};
if (typeof window !== 'undefined')
  window.LiveLifecycle = {LIVE_LIMIT_MS, READY_TIMEOUT_MS, FIRST_QUESTION_RETRY_MS,
    WARNING_REMAINING_MS, formatClock, cumulativeUsage, createReadyGate};
