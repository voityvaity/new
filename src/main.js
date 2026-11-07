'use strict';
const {app,BrowserWindow,ipcMain,session,safeStorage,dialog,shell} = require('electron');
const fs = require('node:fs/promises');
const {createSettingsStore} = require('./secure-settings');
const path = require('node:path');
const {makeSession,makeGradeRequest,parseGrade,questionCount} = require('./logic');
const {createInterviewArchive} = require('./interview-archive');
const {printReport} = require('./pdf-printer');
let mainWindow=null;
let apiKey=null;
let settings=null;
let archive=null;

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
    icon:path.join(__dirname,'../assets/quickcue-app-icon.png'),
    webPreferences:{preload:path.join(__dirname,'preload.js'),contextIsolation:true,nodeIntegration:false,sandbox:true}
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname,'index.html'));
  mainWindow.webContents.setWindowOpenHandler(()=>({action:'deny'}));
  mainWindow.webContents.on('will-navigate',e=>e.preventDefault());
}

app.whenReady().then(()=>{
  const userData=app.getPath('userData');
  settings=createSettingsStore({
    userData, secureStorage:safeStorage,
    defaultReportDirectory:path.join(app.getPath('documents'),'Python Junior Mock','Интервью')
  });
  archive=createInterviewArchive({
    draftDirectory:path.join(userData,'interview-drafts'),
    generatePdf:printReport
  });
  session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>{
    callback(Boolean(mainWindow&&contents.id===mainWindow.webContents.id&&permission==='media'&&contents.getURL().startsWith('file://')));
  });
  createWindow();
  app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
});
app.on('window-all-closed',()=>{apiKey=null;if(process.platform!=='darwin')app.quit();});

ipcMain.handle('live:create',async(event,payload={})=>{
  validateSender(event);
  const {key,sdp,count,rememberKey}=payload||{};
  if(typeof key!=='string'||!key.startsWith('sk-')||key.length>512)throw new Error('Нужен ключ OpenAI API (sk-...).');
  if(typeof sdp!=='string'||!sdp.startsWith('v=0')||sdp.length>65536)throw new Error('Некорректный SDP микрофона.');
  const result=await post('https://api.openai.com/v1/live/sessions',key,{
    session:makeSession(count),transport:{type:'webrtc',sdp}
  },45000);
  if(typeof result?.transport?.sdp!=='string'||typeof result?.session?.id!=='string')
    throw new Error('OpenAI не прислал параметры голосового соединения.');
  apiKey=key;
  let archiveWarning=null, archiveId=null;
  try{archiveId=(await archive.start(questionCount(count))).id;}
  catch(err){archiveWarning='Не удалось создать черновик интервью: '+err.message;}
  let saveWarning=null;
  try{
    await settings.save({rememberKey,count,key});
  } catch(err){saveWarning=err.message;}
  return {sdp:result.transport.sdp,saveWarning,archiveWarning,archiveId};
});

ipcMain.handle('interview:grade',async(event,payload={})=>{
  validateSender(event);
  if(!apiKey)throw new Error('Сессия не активна. Начни интервью заново.');
  const request=makeGradeRequest(payload.turns,payload.count,payload.observedMainQuestions);
  const result=parseGrade(await post('https://api.openai.com/v1/responses',apiKey,request,90000));
  let archiveResult=null, archiveWarning=null, evaluationSaved=false;
  try{
    if(!payload.archiveId)throw new Error('Архив интервью недоступен.');
    // Save the already-paid-for evaluation locally BEFORE attempting PDF creation.
    await archive.storeEvaluation(payload.archiveId,result);
    evaluationSaved=true;
    const prefs=await settings.read();
    archiveResult=await archive.exportReport(
      payload.archiveId,prefs.reportDirectory,prefs.saveJson
    );
  }catch(err){
    archiveWarning=evaluationSaved
      ? 'Оценка сохранена локально. PDF не создан: '+err.message+
        '. Повтори экспорт без нового запроса к модели.'
      : 'Не удалось надёжно сохранить оценку: '+err.message+
        '. Скопируй результат с экрана.';
  }
  apiKey=null;
  return {...result,archive:archiveResult,archiveWarning,evaluationSaved};
});
ipcMain.handle('interview:draft',async(event,payload={})=>{
  validateSender(event);
  if(!apiKey)throw new Error('Нет активного интервью.');
  return archive.snapshot(payload.archiveId,payload.turns);
});
ipcMain.handle('interview:end',async(event,payload={})=>{
  validateSender(event);
  if(!apiKey)throw new Error('Нет активного интервью.');
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
ipcMain.handle('interview:clear',event=>{validateSender(event);apiKey=null;return true;});

ipcMain.handle('settings:get',async event=>{
  validateSender(event);
  return settings.read();
});
ipcMain.handle('settings:save',async(event,payload)=>{
  validateSender(event);
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
  return settings.save({key:''});
});
