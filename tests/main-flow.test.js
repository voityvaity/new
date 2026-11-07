'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');

function makeHarness() {
  const handlers=new Map(),windowHandlers=new Map(),settingsWrites=[];
  const browserEvents=[];
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
    start:async()=>({id:'archive-1'}),
    getEvaluation:async()=>storedGrade,
    storeEvaluation:async(_id,value)=>{storedGrade=value;},
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
    dialog:{},
    shell:{}
  };
  const models=require('../src/logic');
  const live=require('../src/live-lifecycle');
  const policy=require('../src/key-retention');
  const sandbox={
    require(name){
      if(name==='electron')return fakeElectron;
      if(name==='node:fs/promises')return {readFile:async()=>{throw Error('no closure state');}};
      if(name==='./secure-settings')return {createSettingsStore:()=>fakeSettings};
      if(name==='./interview-archive')return {
        createInterviewArchive:()=>fakeArchive,
        atomicWrite:async()=>{}
      };
      if(name==='./pdf-printer')return {printReport:async()=>Buffer.from('%PDF-1.7')};
      if(name==='./live-lifecycle')return {createLiveGuard:()=>fakeGuard};
      if(name==='./key-retention')return policy;
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
        creationRequests++;
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
    windowHandlers,
    get win(){return win;},
    get sender(){return {sender:fakeWebContents};},
    get creationRequests(){return creationRequests;},
    get gradeRequests(){return gradeRequests;},
    get storedGrade(){return storedGrade;},
    get destroyed(){return destroyed;},
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
