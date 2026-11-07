'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {recoverLiveJournal,canStartLive}=require('../src/live-journal');
test('unknown Live state survives restart; no second paid session by default',()=>{
  for(const state of ['creating','active','closing']){
    const record={state,sessionId:'live-123',archiveId:'draft-123'};
    const restarted=recoverLiveJournal(record);
    assert.equal(restarted.state,'unconfirmed');
    assert.equal(restarted.sessionId,'live-123');
    assert.equal(restarted.archiveId,'draft-123');
    assert.equal(canStartLive(restarted),false);
  }
});
test('confirmed or rejected creation never causes a false billing lock',()=>{
  for(const state of ['confirmed','creation_rejected','unconfirmed_acknowledged']){
    const record={state};
    assert.equal(recoverLiveJournal(record),null);
    assert.equal(canStartLive(record),true);
  }
});
test('unconfirmed records stay unresolved until explicit acknowledgement',()=>{
  const record={state:'unconfirmed',reason:'connection_lost'};
  assert.equal(recoverLiveJournal(record),record);
  assert.equal(canStartLive(record),false);
});
