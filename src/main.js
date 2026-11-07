'use strict';
const {app,BrowserWindow,ipcMain,session,safeStorage,dialog,shell} = require('electron');
const fs = require('node:fs/promises');
const {createSettingsStore} = require('./secure-settings');
const path = require('node:path');
const {makeSession,makeGradeRequest,parseGrade,questionCount} = require('./logic');
const {createInterviewArchive,atomicWrite} = require('./interview-archive');
const {printReport} = require('./pdf-printer');
const {createLiveGuard} = require('./live-lifecycle');
const {createKeyRetentionPolicy} = require('./key-retention');
let mainWindow=null;
let apiKey=null;
let settings=null;
let archive=null;
let liveGuard=null;
let quitHangupStarted=false;
let creatingLive=false, cancelPendingCreate=false, creatingLivePromise=null;
const keyRetention=createKeyRetentionPolicy();
let gradingTask=null, gradingArchiveId=null;
let closureStatusFile=null, storedClosure=null, closureLoaded=Promise.resolve();
let closureWrites=Promise.resolve();
function rememberClosure(value) {
  storedClosure=value;
  if(!closureStatusFile)return Promise.resolve();
  // Serialize changes so a late "unconfirmed" write cannot overwrite a
  // newer confirmed/acknowledged state on disk.
  const work=closureWrites.then(()=>atomicWrite(closureStatusFile,JSON.stringify(value,null,2)));
  closureWrites=work.catch(error=>console.warn('Cannot save Live closure status:',error.message));
  return work;
}

async function hangupRemote(sessionId,key) {
  // Best-effort emergency fallback ONLY. This endpoint is documented for SIP;
  // its response does not certify termination of a WebRTC voice session.
  const url='https://api.openai.com/v1/live/sessions/'+encodeURIComponent(sessionId)+'/hangup';
  const response=await fetch(url,{
    method:'POST',headers:{Authorization:'Bearer '+key},
    signal:AbortSignal.timeout(6500)
  });
  if(!response.ok && response.status!==404 && response.status!==409)
    throw new Error('Не удалось подтвердить завершение голосовой сессии: HTTP '+response.status);
}
function closeLiveInBackground(reason='manual') {
  if(liveGuard?.hasActive())liveGuard.requestClose(reason);
}
function currentLiveStatus() {
  const status=liveGuard?.snapshot()||{state:'idle'};
  return {...status,history:storedClosure};
}

async function post(url,key,payload,timeout=60000) {
  const response=await fetch(url,{method:'POST',headers:{
    'Authorization':'Bearer '+key,'Content-Type':'application/json'
  },body:JSON.stringify(payload),signal:AbortSignal.timeout(timeout)});
  const raw=await response.text();
  let json=null;
  try { json=JSON.parse(raw); } catch {}
  if (!response.ok) {
    const reason=typeof json?.error?.message==='string' ? json.error.message.slice(0,220):('HTTP '+response.status);
    throw new Error('Ошибка OpenAI API: '+reason);
  }
  if (!json||typeof json!=='object') throw new Error('Неожиданный ответ OpenAI API.');
  return json;
}

function validateSender(event) {
  if (!mainWindow||event.sender!==mainWindow.webContents) throw new Error('Недопустимый источник запроса.');
}

function createWindow() {
  mainWindow=new BrowserWindow({
    width:1080,height:820,minWidth:730,minHeight:640,backgroundColor:'#0b1020',
    title:'Python Junior Mock',
    icon:path.join(__dirname,'../assets/quickcue-graphite.png'),
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  mainWindow.removeMenu();
  let windowCloseRequested=false;
  mainWindow.on('close',event=>{
    if(windowCloseRequested){event.preventDefault();return;}
    if(gradingTask){
      event.preventDefault();
      windowCloseRequested=true;
      const windowToClose=mainWindow;
      if(!windowToClose.isDestroyed())
        windowToClose.webContents.send('grade:close-pending');
      // Keep Electron alive until the paid result has been written, up to a
      // bounded timeout beyond the Responses HTTP request deadline.
      let timer;
      const limit=new Promise(resolve=>{timer=setTimeout(resolve,105000);});
      void Promise.race([gradingTask.catch(()=>{}),limit]).finally(()=>{
        clearTimeout(timer);
        if(!windowToClose.isDestroyed())windowToClose.destroy();
      });
      return;
    }
    if(!creatingLive && !liveGuard?.hasActive())return;
    event.preventDefault();
    windowCloseRequested=true;
    const windowToClose=mainWindow;
    if(!windowToClose.isDestroyed())
      windowToClose.webContents.send('live:window-close-request');
    setTimeout(()=>{
      if(!windowToClose.isDestroyed())windowToClose.destroy();
    },8500);
  });
  mainWindow.loadFile(path.join(__dirname,'index.html'));
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',e=>e.preventDefault());
}

app.whenReady().then(()=>{
  const userData=app.getPath('userData');
  closureStatusFile=path.join(userData,'live-closure-status.json');
  closureLoaded=fs.readFile(closureStatusFile,'utf8').then(raw=>{
    storedClosure=JSON.parse(raw);
    if(storedClosure?.state==='confirmed')storedClosure=null;
  }).catch(()=>{});
  settings=createSettingsStore({
    userData, secureStorage:safeStorage,
    defaultReportDirectory:path.join(app.getPath('documents'),'Python Junior Mock','Интервью')
  });
  archive=createInterviewArchive({
    draftDirectory:path.join(userData,'interview-drafts'),
    generatePdf:printReport
  });
  liveGuard=createLiveGuard({
    fallbackHangup:hangupRemote,
    notify:payload=>{
      if(mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('live:close-request',payload);
    },
    onUnconfirmed:status=>{
      void rememberClosure({state:'unconfirmed',sessionId:status.sessionId,
        reason:status.lastClosure?.reason||'no_session_closed',
        at:new Date().toISOString()});
      if(mainWindow && !mainWindow.isDestroyed())
        mainWindow.webContents.send('live:unconfirmed',status);
    }
  });
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>{
    callback(Boolean(mainWindow&&contents.id===mainWindow.webContents.id&&permission==='media'&&contents.getURL().startsWith('file://')));
  });
  createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{apiKey=null;if(process.platform!=='darwin')app.quit();});
app.on('before-quit',event=>{
  if(quitHangupStarted||(!creatingLive && !liveGuard?.hasActive() && !gradingTask))return;
  event.preventDefault();
  quitHangupStarted=true;
  cancelPendingCreate=true;
  void (async()=>{
    // Do not discard an already-paid Responses result during a graceful exit.
    if(gradingTask){
      let gradeTimeout;
      const limit=new Promise(resolve=>{gradeTimeout=setTimeout(resolve,105000);});
      await Promise.race([gradingTask.catch(()=>{}),limit]);
      clearTimeout(gradeTimeout);
    }
    // Do not abandon a request that might have created a paid session.
    if(creatingLivePromise){
      let timeoutId;
      const timeout=new Promise(resolve=>{timeoutId=setTimeout(resolve,47000);});
      await Promise.race([creatingLivePromise.catch(()=>{}),timeout]);
      clearTimeout(timeoutId);
      if(creatingLive){
        await rememberClosure({state:'unconfirmed',
          reason:'window_closed_while_session_creation_pending',
          at:new Date().toISOString()});
      }
    }
    if(liveGuard?.hasActive()){
      liveGuard.requestClose('app_quit');
      const state=await liveGuard.waitForResolution(8500);
      if(state.state!=='idle'&&state.state!=='unconfirmed')
        liveGuard.markUnconfirmed('app_quit_without_terminal_event');
      const current=liveGuard.snapshot();
      if(current.state==='unconfirmed')
        await rememberClosure({state:'unconfirmed',sessionId:current.sessionId,
          reason:current.lastClosure?.reason||'app_quit_without_confirmation',
          at:new Date().toISOString()});
    }
  })().catch(error=>console.warn('Graceful quit:',error.message))
    .finally(()=>app.quit());
});

ipcMain.handle('live:create',async(event,payload={})=>{
  validateSender(event);
  const {key,sdp,count,rememberKey}=payload||{};
  if(typeof key!=='string'||!key.startsWith('sk-')||key.length>512)throw new Error('Нужен ключ OpenAI API (sk-...).');
  if(typeof sdp!=='string'||!sdp.startsWith('v=0')||sdp.length>65536)throw new Error('Некорректный SDP микрофона.');
  await closureLoaded;
  if(storedClosure?.state==='unconfirmed')
    throw new Error('Завершение предыдущей голосовой сессии не подтверждено. Проверь предупреждение и подтверди продолжение на свой риск.');
  if(creatingLive || liveGuard.hasActive())
    throw new Error('Предыдущая платная сессия ещё не подтверждена закрытой.');
  creatingLive=true;
  cancelPendingCreate=false;
  const savedKeyRevision=keyRetention.snapshot();
  try{
  const requestedAt=Date.now();
  creatingLivePromise=post('https://api.openai.com/v1/live/sessions',key,{
    session:makeSession(count),transport:{type:'webrtc',sdp}
  },45000);
  let result;
  try{result=await creatingLivePromise;}
  catch(error){
    // A transport failure can leave the outcome unknown: a remote session
    // might exist even if the response containing its ID never arrived.
    if(error?.name==='TimeoutError'||error?.name==='AbortError'||
       error?.cause?.code==='ECONNRESET'){
      await rememberClosure({state:'unconfirmed',
        reason:'live_creation_response_unknown',at:new Date().toISOString()});
    }
    throw error;
  }
  if(typeof result?.transport?.sdp!=='string'||typeof result?.session?.id!=='string'){
    await rememberClosure({state:'unconfirmed',
      sessionId:typeof result?.session?.id==='string'?result.session.id:null,
      reason:'live_create_response_missing_parameters',at:new Date().toISOString()});
    if(typeof result?.session?.id==='string')
      void hangupRemote(result.session.id,key).catch(()=>{});
    throw new Error('OpenAI не прислал параметры голосового соединения.');
  }
  if(cancelPendingCreate){
    // No WebRTC data channel may exist yet. Keep the ID and report uncertainty
    // rather than claiming that the SIP fallback authoritatively closed it.
    try{liveGuard.activate({id:result.session.id,key,startedAt:requestedAt});
      liveGuard.requestClose('cancelled_startup');}
    catch(error){console.warn('Cancelled startup cleanup:',error.message);}
    throw new Error('Подключение отменено; завершение сессии проверяется.');
  }
  let liveInfo;
  try{
    liveInfo=liveGuard.activate({id:result.session.id,key,startedAt:requestedAt});
  }catch(error){
    await rememberClosure({state:'unconfirmed',sessionId:result.session.id,
      reason:'could_not_register_live_session',at:new Date().toISOString()});
    throw error;
  }
  apiKey=key;
  let archiveWarning=null, archiveId=null;
  try{archiveId=(await archive.start(questionCount(count))).id;}
  catch(err){archiveWarning='Не удалось создать черновик интервью: '+err.message;}
  let saveWarning=null;
  try{
    // If the user cleared the key or changed key retention while connecting,
    // never resurrect their previous key with this late async write.
    await settings.save(keyRetention.payload(savedKeyRevision,{rememberKey,count,key}));
  } catch(err){saveWarning=err.message;}
  return {sdp:result.transport.sdp,saveWarning,archiveWarning,archiveId,...liveInfo};
  }finally{
    creatingLive=false;
    creatingLivePromise=null;
    cancelPendingCreate=false;
  }
});

ipcMain.handle('interview:grade',(event,payload={})=>{
  validateSender(event);
  const requestedArchiveId=payload.archiveId||null;
  if(gradingTask){
    if(requestedArchiveId && gradingArchiveId===requestedArchiveId)
      return gradingTask; // duplicate click: share a single paid request.
    throw new Error('Другая оценка уже выполняется.');
  }
  gradingArchiveId=requestedArchiveId;
  const task=(async()=>{
    closeLiveInBackground('grading');
    // A completed grade is re-used after a PDF failure, crash or duplicate
    // request. Never pay twice for data already saved to the archive.
    let stored=null;
    if(requestedArchiveId){
      try{stored=await archive.getEvaluation(requestedArchiveId);}
      catch(error){console.warn('Could not retrieve stored grade:',error.message);}
    }
    if(!stored && !apiKey)
      throw new Error('Нет активного API-ключа для оценки. Сохрани черновик и начни новую тренировку.');
    const result=stored||parseGrade(await post(
      'https://api.openai.com/v1/responses',apiKey,
      makeGradeRequest(payload.turns,payload.count,payload.observedMainQuestions),90000
    ));
    let archiveResult=null,archiveWarning=null,evaluationSaved=Boolean(stored);
    try{
      if(!requestedArchiveId)throw new Error('Архив интервью недоступен.');
      if(!stored){
        // Save first, then render the PDF. Window closing waits for this work.
        await archive.storeEvaluation(requestedArchiveId,result);
        evaluationSaved=true;
      }
      const prefs=await settings.read();
      archiveResult=await archive.exportReport(
        requestedArchiveId,prefs.reportDirectory,prefs.saveJson
      );
    }catch(error){
      archiveWarning=evaluationSaved
        ? 'Оценка сохранена локально. PDF не создан: '+error.message+
          '. Повтори экспорт без нового запроса к модели.'
        : 'Не удалось сохранить оценку: '+error.message+
          '. Скопируй результат с экрана.';
    }
    apiKey=null;
    return {...result,archive:archiveResult,archiveWarning,evaluationSaved,
      reusedSavedEvaluation:Boolean(stored)};
  })();
  gradingTask=task;
  return task.finally(()=>{
    if(gradingTask===task)gradingTask=null;
    gradingArchiveId=null;
  });
});
ipcMain.handle('interview:draft',async(event,payload={})=>{
  validateSender(event);
  if(!apiKey)throw new Error('Нет активного интервью.');
  return archive.snapshot(payload.archiveId,payload.turns);
});
ipcMain.handle('interview:end',async(event,payload={})=>{
  validateSender(event);
  if(!apiKey)throw new Error('Нет активного интервью.');
  closeLiveInBackground('interview_end');
  return archive.end(payload.archiveId,payload.turns,payload.endedAt);
});
ipcMain.handle('reports:list',async event=>{
  validateSender(event);
  return archive.list();
});
ipcMain.handle('reports:export',async(event,payload={})=>{
  validateSender(event);
  const prefs=await settings.read();
  return archive.exportReport(payload.id,prefs.reportDirectory,prefs.saveJson);
});
ipcMain.handle('live:window-close-ready',event=>{
  validateSender(event);
  if(mainWindow && !mainWindow.isDestroyed())mainWindow.destroy();
  return true;
});
ipcMain.handle('live:request-close',(event,payload={})=>{
  validateSender(event);
  return liveGuard.requestClose(
    ['manual','time_limit','cancelled_startup','startup_error','grading'].includes(payload.reason)
      ? payload.reason : 'manual'
  );
});
ipcMain.handle('live:confirmed-close',async(event,payload={})=>{
  validateSender(event);
  if(typeof payload.sessionId!=='string')return false;
  const confirmed=liveGuard.confirmClosed(payload);
  if(confirmed)await rememberClosure({state:'confirmed',
    sessionId:payload.sessionId,reason:payload.reason||'close_requested',
    usageSeconds:payload.usageSeconds,at:new Date().toISOString()});
  return confirmed;
});
ipcMain.handle('live:transport-lost',(event,payload={})=>{
  validateSender(event);
  return liveGuard.transportLost(payload.sessionId);
});
ipcMain.handle('live:get-status',async event=>{
  validateSender(event);
  await closureLoaded;
  return currentLiveStatus();
});
ipcMain.handle('live:acknowledge-unknown',async event=>{
  validateSender(event);
  const released=liveGuard.acknowledgeUnknown();
  if(storedClosure?.state==='unconfirmed' || released)
    await rememberClosure({state:'unconfirmed_acknowledged',
      reason:'user_accepted_risk',at:new Date().toISOString()});
  return released;
});
ipcMain.handle('live:hangup',(event,payload={})=>{
  validateSender(event);
  if(payload.aborted===true && creatingLive)cancelPendingCreate=true;
  const state=liveGuard.requestClose(payload.aborted===true?'cancelled_startup':'manual');
  if(payload.aborted===true)apiKey=null;
  return state;
});
ipcMain.handle('interview:clear',event=>{
  validateSender(event);
  closeLiveInBackground('manual');
  apiKey=null;
  return true;
});

ipcMain.handle('settings:get',async event=>{
  validateSender(event);
  return settings.read();
});
ipcMain.handle('settings:save',async(event,payload={})=>{
  validateSender(event);
  if(Object.prototype.hasOwnProperty.call(payload,'rememberKey') ||
     Object.prototype.hasOwnProperty.call(payload,'key'))keyRetention.changed();
  return settings.save(payload);
});
ipcMain.handle('reports:choose-folder',async event=>{
  validateSender(event);
  const prefs=await settings.read();
  const result=await dialog.showOpenDialog(mainWindow,{
    title:'Выберите папку для результатов собеседований',
    defaultPath:prefs.reportDirectory,
    properties:['openDirectory','createDirectory']
  });
  if(result.canceled||!result.filePaths.length)return {canceled:true};
  const directory=result.filePaths[0];
  await settings.save({reportDirectory:directory});
  return {canceled:false,directory};
});
ipcMain.handle('reports:open-folder',async event=>{
  validateSender(event);
  const {reportDirectory}=await settings.read();
  await fs.mkdir(reportDirectory,{recursive:true});
  const error=await shell.openPath(reportDirectory);
  if(error)throw new Error(error);
  return true;
});
ipcMain.handle('settings:clear-key',async event=>{
  validateSender(event);
  keyRetention.changed();
  return settings.save({key:''});
});
