'use strict';
const $ = id => document.getElementById(id);
const sound = new Audio();
sound.autoplay = true;
let pc=null, channel=null, microphone=null;
let transcript=[], requested=8;
let transcriptTracker=window.LiveTranscript.createTranscriptTracker();
let questionTracker=window.LiveTranscript.createQuestionTracker(requested);
let limitNoticeSent=false, numberingWarningSent=false, extraQuestionStopped=false;
let started=false, finishing=false, grading=false, muted=false, closeResolve=null;
let greeted=false;
let savedKeyReady=false;
let showTranscript=false, clockInterval=null, callStartedAt=0;
let archiveId=null, lastReportId=null;
let draftDirty=false, draftSaving=false, draftDrain=Promise.resolve();

function refreshClock(){
  if(!callStartedAt)return;
  const seconds=Math.floor((Date.now()-callStartedAt)/1000);
  const mm=String(Math.floor(seconds/60)).padStart(2,'0');
  const ss=String(seconds%60).padStart(2,'0');
  $('timer').textContent=mm+':'+ss;
}
function beginClock(){
  if(clockInterval)clearInterval(clockInterval);
  callStartedAt=Date.now();refreshClock();
  clockInterval=setInterval(refreshClock,1000);
}
function stopClock(){
  if(clockInterval)clearInterval(clockInterval);
  clockInterval=null;callStartedAt=0;
}
function refreshTranscript(){
  const list=$('transcriptList');
  list.replaceChildren();
  for(const turn of transcript.slice(-30)){
    if(!turn.text.trim())continue;
    const item=document.createElement('li');
    const name=document.createElement('b');
    const line=document.createElement('p');
    name.textContent=turn.role==='candidate'?'Ты':'Александр';
    line.textContent=turn.text.trim().slice(0,1500);
    item.append(name,line);
    list.append(item);
  }
  $('transcriptWrap').scrollTop=$('transcriptWrap').scrollHeight;
}
function toggleTranscript(open){
  showTranscript=Boolean(open);
  $('transcriptWrap').hidden=!showTranscript;
  $('toggleTranscript').setAttribute('aria-expanded',String(showTranscript));
  $('toggleTranscript').textContent=showTranscript?'Скрыть расшифровку ↑':'Показать расшифровку ↗';
  if(showTranscript)refreshTranscript();
}


// Persist each changed transcript without a fixed 800ms debounce.
// Concurrent deltas are coalesced while a disk write is in flight.
function persistDraft() {
  if(!archiveId)return Promise.resolve();
  draftDirty=true;
  if(draftSaving)return draftDrain;
  draftSaving=true;
  draftDrain=(async()=>{
    while(draftDirty){
      draftDirty=false;
      const turns=transcript.map(t=>({...t}));
      await window.desktop.saveDraft({archiveId,turns});
    }
  })().catch(error=>{
    $('archiveNotice').textContent='Не удалось сохранить черновик: '+(error.message||String(error));
    $('archiveNotice').hidden=false;
    throw error;
  }).finally(()=>{draftSaving=false;});
  return draftDrain;
}
function scheduleDraft() {void persistDraft().catch(()=>{});}
async function refreshArchiveHistory() {
  const list=$('archiveHistory');
  list.replaceChildren();
  try{
    const entries=await window.desktop.listReports();
    if(!entries.length){
      const li=document.createElement('li');
      li.textContent='Пока нет сохранённых интервью.';
      list.append(li);return;
    }
    for(const entry of entries.slice(0,20)){
      const li=document.createElement('li');
      const title=document.createElement('span');
      const time=new Date(entry.startedAt).toLocaleString('ru-RU');
      const grade=entry.hasEvaluation?' · '+entry.score+'/10':' · без оценки';
      title.textContent=time+grade+' · '+entry.turns+' реплик';
      const button=document.createElement('button');
      button.type='button';button.className='archive-button';
      button.textContent='Сохранить PDF';
      button.addEventListener('click',async()=>{
        button.disabled=true;
        try{
          const saved=await window.desktop.exportReport(entry.id);
          status('Отчёт сохранён: '+saved.pdfFile);
          await refreshArchiveHistory();
        }catch(error){
          status('Не удалось сохранить отчёт: '+error.message,true);
        }finally{button.disabled=false;}
      });
      li.append(title,button);
      list.append(li);
    }
  }catch(error){
    const li=document.createElement('li');
    li.textContent='Не удалось прочитать историю: '+error.message;
    list.append(li);
  }
}
function status(message,error=false) {
  $('status').textContent=message;
  $('error').hidden=!error;
  if(error)$('error').textContent=message;
}
function speech(isSpeaking){$('portrait').classList.toggle('speaking',isSpeaking);$('soundBars').classList.toggle('speaking',isSpeaking);}
function phase(mode) {
  const idle=mode==='idle', active=mode==='active', fault=mode==='fault';
  $('setup').hidden=!idle;
  $('conversation').hidden=!active;
  $('faultInfo').hidden=!fault;
  $('timer').hidden=!active;
  $('topStage').textContent=idle?'Подготовка':active?'Интервью идёт':fault?'Завершение':'Результат';
  $('plannedCount').textContent=questionTracker.confirmed
    ? 'Основных вопросов: '+questionTracker.confirmed+' из '+requested
    : 'План: '+requested+' основных вопросов';
  $('start').hidden=!idle;
  $('mute').hidden=!active;
  $('stop').hidden=!active;
  $('retry').hidden=!fault;
  $('reset').hidden=!(fault);
  $('panel').hidden=mode==='result';
  $('results').hidden=mode!=='result';
  $('dot').classList.toggle('active',active);
}
function cleanup() {
  if(microphone)microphone.getTracks().forEach(t=>t.stop());
  microphone=null;
  try{channel?.close();}catch{}
  channel=null;
  try{pc?.close();}catch{}
  pc=null;
  sound.srcObject=null;
  stopClock();
  // Drafts are already written continuously; a graceful stop awaits the final write.
  started=false;muted=false;greeted=false;
  speech(false);
  $('muteLabel').textContent='Выключить микрофон';
  $('mute').disabled=false;
  $('stop').disabled=false;
  $('start').disabled=false;
}
function send(type,payload={}) {
  if(channel?.readyState!=='open')return false;
  channel.send(JSON.stringify({type,...payload}));
  return true;
}
function appendTranscript(role,evt) {
  if(!transcriptTracker.append(role,evt.delta,evt.start_ms,evt.end_ms,evt.event_id))return;
  // Merge by speaker and timeline, not by whichever speaker delivered the last packet.
  transcript=transcriptTracker.turns();
  const current=transcript.filter(t=>t.role===role).at(-1);
  if(current){
    $('liveSpeaker').textContent=role==='candidate'?'Твой ответ':'Александр спрашивает';
    $('liveText').textContent=current.text.trim()||'Ожидаем следующую реплику…';
  }
  if(role==='interviewer'){
    const before=questionTracker.confirmed;
    const progress=questionTracker.inspect(transcript);
    if(progress.confirmed!==before)
      $('plannedCount').textContent='Основных вопросов: '+progress.confirmed+' из '+requested;
    if(progress.gapDetected&&!numberingWarningSent){
      numberingWarningSent=true;
      send('session.instructions.append',{
        event_id:'question-order-'+Date.now(),delegation_id:null,
        content:'Соблюдай последовательную нумерацию основных вопросов. Следующий номер: '+
          (progress.confirmed+1)+'. Уточнения не нумеруй.'
      });
    }
    if(progress.complete&&!limitNoticeSent){
      limitNoticeSent=true;
      send('session.instructions.append',{
        event_id:'questions-complete-'+Date.now(),delegation_id:null,
        content:'Основных вопросов уже '+requested+' из '+requested+
          '. Дождись ответа на последний, затем заверши интервью. Не задавай новых вопросов.'
      });
    }
    if(progress.overLimit&&!extraQuestionStopped&&!finishing){
      extraQuestionStopped=true;
      status('Лимит основных вопросов достигнут. Завершаю интервью.',true);
      // Buffered output may still play, but we refuse to continue a new question.
      void stop();
    }
  }
  if(showTranscript)refreshTranscript();
  scheduleDraft();
}
function onEvent(evt) {
  switch(evt.type) {
    case 'session.started':
      started=true;
      status('Интервью идёт · слушаю');
      if(!greeted) {
        greeted=true;
        send('session.instructions.append',{
          event_id:'start-'+Date.now(),delegation_id:null,
          content:'Начни: кратко представься, затем скажи «Вопрос 1:» и задай первый основной вопрос Junior Python. Дождись ответа. Каждый новый основной вопрос начинай «Вопрос N:». Уточнения не нумеруй.'
        });
      }
      break;
    case 'session.input_transcript.delta':
      appendTranscript('candidate',evt);
      status('Слушаю твой ответ');speech(false);
      break;
    case 'session.output_transcript.delta':
      appendTranscript('interviewer',evt);
      if(!finishing){status('Александр говорит');speech(true);}
      break;
    case 'session.closed':
      if(closeResolve){closeResolve();closeResolve=null;}
      else if(!finishing){
        cleanup();phase('fault');
        status('Голосовое соединение закрыто. Начни интервью заново.',true);
      }
      break;
    case 'session.error':
    case 'error':
      status(evt.error?.message||evt.message||'Ошибка голосового соединения.',true);
      break;
  }
}
function waitIce(peer) {
  if(peer.iceGatheringState==='complete')return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>{peer.removeEventListener('icegatheringstatechange',check);reject(new Error('Таймаут подключения микрофона.'));},15000);
    function check(){
      if(peer.iceGatheringState!=='complete')return;
      clearTimeout(timeout);peer.removeEventListener('icegatheringstatechange',check);resolve();
    }
    peer.addEventListener('icegatheringstatechange',check);check();
  });
}
async function begin() {
  if(pc||finishing||grading)return;
  if(!window.desktop){status('Запусти программу через установщик Windows.',true);return;}
  const key=$('key').value.trim();
  if(!key.startsWith('sk-')){status('Нужен OpenAI API-ключ, начинающийся с sk-.',true);return;}
  $('start').disabled=true;
  $('error').hidden=true;
  transcript=[];requested=Number($('count').value);
  transcriptTracker=window.LiveTranscript.createTranscriptTracker();
  questionTracker=window.LiveTranscript.createQuestionTracker(requested);
  limitNoticeSent=false;numberingWarningSent=false;extraQuestionStopped=false;
  archiveId=null;lastReportId=null;
  draftDirty=false;draftSaving=false;draftDrain=Promise.resolve();
  $('archiveNotice').hidden=true;
  $('archiveNotice').textContent='';
  toggleTranscript(false);
  $('liveSpeaker').textContent='В ожидании первого вопроса';
  $('liveText').textContent='Сейчас Александр начнёт интервью…';
  started=false;finishing=false;greeted=false;
  status('Подключаюсь к GPT-Live-1…');
  try {
    pc=new RTCPeerConnection();
    pc.addEventListener('track',({track})=>{
      sound.srcObject=new MediaStream([track]);
      sound.play().catch(()=>status('Не удалось воспроизвести голос. Проверь звук Windows.',true));
    });
    pc.addEventListener('connectionstatechange',()=>{
      if(pc&&pc.connectionState==='failed'&&!finishing)
        status('Соединение прервано. Заверши интервью для оценки.',true);
    });
    microphone=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    microphone.getTracks().forEach(track=>pc.addTrack(track,microphone));
    channel=pc.createDataChannel('oai-events');
    channel.addEventListener('message',({data})=>{
      try{onEvent(JSON.parse(data));}catch{status('Получено некорректное событие голосового API.',true);}
    });
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    const answer=await window.desktop.create({key,sdp:pc.localDescription.sdp,count:requested,rememberKey:$('rememberKey').checked});
    archiveId=answer.archiveId||null;
    if(answer.saveWarning) status(answer.saveWarning,true);
    if(answer.archiveWarning){
      $('archiveNotice').textContent=answer.archiveWarning;
      $('archiveNotice').hidden=false;
    }
    $('key').value='';
    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
    phase('active');
    beginClock();
    $('excerpt').textContent='Слушай вопрос и отвечай голосом. Можно попросить повторить.';
    status('Подключено. Начинаем интервью…');
  } catch(error) {
    cleanup();phase('idle');
    status(error instanceof Error?error.message:String(error),true);
  }
}
function disconnectGracefully(){
  return new Promise(resolve=>{
    if(channel?.readyState!=='open'){resolve();return;}
    let done=false;
    const t=setTimeout(()=>{if(!done){done=true;closeResolve=null;resolve();}},3500);
    closeResolve=()=>{if(done)return;done=true;clearTimeout(t);resolve();};
    if(!send('session.close')){clearTimeout(t);closeResolve=null;resolve();}
  });
}
async function stop() {
  if(finishing||grading)return;
  finishing=true;
  $('stop').disabled=true;$('mute').disabled=true;
  status('Завершаю собеседование…');
  const endedAt=new Date().toISOString(); // Before network shutdown and evaluation.
  await disconnectGracefully();
  try{
    await persistDraft();
    if(archiveId)await window.desktop.endInterview({
      archiveId,turns:transcript.map(t=>({...t})),endedAt
    });
  }catch(error){
    $('archiveNotice').textContent='Не удалось сохранить окончание интервью: '+error.message;
    $('archiveNotice').hidden=false;
  }
  cleanup();
  await grade();
}
async function grade() {
  if(grading)return;
  grading=true;
  phase('fault');
  $('retry').hidden=true;
  $('reset').hidden=true;
  status('Оцениваю ответы…');
  try {
    const turns=[...transcript].sort((a,b)=>a.start-b.start);
    const result=await window.desktop.grade({turns,count:requested,archiveId,observedMainQuestions:questionTracker.confirmed});
    $('score').textContent=String(result.score);
    $('verdict').textContent=result.verdict;
    lastReportId=archiveId;
    const saved=Boolean(result.archive?.pdfFile);
    $('archiveStatus').textContent=saved
      ? 'Отчёт автоматически сохранён: '+result.archive.pdfFile+
        (result.archive.jsonFile?' · JSON тоже сохранён':'')
      : result.archiveWarning||'PDF не сохранён. Проверь папку отчётов.';
    $('archiveStatus').classList.toggle('warning',!saved);
    $('openResultFolder').hidden=!saved;
    $('retryReport').hidden=saved||!result.evaluationSaved;
    for(const [element,key] of [['strengths','strengths'],['improve','improve'],['steps','next_steps']]){
      const list=$(element);list.replaceChildren();
      for(const item of result[key]||[]){
        const li=document.createElement('li');li.textContent=String(item);list.append(li);
      }
    }
    $('excerpt').textContent='Интервью завершено. Ниже — оценка твоих ответов.';
    phase('result');status('Результат готов');
    void refreshArchiveHistory();
  } catch(error) {
    phase('fault');
    status(error instanceof Error?error.message:String(error),true);
  } finally{grading=false;finishing=false;}
}
function reset() {
  cleanup();
  void window.desktop?.clear();
  transcript=[];
  transcriptTracker=window.LiveTranscript.createTranscriptTracker();
  questionTracker=window.LiveTranscript.createQuestionTracker(Number($('count').value));
  limitNoticeSent=false;numberingWarningSent=false;extraQuestionStopped=false;
  archiveId=null;lastReportId=null;
  finishing=false;grading=false;closeResolve=null;
  if(savedKeyReady && $('rememberKey').checked)void window.desktop.getPrefs().then(p=>{$('key').value=p.key||'';}).catch(()=>{});
  toggleTranscript(false);
  $('archiveNotice').hidden=true;
  $('results').hidden=true;
  $('key').type='password';
  $('showKey').textContent='Показать';
  $('showKey').setAttribute('aria-label','Показать ключ');
  $('showKey').setAttribute('aria-pressed','false');
  $('excerpt').textContent='Новая попытка: поговори с интервьюером голосом.';
  phase('idle');status('Готов к собеседованию');
  void refreshArchiveHistory();
}
$('showKey').addEventListener('click',()=>{
  const input=$('key');
  const shown=input.type==='password';
  input.type=shown?'text':'password';
  $('showKey').textContent=shown?'Скрыть':'Показать';
  $('showKey').setAttribute('aria-label',shown?'Скрыть ключ':'Показать ключ');
  $('showKey').setAttribute('aria-pressed',String(shown));
});
$('toggleTranscript').addEventListener('click',()=>toggleTranscript(!showTranscript));
async function initSettings(){
  if(!window.desktop?.getPrefs)return;
  try {
    const prefs=await window.desktop.getPrefs();
    $('rememberKey').checked=prefs.rememberKey!==false;
    $('count').value=String([5,8,10].includes(Number(prefs.count))?prefs.count:8);
    $('key').value=prefs.key||'';
    $('reportFolder').textContent=prefs.reportDirectory||'Папка не выбрана';
    $('saveJson').checked=prefs.saveJson!==false;
    savedKeyReady=true;
    void refreshArchiveHistory();
  } catch {savedKeyReady=false;}
}
$('clearKey').addEventListener('click',async()=>{
  $('key').value='';
  try{await window.desktop.clearSavedKey();status('Сохранённый ключ очищен');}
  catch(e){status(e.message||'Не удалось очистить ключ',true);}
});
$('rememberKey').addEventListener('change',async()=>{
  try {
    if(!$('rememberKey').checked) await window.desktop.clearSavedKey();
    await window.desktop.savePrefs({rememberKey:$('rememberKey').checked,count:Number($('count').value)});
  } catch(e){status(e.message||'Не удалось сохранить настройки',true);}
});
$('chooseReportsFolder').addEventListener('click',async()=>{
  try{
    const response=await window.desktop.chooseReportsFolder();
    if(!response.canceled)$('reportFolder').textContent=response.directory;
  }catch(error){status('Не удалось выбрать папку: '+error.message,true);}
});
async function openReportsFolder() {
  try{await window.desktop.openReportsFolder();}
  catch(error){status('Не удалось открыть папку: '+error.message,true);}
}
$('openReportsFolder').addEventListener('click',()=>{void openReportsFolder();});
$('openResultFolder').addEventListener('click',()=>{void openReportsFolder();});
$('refreshArchiveHistory').addEventListener('click',()=>{void refreshArchiveHistory();});
$('retryReport').addEventListener('click',async()=>{
  if(!lastReportId)return;
  $('retryReport').disabled=true;
  try{
    const saved=await window.desktop.exportReport(lastReportId);
    $('archiveStatus').textContent='Отчёт сохранён: '+saved.pdfFile;
    $('archiveStatus').classList.remove('warning');
    $('openResultFolder').hidden=false;
    $('retryReport').hidden=true;
  }catch(error){
    $('archiveStatus').textContent='Не удалось сохранить PDF: '+error.message;
    $('archiveStatus').classList.add('warning');
  }finally{$('retryReport').disabled=false;}
});
$('saveJson').addEventListener('change',()=>{
  void window.desktop.savePrefs({saveJson:$('saveJson').checked}).catch(error=>status(error.message,true));
});
$('count').addEventListener('change',()=>{
  void window.desktop?.savePrefs({count:Number($('count').value)}).catch(()=>{});
});
$('start').addEventListener('click',begin);
$('stop').addEventListener('click',()=>{void stop();});
$('mute').addEventListener('click',()=>{
  if(!microphone)return;
  muted=!muted;
  microphone.getAudioTracks().forEach(track=>track.enabled=!muted);
  send(muted?'session.input_audio.mute':'session.input_audio.unmute',{event_id:'mute-'+Date.now()});
  $('muteLabel').textContent=muted?'Включить микрофон':'Выключить микрофон';
  status(muted?'Микрофон выключен':'Слушаю');
});
$('retry').addEventListener('click',()=>{void grade();});
$('reset').addEventListener('click',reset);
$('again').addEventListener('click',reset);
window.addEventListener('beforeunload',()=>{
  if(channel?.readyState==='open')send('session.close');
  cleanup();
});
phase('idle');
void initSettings();
if(window.desktop?.listReports)void refreshArchiveHistory();
