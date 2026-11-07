'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {
  LIVE_LIMIT_MS, READY_TIMEOUT_MS, FIRST_QUESTION_RETRY_MS,
  WARNING_REMAINING_MS, formatClock, cumulativeUsage,
  createReadyGate,createLiveGuard
}=require('../src/live-lifecycle');

function fakeTimers() {
  let nextId=1;
  const entries=new Map();
  return {
    schedule(fn,ms){const id=nextId++;entries.set(id,{fn,ms});return id;},
    cancel(id){entries.delete(id);},
    fire(){const first=entries.entries().next().value;
      assert.ok(first,'Expected pending timer');
      entries.delete(first[0]);first[1].fn();},
    get count(){return entries.size;},
    get delays(){return [...entries.values()].map(v=>v.ms);}
  };
}

test('shows ready only after SDP, data channel AND session.started in any order',()=>{
  for(const ordering of [
    ['markRemote','markChannel','markStarted'],
    ['markStarted','markRemote','markChannel'],
    ['markChannel','markStarted','markRemote']
  ]){
    const clock=fakeTimers();
    let ready=0, timedOut=0;
    const gate=createReadyGate({
      onReady(){ready++;},onTimeout(){timedOut++;},
      schedule:clock.schedule,cancel:clock.cancel
    });
    gate.arm();
    assert.deepEqual(clock.delays,[READY_TIMEOUT_MS]);
    gate[ordering[0]]();gate[ordering[1]]();
    assert.equal(ready,0);
    gate[ordering[2]]();
    assert.equal(ready,1);
    gate[ordering[2]]();
    assert.equal(ready,1,'Must activate exactly once');
    assert.equal(clock.count,0);
    assert.equal(timedOut,0);
  }
});

test('ready timeout and cancellation never activate a stale session',()=>{
  const clock=fakeTimers();
  let ready=0, expired=0;
  const gate=createReadyGate({
    onReady(){ready++;},onTimeout(){expired++;},
    schedule:clock.schedule,cancel:clock.cancel
  });
  gate.markStarted();gate.arm();clock.fire();
  gate.markRemote();gate.markChannel();
  assert.equal(expired,1);
  assert.equal(ready,0);
  const another=createReadyGate({
    onReady(){ready++;},onTimeout(){expired++;},
    schedule:clock.schedule,cancel:clock.cancel
  });
  another.arm();another.dispose();
  assert.equal(clock.count,0);
});

test('main process hangs up exact active session at 30-minute deadline',async()=>{
  const clock=fakeTimers();
  const calls=[],notifications=[],errors=[];
  const guard=createLiveGuard({
    hangup:async(id,key)=>{calls.push({id,key});},
    notify:payload=>notifications.push(payload),
    onError:e=>errors.push(e.message),
    now:()=>1000,schedule:clock.schedule,cancel:clock.cancel
  });
  const info=guard.activate({id:'live-test-1',key:'sk-test'});
  assert.equal(info.sessionId,'live-test-1');
  assert.equal(info.limitSeconds,1800);
  assert.deepEqual(clock.delays,[LIVE_LIMIT_MS]);
  clock.fire();
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(notifications,[{sessionId:'live-test-1',limitMs:LIVE_LIMIT_MS}]);
  assert.deepEqual(calls,[{id:'live-test-1',key:'sk-test'}]);
  assert.equal(guard.hasActive(),false);
  assert.deepEqual(errors,[]);
});

test('manual stop cancels deadline; repeated close never hangs up twice',async()=>{
  const clock=fakeTimers();let calls=0,notice=0;
  const guard=createLiveGuard({
    hangup:async()=>{calls++;},notify:()=>{notice++;},
    schedule:clock.schedule,cancel:clock.cancel
  });
  guard.activate({id:'live-2',key:'sk-test'});
  await guard.close();
  await guard.close();
  assert.equal(clock.count,0);
  assert.equal(calls,1);
  assert.equal(notice,0);
  guard.activate({id:'live-3',key:'sk-test'});
  assert.equal(guard.hasActive(),true);
  await guard.close({requestHangup:false});
  assert.equal(calls,1);
});

test('usage updates are cumulative, not additive, and never include model cost',()=>{
  let seconds=0;
  seconds=cumulativeUsage(seconds,{usage:{seconds:12}});
  seconds=cumulativeUsage(seconds,{usage:{seconds:15}});
  seconds=cumulativeUsage(seconds,{usage:{seconds:13}});
  seconds=cumulativeUsage(seconds,{usage:{seconds:-1}});
  assert.equal(seconds,15);
  assert.equal(formatClock(65000),'01:05');
  assert.equal(formatClock(-3000),'00:00');
  assert.equal(WARNING_REMAINING_MS,300000);
  assert.equal(FIRST_QUESTION_RETRY_MS,12000);
});

test('cannot register two simultaneous paid Live sessions',async()=>{
  const clock=fakeTimers();
  const guard=createLiveGuard({
    hangup:async()=>{},notify:()=>{},
    schedule:clock.schedule,cancel:clock.cancel
  });
  guard.activate({id:'live-a',key:'sk-a'});
  assert.throws(()=>guard.activate({id:'live-b',key:'sk-b'}),/still active/);
  await guard.close();
});

test('backend duration limit includes the HTTP creation interval',async()=>{
  const clock=fakeTimers();
  const guard=createLiveGuard({
    hangup:async()=>{},notify:()=>{},
    now:()=>100000,schedule:clock.schedule,cancel:clock.cancel
  });
  const info=guard.activate({id:'live-late',key:'sk-test',startedAt:85000});
  assert.equal(new Date(info.deadlineAt).getTime(),85000+LIVE_LIMIT_MS);
  assert.deepEqual(clock.delays,[LIVE_LIMIT_MS-15000]);
  await guard.close();
});
