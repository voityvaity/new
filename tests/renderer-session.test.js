'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function rendererHarness(confirmed) {
  const elements=new Map();
  let confirmations=0;
  const get=(id)=>{
    if(!elements.has(id))elements.set(id,{
      textContent:'',hidden:false,value:'',disabled:false,
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(){},setAttribute(){},
      replaceChildren(){},append(){},scrollHeight:0,scrollTop:0
    });
    return elements.get(id);
  };
  const context={
    document:{getElementById:get},
    window:{
      LiveTranscript:require('../src/transcript-tracker'),
      LiveLifecycle:require('../src/live-lifecycle'),
      LivePrompts:require('../src/live-prompts'),
      desktop:{confirmLiveClosed:async()=>{confirmations++;return confirmed;}},
      addEventListener(){}
    },
    console,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,
    Audio:class{constructor(){this.autoplay=false;} play(){return Promise.resolve();}},
    Date,Number,String,JSON
  };
  const source=fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8');
  const probes=[
    'globalThis.__test={',
    'beginClose(id){liveSessionId=id;finishing=true;',
    'closeResolve=result=>{globalThis.__out=result;};},',
    'deliver(event){onEvent(event);},',
    'getFinal(){return lastSessionClose;},',
    'getResult(){return globalThis.__out;}',
    '};'
  ].join('\n');
  vm.runInNewContext(source+'\n'+probes,context,{filename:'renderer.js'});
  return {context,get,deliver:event=>context.__test.deliver(event),
    beginClose:id=>context.__test.beginClose(id),
    getResult:()=>context.__test.getResult(),
    getFinal:()=>context.__test.getFinal(),
    get confirmations(){return confirmations;}};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('renderer never reports confirmed closing when main rejects the session ID',async()=>{
  const h=rendererHarness(false);
  h.beginClose('live-current');
  h.deliver({type:'session.closed',session:{id:'live-current'},
    reason:'close_requested',usage:{seconds:25}});
  await tick();
  assert.equal(h.confirmations,1);
  assert.equal(h.getResult()?.confirmed,false);
  assert.equal(h.getFinal(),null);
  assert.match(h.get('status').textContent,/Не удалось подтвердить/);
});

test('matching session with main-process acknowledgment confirms closing',async()=>{
  const h=rendererHarness(true);
  h.beginClose('live-current');
  h.deliver({type:'session.closed',session:{id:'live-current'},
    reason:'close_requested',usage:{seconds:25}});
  await tick();
  assert.equal(h.confirmations,1);
  assert.equal(h.getResult()?.confirmed,true);
  assert.equal(h.getFinal()?.sessionId,'live-current');
});

test('terminal event for unrelated session is ignored',async()=>{
  const h=rendererHarness(true);
  h.beginClose('live-current');
  h.deliver({type:'session.closed',session:{id:'live-another'}});
  await tick();
  assert.equal(h.confirmations,0);
  assert.equal(h.getFinal(),null);
  assert.equal(h.getResult(),undefined);
  assert.match(h.get('status').textContent,/другой сессии/);
});
