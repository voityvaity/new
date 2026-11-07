'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
  LIVE_LIMIT_MS,READY_TIMEOUT_MS,FIRST_QUESTION_RETRY_MS,
  WARNING_REMAINING_MS,CLOSE_GRACE_MS,
  formatClock,cumulativeUsage,createReadyGate,createLiveGuard
}=require('../src/live-lifecycle');

function fakeTimers() {
  let nextId=1;
  const entries=new Map();
  return {
    schedule(fn,ms){const id=nextId++;entries.set(id,{fn,ms});return id;},
    cancel(id){entries.delete(id);},
    fire(){const first=entries.entries().next().value;
      assert.ok(first,'Expected pending timer');entries.delete(first[0]);first[1].fn();},
    get count(){return entries.size;},
    get delays(){return [...entries.values()].map(v=>v.ms);}
  };
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('ready only when SDP, data channel and session.started are all confirmed',()=>{
  for(const ordering of [
    ['markRemote','markChannel','markStarted'],
    ['markStarted','markRemote','markChannel'],
    ['markChannel','markStarted','markRemote']
  ]){
    const clock=fakeTimers();let ready=0,expired=0;
    const gate=createReadyGate({onReady(){ready++;},onTimeout(){expired++;},
      schedule:clock.schedule,cancel:clock.cancel});
    gate.arm();
    assert.deepEqual(clock.delays,[READY_TIMEOUT_MS]);
    gate[ordering[0]]();gate[ordering[1]]();assert.equal(ready,0);
    gate[ordering[2]]();gate[ordering[2]]();
    assert.equal(ready,1);assert.equal(clock.count,0);assert.equal(expired,0);
  }
});

test('ready timeout disposes stale callbacks',()=>{
  const clock=fakeTimers();let ready=0,expired=0;
  const gate=createReadyGate({onReady(){ready++;},onTimeout(){expired++;},
    schedule:clock.schedule,cancel:clock.cancel});
  gate.arm();clock.fire();gate.markStarted();gate.markRemote();gate.markChannel();
  assert.equal(ready,0);assert.equal(expired,1);
  const next=createReadyGate({onReady(){ready++;},onTimeout(){expired++;},
    schedule:clock.schedule,cancel:clock.cancel});
  next.arm();next.dispose();assert.equal(clock.count,0);
});

test('the 30-minute deadline requests WebRTC session.close, not SIP hangup as confirmation',()=>{
  const clock=fakeTimers(),calls=[],fallback=[];
  const guard=createLiveGuard({
    notify:payload=>calls.push(payload),
    fallbackHangup:async id=>fallback.push(id),
    now:()=>1000,schedule:clock.schedule,cancel:clock.cancel
  });
  const info=guard.activate({id:'live-1',key:'sk-secret'});
  assert.equal(info.limitSeconds,1800);
  assert.deepEqual(clock.delays,[LIVE_LIMIT_MS]);
  clock.fire(); // deadline
  assert.equal(guard.snapshot().state,'closing');
  assert.deepEqual(calls,[{sessionId:'live-1',reason:'time_limit',limitMs:LIVE_LIMIT_MS}]);
  assert.deepEqual(fallback,[],'No SIP fallback before grace period');
  assert.deepEqual(clock.delays,[CLOSE_GRACE_MS]);
  assert.throws(()=>guard.activate({id:'live-2',key:'sk-secret'}),/not confirmed closed/);
  assert.equal(guard.confirmClosed({sessionId:'live-1',usageSeconds:22.5}),true);
  assert.equal(clock.count,0);
  assert.equal(guard.snapshot().state,'idle');
  assert.equal(guard.snapshot().lastClosure.usageSeconds,22.5);
});

test('failed fallback does not forget a paid session or permit an immediate new one',async()=>{
  const clock=fakeTimers(),errors=[],unknown=[];
  const guard=createLiveGuard({
    notify:()=>{}, fallbackHangup:async()=>{errors.push('network down');throw Error('network down');},
    onUnconfirmed:status=>unknown.push(status.state),
    schedule:clock.schedule,cancel:clock.cancel
  });
  guard.activate({id:'live-failed',key:'sk-secret'});
  guard.requestClose('manual');
  assert.equal(guard.snapshot().state,'closing');
  clock.fire();await tick();
  assert.deepEqual(errors,['network down']);
  assert.deepEqual(unknown,['unconfirmed']);
  assert.equal(guard.hasActive(),true);
  assert.throws(()=>guard.activate({id:'new',key:'sk-secret'}),/not confirmed closed/);
  assert.equal(guard.acknowledgeUnknown(),true);
  assert.equal(guard.hasActive(),false);
  guard.activate({id:'new',key:'sk-secret'});
  guard.requestClose();
  guard.confirmClosed({sessionId:'new'});
});

test('even a successful SIP fallback does NOT confirm WebRTC closure',async()=>{
  const clock=fakeTimers();let fallback=0;
  const guard=createLiveGuard({
    fallbackHangup:async()=>{fallback++;},
    schedule:clock.schedule,cancel:clock.cancel
  });
  guard.activate({id:'live-x',key:'sk'});
  guard.requestClose();clock.fire();await tick();
  assert.equal(fallback,1);
  assert.equal(guard.snapshot().state,'unconfirmed');
  assert.equal(guard.confirmClosed({sessionId:'different'}),false);
  // A late genuine session.closed can still reconcile an uncertain status.
  assert.equal(guard.confirmClosed({sessionId:'live-x',reason:'close_requested'}),true);
  assert.equal(guard.hasActive(),false);
});

test('transport loss is unconfirmed; explicit acknowledgment is required',()=>{
  const clock=fakeTimers();let flagged=0;
  const guard=createLiveGuard({
    onUnconfirmed:()=>flagged++,schedule:clock.schedule,cancel:clock.cancel
  });
  guard.activate({id:'lost-1',key:'sk'});
  guard.transportLost('wrong');
  assert.equal(guard.snapshot().state,'open');
  guard.transportLost('lost-1');
  assert.equal(guard.snapshot().state,'unconfirmed');
  assert.equal(flagged,1);
  assert.equal(clock.count,0);
  assert.equal(guard.acknowledgeUnknown(),true);
  assert.equal(guard.snapshot().lastClosure.state,'unconfirmed_acknowledged');
});

test('close is idempotent, waits for confirmation and releases registered waiters',async()=>{
  const clock=fakeTimers();let signals=0;
  const guard=createLiveGuard({
    notify:()=>signals++,schedule:clock.schedule,cancel:clock.cancel
  });
  guard.activate({id:'live-wait',key:'sk'});
  guard.requestClose('manual');
  guard.requestClose('manual');
  assert.equal(signals,1);
  const settled=guard.waitForResolution(1000);
  guard.confirmClosed({sessionId:'live-wait'});
  const outcome=await settled;
  assert.equal(outcome.state,'idle');
  assert.equal(clock.count,0);
});

test('HTTP creation interval counts against deadline',()=>{
  const clock=fakeTimers();
  const guard=createLiveGuard({
    now:()=>100000,schedule:clock.schedule,cancel:clock.cancel
  });
  const info=guard.activate({id:'live-late',key:'sk',startedAt:85000});
  assert.equal(new Date(info.deadlineAt).getTime(),85000+LIVE_LIMIT_MS);
  assert.deepEqual(clock.delays,[LIVE_LIMIT_MS-15000]);
  guard.confirmClosed({sessionId:'live-late'});
});

test('usage updates are cumulative and the UI timer is formatted consistently',()=>{
  let seconds=0;
  for(const value of [12,15,13,-1])
    seconds=cumulativeUsage(seconds,{usage:{seconds:value}});
  assert.equal(seconds,15);
  assert.equal(formatClock(65000),'01:05');
  assert.equal(formatClock(-3000),'00:00');
  assert.equal(WARNING_REMAINING_MS,300000);
  assert.equal(FIRST_QUESTION_RETRY_MS,12000);
});
