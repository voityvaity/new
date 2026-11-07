'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function makeHarness({archiveStartFails=false,rejectLive=false,delayArchiveStart=false,
  delayCreatingJournal=false,failCreatingJournal=false,failGradeStoreInitially=false,
  failGradeRescueInitially=false}={}) {
  const handlers=new Map(),windowHandlers=new Map(),settingsWrites=[];
  const browserEvents=[],operationOrder=[],journalStates=[];
  let discarded=0;
  let releaseArchive=null,releaseJournal=null;
  let gradeStoreFails=failGradeStoreInitially,gradeRescueFails=failGradeRescueInitially;
  let backupGrade=null,copiedText=null,closeChoice=0,closeWarnings=0;
  let win;
  let resolveLive,resolveGrade,gradeRequests=0,creationRequests=0;
  let storedGrade=null;
  let destroyed=false;
  const prefs={rememberKey:true,count:5,key:'',saveJson:false,reportDirectory:'C:\\MockReports'};
  const fakeSettings={
    read:async()=>({...prefs}),
    save:async values=>{
      settingsWrites.push({...values});
      Object.assign(prefs,values);
      return {...prefs};
    }
  };
  const fakeArchive={
    start:async()=>{
      operationOrder.push('archive');
      if(archiveStartFails)throw Error('disk full');
      if(delayArchiveStart)await new Promise(resolve=>{releaseArchive=resolve;});
      return {id:'archive-1'};
    },
    discardEmpty:async()=>{discarded++;return {removed:true};},
    getEvaluation:async()=>storedGrade,
    storeEvaluation:async(_id,value)=>{
      if(gradeStoreFails)throw Error('archive disk full');
      storedGrade=value;
    },
    exportReport:async()=>({pdfFile:'C:\\MockReports\\report.pdf',jsonFile:null}),
    snapshot:async()=>({saved:true}),
    end:async()=>({saved:true}),
    list:async()=>[]
  };
  const fakeGuard={
    hasActive:()=>false,
    activate:({id})=>({sessionId:id,deadlineAt:new Date(Date.now()+1800000).toISOString(),limitSeconds:1800}),
    requestClose:()=>({state:'closing'}),
    snapshot:()=>({state:'idle'}),
    waitForResolution:async()=>({state:'idle'}),
    confirmClosed:()=>true,
    transportLost:()=>({state:'unconfirmed'}),
    acknowledgeUnknown:()=>true
  };
  const fakeWebContents={
    setWindowOpenHandler:()=>{},
    on:()=>{},
    send:(...args)=>browserEvents.push(args),
    id:1
  };
  class FakeBrowserWindow {
    constructor(){
      win=this;
      this.webContents=fakeWebContents;
    }
    on(name,handler){windowHandlers.set(name,handler);}
    removeMenu(){}
    loadFile(){}
    isDestroyed(){return destroyed;}
    destroy(){destroyed=true;}
    static getAllWindows(){return destroyed?[]:[win];}
  }
  const fakeElectron={
    app:{
      whenReady:()=>Promise.resolve(),
      getPath:()=>path.join(__dirname,'..'),
      on:()=>{},
      quit:()=>{}
    },
    BrowserWindow:FakeBrowserWindow,
    ipcMain:{handle:(name,handler)=>handlers.set(name,handler)},
    session:{defaultSession:{setPermissionRequestHandler:()=>{}}},
    safeStorage:{},
    dialog:{showMessageBox:async()=>{closeWarnings++;return {response:closeChoice};}},
    shell:{},
    clipboard:{writeText(value){copiedText=value;}}
  };
  const models=require('../src/logic');
  const live=require('../src/live-lifecycle');
  const policy=require('../src/key-retention');
  const sandbox={
    require(name){
      if(name==='electron')return fakeElectron;
      if(name==='node:fs/promises')return {readFile:async()=>{
        const error=Error('no closure state');error.code='ENOENT';throw error;
      }};
      if(name==='./secure-settings')return {createSettingsStore:()=>fakeSettings};
      if(name==='./interview-archive')return {
        createInterviewArchive:()=>fakeArchive,
        atomicWrite:async(_file,body)=>{
          const value=JSON.parse(body);
          journalStates.push(value.state);
          operationOrder.push('journal:'+value.state);
          if(value.state==='creating'){
            if(failCreatingJournal)throw Error('journal disk full');
            if(delayCreatingJournal)await new Promise(resolve=>{releaseJournal=resolve;});
          }
        }
      };
      if(name==='./pdf-printer')return {printReport:async()=>Buffer.from('%PDF-1.7')};
      if(name==='./live-lifecycle')return {createLiveGuard:()=>fakeGuard};
      if(name==='./key-retention')return policy;
      if(name==='./grade-recovery')return {createGradeRecoveryStore:()=>({
        get:async()=>backupGrade,
        save:async(_id,result)=>{
          if(gradeRescueFails)throw Error('rescue disk full');
          backupGrade=result;
        },
        remove:async()=>{backupGrade=null;}
      })};
      if(name==='./live-journal')return require('../src/live-journal');
      if(name==='./logic')return models;
      return require(name);
    },
    __dirname:path.join(__dirname,'../src'),
    console,
    Buffer,
    AbortSignal,
    setTimeout,clearTimeout,
    fetch(url){
      if(url.endsWith('/live/sessions')){
        operationOrder.push('http');
        creationRequests++;
        if(rejectLive)return Promise.resolve({
          ok:false,status:401,text:async()=>JSON.stringify({error:{message:'Unauthorized'}})
        });
        return new Promise(resolve=>{resolveLive=()=>resolve({
          ok:true,text:async()=>JSON.stringify({
            session:{id:'live-test'},transport:{sdp:'v=0\\r\\nanswer'}
          })
        });});
      }
      if(url.endsWith('/responses')){
        gradeRequests++;
        return new Promise(resolve=>{resolveGrade=()=>resolve({
          ok:true,text:async()=>JSON.stringify({
            output:[{content:[{type:'output_text',text:JSON.stringify({
              score:2,verdict:'Ответы слишком краткие',
              strengths:[],improve:['Практиковаться'],next_steps:['Повторить Python']
            })}]}]
          })
        });});
      }
      throw Error('Unexpected external request '+url);
    }
  };
  const main=fs.readFileSync(path.join(__dirname,'../src/main.js'),'utf8');
  vm.runInNewContext(main,sandbox,{filename:'src/main.js'});
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  return {
    tick,
    handlers,
    settingsWrites,
    browserEvents,
    operationOrder,journalStates,
    get discarded(){return discarded;},
    windowHandlers,
    get win(){return win;},
    get sender(){return {sender:fakeWebContents};},
    get creationRequests(){return creationRequests;},
    get gradeRequests(){return gradeRequests;},
    get storedGrade(){return storedGrade;},
    get destroyed(){return destroyed;},
    get backupGrade(){return backupGrade;},
    get copiedText(){return copiedText;},
    get closeWarnings(){return closeWarnings;},
    allowCloseWithoutSaving(){closeChoice=1;},
    allowGradeStore(){gradeStoreFails=false;},
    failGradeRescue(){gradeRescueFails=true;},
    releaseArchive:()=>releaseArchive?.(),
    releaseJournal:()=>releaseJournal?.(),
    releaseLive:()=>resolveLive(),
    releaseGrade:()=>resolveGrade()
  };
}
test('Clearing API key during delayed Live create is not undone by a late response',async()=>{
  const h=makeHarness();
  await h.tick();
  const pending=h.handlers.get('live:create')(h.sender,{
    key:'sk-sensitive',sdp:'v=0\\r\\noffer',count:5,rememberKey:true
  });
  await h.tick();
  assert.equal(h.creationRequests,1);
  await h.handlers.get('settings:clear-key')(h.sender);
  h.releaseLive();
  await pending;
  assert.ok(h.settingsWrites.some(x=>x.key===''));
  const afterClear=h.settingsWrites.slice(h.settingsWrites.findIndex(x=>x.key==='')+1);
  assert.ok(afterClear.every(x=>!('key' in x)),
    'A completed Live request must never restore cleared credentials');
});

test('duplicate grading is one paid call and closing the window waits for persistence',async()=>{
  const h=makeHarness();
  await h.tick();
  const created=h.handlers.get('live:create')(h.sender,{
    key:'sk-sensitive',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();h.releaseLive();await created;
  const payload={archiveId:'archive-1',count:5,turns:[
    {role:'candidate',text:'Не знаю.'}
  ]};
  const p1=h.handlers.get('interview:grade')(h.sender,payload);
  const p2=h.handlers.get('interview:grade')(h.sender,payload);
  await h.tick();
  assert.equal(h.gradeRequests,1);
  let prevented=false;
  h.windowHandlers.get('close')({preventDefault(){prevented=true;}});
  assert.equal(prevented,true);
  assert.equal(h.destroyed,false);
  assert.ok(h.browserEvents.some(args=>args[0]==='grade:close-pending'));
  h.releaseGrade();
  const [one,two]=await Promise.all([p1,p2]);
  assert.equal(one.score,2);
  assert.deepEqual(two,one);
  assert.equal(h.gradeRequests,1);
  assert.equal(h.storedGrade.score,2);
  await h.tick();
  assert.equal(h.destroyed,true,'Window must close after paid result was persisted');
});

test('archive and durable creation marker precede every paid Live HTTP request',async()=>{
  const h=makeHarness();await h.tick();
  const task=h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();
  assert.deepEqual(h.operationOrder.slice(0,3),
    ['archive','journal:creating','http']);
  h.releaseLive();
  await task;
  assert.ok(h.journalStates.includes('active'),
    'Session ID must be recorded before a successful create response');
});
test('disk failure prevents creating a paid session',async()=>{
  const h=makeHarness({archiveStartFails:true});await h.tick();
  await assert.rejects(h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  }),/disk full/);
  assert.equal(h.creationRequests,0);
});
test('rejected Live creation releases an empty local draft without leaving a billing lock',async()=>{
  const h=makeHarness({rejectLive:true});await h.tick();
  await assert.rejects(h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  }),/Unauthorized/);
  assert.equal(h.discarded,1);
  assert.deepEqual(h.journalStates,['creating','creation_rejected']);
});

test('cancellation while preparing local archive prevents paid session creation',async()=>{
  const h=makeHarness({delayArchiveStart:true});await h.tick();
  const task=h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();
  await h.handlers.get('live:hangup')(h.sender,{aborted:true});
  h.releaseArchive();
  await assert.rejects(task,/отменено/i);
  assert.equal(h.creationRequests,0);
  assert.equal(h.discarded,1);
  assert.deepEqual(h.journalStates,['creation_cancelled']);
});
test('cancellation during creation-marker write never sends a paid request',async()=>{
  const h=makeHarness({delayCreatingJournal:true});await h.tick();
  const task=h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();
  await h.handlers.get('live:hangup')(h.sender,{aborted:true});
  h.releaseJournal();
  await assert.rejects(task,/отменено/i);
  assert.equal(h.creationRequests,0);
  assert.ok(h.journalStates.includes('creation_cancelled'));
});
test('preflight journal failure does not trap the user in creating state',async()=>{
  const h=makeHarness({failCreatingJournal:true});await h.tick();
  await assert.rejects(h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  }),/journal disk full/);
  assert.equal(h.creationRequests,0);
  const snapshot=await h.handlers.get('live:get-status')(h.sender);
  assert.equal(snapshot.history.state,'preflight_failed');
  assert.equal(h.discarded,1);
});
test('paid grade survives primary archive failure without a duplicate model call',async()=>{
  const h=makeHarness({failGradeStoreInitially:true});await h.tick();
  const connecting=h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();h.releaseLive();await connecting;
  const payload={archiveId:'archive-1',count:5,
    turns:[{role:'candidate',text:'Не знаю.'}]};
  const grading=h.handlers.get('interview:grade')(h.sender,payload);
  await h.tick();h.releaseGrade();
  const result=await grading;
  assert.equal(result.score,2);
  assert.equal(result.evaluationSaved,false);
  assert.equal(result.recoveryStored,true);
  assert.equal(h.backupGrade.score,2);
  h.allowGradeStore();
  const saved=await h.handlers.get('reports:export')(h.sender,{id:'archive-1'});
  assert.ok(saved.pdfFile);
  assert.equal(h.storedGrade.score,2);
  assert.equal(h.gradeRequests,1);
});
test('when all disk writes fail, the paid grade remains copyable in-process',async()=>{
  const h=makeHarness({failGradeStoreInitially:true,failGradeRescueInitially:true});await h.tick();
  const connecting=h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();h.releaseLive();await connecting;
  const payload={archiveId:'archive-1',count:5,
    turns:[{role:'candidate',text:'Не знаю.'}]};
  const grading=h.handlers.get('interview:grade')(h.sender,payload);
  await h.tick();h.releaseGrade();
  const result=await grading;
  assert.equal(result.evaluationSaved,false);
  assert.equal(result.recoveryStored,false);
  await h.handlers.get('ui:copy-text')(h.sender,{text:'Оценка 2/10'});
  assert.equal(h.copiedText,'Оценка 2/10');
  h.allowGradeStore();
  const retry=await h.handlers.get('interview:grade')(h.sender,payload);
  assert.equal(retry.score,2);
  assert.equal(h.gradeRequests,1);
});

test('the user cannot accidentally close a lost paid grade without acknowledging data loss',async()=>{
  const h=makeHarness({failGradeStoreInitially:true,failGradeRescueInitially:true});await h.tick();
  const conn=h.handlers.get('live:create')(h.sender,{
    key:'sk-valid',sdp:'v=0\\r\\noffer',count:5,rememberKey:false
  });
  await h.tick();h.releaseLive();await conn;
  const grade=h.handlers.get('interview:grade')(h.sender,{
    archiveId:'archive-1',count:5,turns:[{role:'candidate',text:'Не знаю.'}]
  });
  await h.tick();h.releaseGrade();await grade;
  let prevented=false;
  h.windowHandlers.get('close')({preventDefault(){prevented=true;}});
  await h.tick();
  assert.equal(prevented,true);
  assert.equal(h.destroyed,false);
  assert.equal(h.closeWarnings,1);
  h.allowCloseWithoutSaving();
  h.windowHandlers.get('close')({preventDefault(){}});
  await h.tick();
  assert.equal(h.destroyed,true);
});
