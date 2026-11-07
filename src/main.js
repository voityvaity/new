'use strict';
const {app,BrowserWindow,ipcMain,session,safeStorage,dialog,shell,clipboard} = require('electron');
const fs = require('node:fs/promises');
const {createSettingsStore} = require('./secure-settings');
const path = require('node:path');
const {makeSession,makeGradeRequest,parseGrade,questionCount} = require('./logic');
const {createInterviewArchive,atomicWrite} = require('./interview-archive');
const {printReport} = require('./pdf-printer');
const {createLiveGuard} = require('./live-lifecycle');
const {createKeyRetentionPolicy} = require('./key-retention');
const {recoverLiveJournal,canStartLive} = require('./live-journal');
const {createGradeRecoveryStore} = require('./grade-recovery');
let mainWindow=null;
let apiKey=null;
let settings=null;
let archive=null;
let liveGuard=null;
let quitHangupStarted=false;
let creatingLive=false, cancelPendingCreate=false, creatingLivePromise=null;
let creatingLiveDone=null,resolveCreatingLiveDone=null;
const keyRetention=createKeyRetentionPolicy();
let gradingTask=null, gradingArchiveId=null;
let gradeRecovery=null;
const unsavedGradeMemory=new Map();
const durableGradeBackups=new Set();
function gradeCouldBeLostOnExit(){
  return [...unsavedGradeMemory.keys()].some(id=>!durableGradeBackups.has(id));
}
async function confirmGradeLoss(windowToClose){
  if(!gradeCouldBeLostOnExit())return true;
  const choice=await dialog.showMessageBox(windowToClose,{
    type:'warning',buttons:['Остаться','Закрыть без сохранения'],
    defaultId:0,cancelId:0,noLink:true,
    title:'Результат ещё не сохранён',
    message:'Оценка получена, но сохранить её на диск не удалось.',
    detail:'Вернись в приложение, скопируй результат или освободи место на диске.'
  });
  return choice.response===1;
}
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
    const error=new Error('Ошибка OpenAI API: '+reason);
    if(url.endsWith('/live/sessions'))error.liveCreationRejected=true;
    throw error;
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
      void Promise.race([gradingTask.catch(()=>{}),limit]).then(async()=>{
        clearTimeout(timer);
        if(await confirmGradeLoss(windowToClose)){
          if(!windowToClose.isDestroyed())windowToClose.destroy();
        }else windowCloseRequested=false;
      }).catch(error=>{
        console.warn('Could not confirm pending grade closure:',error.message);
        windowCloseRequested=false;
      });
      return;
    }
    if(!creatingLive && !liveGuard?.hasActive()){
      if(!gradeCouldBeLostOnExit())return;
      event.preventDefault();
      windowCloseRequested=true;
      const windowToClose=mainWindow;
      void confirmGradeLoss(windowToClose).then(allowed=>{
        if(allowed && !windowToClose.isDestroyed())windowToClose.destroy();
        else windowCloseRequested=false;
      }).catch(()=>{windowCloseRequested=false;});
      return;
    }
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
  closureLoaded=fs.readFile(closureStatusFile,'utf8').then(async raw=>{
    let value;
    try{value=JSON.parse(raw);}
    catch{
      // Corrupt state cannot establish that the last paid call ended safely.
      value={state:'unconfirmed',reason:'corrupt_local_live_journal',
        at:new Date().toISOString()};
    }
    const recovered=recoverLiveJournal(value);
    storedClosure=recovered || value;
    if(recovered && value.state!=='unconfirmed')
      await rememberClosure(recovered);
  }).catch(error=>{
    if(error.code==='ENOENT'){storedClosure=null;return;}
    // Fail closed on permissions or disk errors instead of silently starting
    // a possibly second paid Live session.
    storedClosure={state:'unconfirmed',
      reason:'unreadable_local_live_journal',at:new Date().toISOString()};
    console.warn('Live journal unreadable:',error.message);
  });
  settings=createSettingsStore({
    userData, secureStorage:safeStorage,
    defaultReportDirectory:path.join(app.getPath('documents'),'Python Junior Mock','Интервью')
  });
  archive=createInterviewArchive({
    draftDirectory:path.join(userData,'interview-drafts'),
    generatePdf:printReport
  });
  gradeRecovery=createGradeRecoveryStore({directory:path.join(userData,'grade-recovery')});
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
    // Wait for the ENTIRE setup task, not just fetch(). The task may still
    // be creating a draft or writing its preflight journal when Quit occurs.
    if(creatingLiveDone){
      let timeoutId;
      const timeout=new Promise(resolve=>{timeoutId=setTimeout(resolve,54000);});
      await Promise.race([creatingLiveDone,timeout]);
      clearTimeout(timeoutId);
      if(creatingLive) {
        try {
          await rememberClosure({state:'unconfirmed',
            reason:'app_quit_while_live_create_unresolved',
            at:new Date().toISOString()});
        } catch(error) {
          console.warn('Could not persist interrupted Live setup:',error.message);
        }
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
  if(typeof key!=='string'||!key.startsWith('sk-')||key.length>512)
    throw new Error('Нужен ключ OpenAI API (sk-...).');
  if(typeof sdp!=='string'||!sdp.startsWith('v=0')||sdp.length>65536)
    throw new Error('Некорректный SDP микрофона.');
  await closureLoaded;
  if(!canStartLive(storedClosure))
    throw new Error('Предыдущее платное подключение не подтверждено завершённым. Проверь состояние перед новой попыткой.');
  if(creatingLive || liveGuard.hasActive())
    throw new Error('Предыдущая платная сессия ещё не подтверждена закрытой.');
  creatingLive=true;
  cancelPendingCreate=false;
  creatingLiveDone=new Promise(resolve=>{resolveCreatingLiveDone=resolve;});
  const savedKeyRevision=keyRetention.snapshot();
  let archiveId=null,requestSent=false,sessionId=null,requestedAt=null;
  try{
    // A disk failure must not leave the user paying for a call with no draft.
    archiveId=(await archive.start(questionCount(count))).id;
    // Cancellation during disk I/O must prevent the paid HTTP request.
    if(cancelPendingCreate)throw new Error('Подключение отменено до запроса OpenAI.');
    requestedAt=Date.now();
    await rememberClosure({state:'creating',archiveId,startedAt:requestedAt,
      at:new Date().toISOString()});
    if(cancelPendingCreate)throw new Error('Подключение отменено до запроса OpenAI.');
    requestSent=true;
    creatingLivePromise=post('https://api.openai.com/v1/live/sessions',key,{
      session:makeSession(count),transport:{type:'webrtc',sdp}
    },45000);
    let result;
    try{result=await creatingLivePromise;}
    catch(error){
      // A rejected HTTP request is not a started Live session; a transport
      // failure or timeout has an unknown outcome and must remain journaled.
      if(error?.liveCreationRejected){
        await rememberClosure({state:'creation_rejected',archiveId,
          reason:'http_rejected',at:new Date().toISOString()});
        await archive.discardEmpty(archiveId).catch(()=>{});
      }else{
        await rememberClosure({state:'unconfirmed',archiveId,
          reason:'live_creation_response_unknown',at:new Date().toISOString()});
      }
      throw error;
    }
    sessionId=typeof result?.session?.id==='string'?result.session.id:null;
    if(!sessionId || typeof result?.transport?.sdp!=='string'){
      await rememberClosure({state:'unconfirmed',sessionId,archiveId,
        reason:'live_create_response_missing_parameters',at:new Date().toISOString()});
      if(sessionId)void hangupRemote(sessionId,key).catch(()=>{});
      throw new Error('OpenAI не прислал параметры голосового соединения.');
    }
    // Must be durable before the UI sees the answer or a new session can start.
    await rememberClosure({state:'active',sessionId,archiveId,
      startedAt:requestedAt,at:new Date().toISOString()});
    const liveInfo=liveGuard.activate({id:sessionId,key,startedAt:requestedAt});
    if(cancelPendingCreate){
      liveGuard.requestClose('cancelled_startup');
      throw new Error('Подключение отменено; завершение платной сессии не подтверждено.');
    }
    apiKey=key;
    let saveWarning=null;
    try{
      await settings.save(keyRetention.payload(savedKeyRevision,{rememberKey,count,key}));
    }catch(error){saveWarning=error.message;}
    return {sdp:result.transport.sdp,saveWarning,archiveId,...liveInfo};
  }catch(error){
    if(!requestSent && archiveId){
      // No remote request was sent: record a terminal local outcome so the
      // user is not trapped behind a "creating" warning after a disk error.
      try {
        await rememberClosure({state:cancelPendingCreate?'creation_cancelled':'preflight_failed',
          archiveId,reason:cancelPendingCreate?'user_cancelled':'local_io_failure',
          at:new Date().toISOString()});
      }catch(writeError){
        // Fail closed if even the recovery marker cannot be persisted.
        storedClosure={state:'unconfirmed',archiveId,
          reason:'local_journal_unwritable',at:new Date().toISOString()};
        console.warn('Cannot persist safe preflight outcome:',writeError.message);
      }
      await archive.discardEmpty(archiveId).catch(error=>
        console.warn('Cannot clean up empty draft:',error.message));
    }
    // The "active" journal and in-memory guard stay intact after errors
    // that occur once a remote session may exist.
    if(sessionId && !liveGuard.hasActive()){
      // The server may already be billing us: keep the warning even if
      // registering the guard or persisting the active marker failed.
      try{
        await rememberClosure({state:'unconfirmed',sessionId,archiveId,
          reason:'remote_session_not_registered',at:new Date().toISOString()});
      }catch(writeError){
        console.warn('Failed to persist uncertain paid session:',writeError.message);
      }
      void hangupRemote(sessionId,key).catch(()=>{});
    }
    throw error;
  }finally{
    creatingLive=false;
    creatingLivePromise=null;
    cancelPendingCreate=false;
    resolveCreatingLiveDone?.();
    creatingLiveDone=null;
    resolveCreatingLiveDone=null;
  }
});

ipcMain.handle('interview:grade',(event,payload={})=>{
  validateSender(event);
  const id=payload.archiveId||null;
  if(gradingTask){
    if(id && gradingArchiveId===id)return gradingTask;
    throw new Error('Другая оценка уже выполняется.');
  }
  gradingArchiveId=id;
  const task=(async()=>{
    closeLiveInBackground('grading');
    let stored=null,archiveReadError=null;
    if(id){
      try{stored=await archive.getEvaluation(id);}
      catch(error){archiveReadError=error;}
    }
    let backup=null;
    if(id && !stored){
      backup=unsavedGradeMemory.get(id)||null;
      if(!backup) {
        try{
          backup=await gradeRecovery.get(id);
          if(backup)durableGradeBackups.add(id);
        }catch(error){console.warn('Cannot read grade recovery:',error.message);}
      }
    }
    // A damaged/missing archive is not a reason to pay for grading again.
    // If a rescue grade exists, show it; otherwise fail without an API call.
    if(archiveReadError && !backup)
      throw new Error('Архив интервью недоступен: '+archiveReadError.message+
        '. Новый платный запрос не выполнялся.');
    if(!stored && !backup && !apiKey)
      throw new Error('Нет API-ключа для оценки. Черновик остаётся в истории.');
    const fresh=!stored&&!backup;
    const result=stored||backup||parseGrade(await post(
      'https://api.openai.com/v1/responses',apiKey,
      makeGradeRequest(payload.turns,payload.count,payload.observedMainQuestions),90000
    ));
    let recoveryStored=Boolean(stored||(id&&durableGradeBackups.has(id))),evaluationSaved=Boolean(stored);
    if(fresh && id){
      // Persist a small rescue copy before editing the main archive. A disk
      // failure still leaves an in-memory copy for explicit user export.
      unsavedGradeMemory.set(id,result);
      try{
        await gradeRecovery.save(id,result);
        recoveryStored=true;
        durableGradeBackups.add(id);
      }catch(error){console.warn('Cannot save grade rescue copy:',error.message);}
    }
    let archiveResult=null,archiveWarning=null;
    try{
      if(!id)throw new Error('Архив интервью недоступен.');
      if(!stored){
        await archive.storeEvaluation(id,result);
        evaluationSaved=true;
        unsavedGradeMemory.delete(id);
        durableGradeBackups.delete(id);
        try{await gradeRecovery.remove(id);}
        catch(error){console.warn('Cannot remove grade rescue file:',error.message);}
      }
      const prefs=await settings.read();
      archiveResult=await archive.exportReport(id,prefs.reportDirectory,prefs.saveJson);
    }catch(error){
      archiveWarning=evaluationSaved
        ? 'Оценка сохранена. PDF пока не создан: '+error.message
        : 'Оценка получена, но не сохранена: '+error.message;
    }
    apiKey=null;
    return {...result,archive:archiveResult,archiveWarning,
      evaluationSaved,recoveryStored:recoveryStored||evaluationSaved,
      reusedSavedEvaluation:!fresh};
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
  const id=payload.id;
  const stored=await archive.getEvaluation(id);
  if(!stored){
    let backup=unsavedGradeMemory.get(id)||null;
    if(!backup)backup=await gradeRecovery.get(id);
    if(backup){
      await archive.storeEvaluation(id,backup);
      unsavedGradeMemory.delete(id);
      durableGradeBackups.delete(id);
      await gradeRecovery.remove(id).catch(()=>{});
    }
  }
  const prefs=await settings.read();
  return archive.exportReport(id,prefs.reportDirectory,prefs.saveJson);
});
ipcMain.handle('ui:copy-text',(event,payload={})=>{
  validateSender(event);
  if(typeof payload.text!=='string'||payload.text.length>10000)
    throw new Error('Некорректный текст для копирования.');
  clipboard.writeText(payload.text);
  return true;
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
