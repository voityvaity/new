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
let draftWriteTimer=null;
let readyGate=null, liveActive=false, liveSessionId=null, liveDeadlineAt=0;
let firstOutputSeen=false, greetingAttempts=0, greetingEventId=null, openingTimer=null;
let audioPlaybackStarted=false, audioPlaybackError=false, lastSessionClose=null;
let usageSeconds=0, fiveMinuteWarningShown=false, connectionAttempt=0;
const OPENING_INSTRUCTION=window.LivePrompts.OPENING_PROMPT;

function refreshClock(){
  if(!callStartedAt)return;
  const seconds=Math.floor((Date.now()-callStartedAt)/1000);
  $('timer').textContent=window.LiveLifecycle.formatClock(seconds*1000);
  if(liveDeadlineAt){
    const remaining=Math.max(0,liveDeadlineAt-Date.now());
    $('remainingTime').textContent='Осталось '+window.LiveLifecycle.formatClock(remaining);
    $('remainingTime').title='По данным GPT-Live использовано '+Math.floor(usageSeconds)+
      ' сек. Расходы делегированной модели учитываются отдельно.';
    if(remaining<=window.LiveLifecycle.WARNING_REMAINING_MS && !fiveMinuteWarningShown && !finishing){
      fiveMinuteWarningShown=true;
      status('До автоматического завершения интервью осталось 5 минут.');
    }
  }
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
function clearOpeningTimer(){
  if(openingTimer)clearTimeout(openingTimer);
  openingTimer=null;
}
function requestOpening(){
  if(!liveActive || finishing || firstOutputSeen || greetingAttempts>=2)return false;
  greetingAttempts++;
  greetingEventId='opening-'+Date.now()+'-'+greetingAttempts;
  const sent=send('session.commentary.append',{
    event_id:greetingEventId,delegation_id:null,content:OPENING_INSTRUCTION
  });
  if(!sent){
    greetingAttempts--;
    $('repeatFirstQuestion').hidden=false;
    status('Не удалось запросить первый вопрос. Проверь соединение.',true);
    return false;
  }
  greeted=true;
  $('repeatFirstQuestion').hidden=true;
  clearOpeningTimer();
  if(greetingAttempts<2)openingTimer=setTimeout(()=>{
    if(!firstOutputSeen&&liveActive&&!finishing){
      $('repeatFirstQuestion').textContent='Повторить первый вопрос';
      $('repeatFirstQuestion').hidden=false;
      status('Первый вопрос не появился. Можно запросить его повторно.');
    }
  },window.LiveLifecycle.FIRST_QUESTION_RETRY_MS);
  return true;
}
function activateLive(){
  if(liveActive || finishing || grading)return;
  liveActive=true;
  phase('active');
  beginClock();
  $('key').value='';
  $('excerpt').textContent='Слушай вопрос и отвечай голосом. Можно попросить повторить.';
  status(firstOutputSeen?'Интервью идёт · слушаю'
    :'Соединение готово · ожидаю первый вопрос');
  if(!firstOutputSeen)requestOpening();
}
async function abortStartup(message){
  if(liveActive || finishing || grading)return;
  connectionAttempt++;
  readyGate?.dispose();readyGate=null;
  cleanup();
  phase('idle');
  status(message,true);
  try{await window.desktop?.hangupLive({aborted:true});}
  catch{status(message+' Не удалось подтвердить завершение сессии.',true);}
  void refreshLiveStatus();
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
    line.textContent=turn.text.trim();
    item.append(name,line);
    list.append(item);
  }
  $('transcriptWrap').scrollTop=$('transcriptWrap').scrollHeight;
}
function toggleTranscript(open){
  showTranscript=Boolean(open);
  $('transcriptWrap').hidden=!showTranscript;
  $('toggleTranscript').setAttribute('aria-expanded',String(showTranscript));
  $('toggleTranscript').textContent=showTranscript?'Скрыть последние реплики ↑':'Показать последние 30 реплик ↗';
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
  }).finally(()=>{
    draftSaving=false;
    // A new delta may have arrived between the last loop check and finally.
    if(draftDirty)queueMicrotask(()=>{void persistDraft().catch(()=>{});});
  });
  return draftDrain;
}
// Coalesce high-frequency word deltas to avoid rewriting an ever-growing
// JSON transcript for every word. Finalization always forces a synchronous
// flush through the IPC queue before ending the interview.
function scheduleDraft() {
  if(draftWriteTimer)return;
  draftWriteTimer=setTimeout(()=>{
    draftWriteTimer=null;
    void persistDraft().catch(()=>{});
  },200);
}
async function flushDraft(){
  if(draftWriteTimer){clearTimeout(draftWriteTimer);draftWriteTimer=null;}
  await persistDraft();
}
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
async function refreshLiveStatus() {
  if(!window.desktop?.getLiveStatus)return;
  try {
    const state=await window.desktop.getLiveStatus();
    const uncertain=state.state==='unconfirmed'||state.history?.state==='unconfirmed';
    const closing=state.state==='closing';
    $('liveClosureNotice').hidden=!(uncertain||closing);
    $('acknowledgeLive').hidden=!uncertain;
    if(uncertain){
      $('liveClosureText').textContent='OpenAI не подтвердил завершение предыдущей платной голосовой сессии. Перед продолжением проверь расходы в OpenAI Platform. Новое интервью можно начать только после явного подтверждения риска.';
    }else if(closing){
      $('liveClosureText').textContent='Ожидаю подтверждения завершения предыдущей голосовой сессии…';
    }
  }catch(error){
    status('Не удалось проверить состояние голосовой сессии: '+error.message,true);
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
  const connecting=mode==='connecting';
  $('setup').hidden=!(idle||connecting);
  $('conversation').hidden=!active;
  $('faultInfo').hidden=!fault;
  $('timer').hidden=!active;
  $('topStage').textContent=idle?'Подготовка':connecting?'Подключение':active?'Интервью идёт':fault?'Завершение':'Результат';
  $('plannedCount').textContent=questionTracker.confirmed
    ? 'Основных вопросов: '+questionTracker.confirmed+' из '+requested
    : 'План: '+requested+' основных вопросов';
  $('start').hidden=!idle;
  $('cancelConnecting').hidden=!connecting;
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
  if(draftWriteTimer){clearTimeout(draftWriteTimer);draftWriteTimer=null;}
  readyGate?.dispose();readyGate=null;
  clearOpeningTimer();
  liveActive=false;liveSessionId=null;liveDeadlineAt=0;
  audioPlaybackStarted=false;audioPlaybackError=false;
  $('repeatFirstQuestion').hidden=true;
  // Drafts are written continuously; a graceful stop awaits the final write.
  started=false;muted=false;greeted=false;
  speech(false);
  $('muteLabel').textContent='Выключить микрофон';
  $('mute').disabled=false;
  $('stop').disabled=false;
  $('stop').textContent='Завершить и оценить';
  $('start').disabled=false;
}
function send(type,payload={}) {
  if(channel?.readyState!=='open')return false;
  try{channel.send(JSON.stringify({type,...payload}));return true;}
  catch{return false;}
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
      $('stop').textContent='Завершить после ответа';
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
      readyGate?.markStarted();
      break;
    case 'session.usage.updated':
      usageSeconds=window.LiveLifecycle.cumulativeUsage(usageSeconds,evt);
      if(liveActive)refreshClock();
      break;
    case 'session.commentary.appended':
      // Acknowledgment is not evidence of audible playback.
      break;
    case 'session.input_transcript.delta':
      appendTranscript('candidate',evt);
      if(liveActive)status('Слушаю твой ответ');
      speech(false);
      break;
    case 'session.output_transcript.delta':
      if(typeof evt.delta==='string' && evt.delta.length && !firstOutputSeen){
        firstOutputSeen=true;
        clearOpeningTimer();
        // A transcript delta is not proof that audio reached the speakers.
        if(!audioPlaybackStarted){
          $('repeatFirstQuestion').textContent='Включить воспроизведение звука';
          $('repeatFirstQuestion').hidden=false;
        }else $('repeatFirstQuestion').hidden=true;
      }
      appendTranscript('interviewer',evt);
      if(!finishing){if(liveActive)status('Александр говорит');speech(true);}
      break;
    case 'session.closed': {
      usageSeconds=window.LiveLifecycle.cumulativeUsage(usageSeconds,evt);
      const idFromEvent=evt.session?.id;
      if(idFromEvent && liveSessionId && idFromEvent!==liveSessionId){
        status('Получено завершение другой сессии. Текущая сессия не подтверждена.',true);
        break;
      }
      const final={
        sessionId:idFromEvent||liveSessionId,
        reason:evt.reason||'close_requested',usageSeconds
      };
      // A terminal event is authoritative only for the matching session.
      void (async()=>{
        let accepted=false;
        try{
          if(final.sessionId)accepted=Boolean(await window.desktop.confirmLiveClosed(final));
          if(accepted)lastSessionClose=final;
          else status('Не удалось подтвердить завершение текущей сессии. Проверь статус перед новой тренировкой.',true);
        }catch(error){
          status('Не удалось сохранить подтверждение закрытия: '+error.message,true);
        }finally{
          if(closeResolve){closeResolve({confirmed:accepted});closeResolve=null;}
          else if(!finishing){
            if(liveActive)void stop('remote_closed');
            else void abortStartup('Голосовая сессия закрылась до начала интервью.');
          }
        }
      })();
      break;
    }
    case 'session.error':
    case 'error': {
      const message=evt.error?.message||evt.message||'Ошибка голосового соединения.';
      const clientId=evt.error?.client_event_id||evt.client_event_id;
      if(clientId && clientId===greetingEventId && !firstOutputSeen && greetingAttempts<2){
        clearOpeningTimer();
        $('repeatFirstQuestion').hidden=false;
      }
      if(!liveActive)void abortStartup(message);
      else status(message,true);
      break;
    }
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
  const attempt=++connectionAttempt;
  $('start').disabled=true;
  $('error').hidden=true;
  transcript=[];requested=Number($('count').value);
  transcriptTracker=window.LiveTranscript.createTranscriptTracker();
  questionTracker=window.LiveTranscript.createQuestionTracker(requested);
  limitNoticeSent=false;numberingWarningSent=false;extraQuestionStopped=false;
  archiveId=null;lastReportId=null;
  draftDirty=false;draftSaving=false;draftDrain=Promise.resolve();
  if(draftWriteTimer){clearTimeout(draftWriteTimer);draftWriteTimer=null;}
  firstOutputSeen=false;greetingAttempts=0;greetingEventId=null;
  audioPlaybackStarted=false;audioPlaybackError=false;lastSessionClose=null;
  usageSeconds=0;fiveMinuteWarningShown=false;liveSessionId=null;liveDeadlineAt=0;
  $('archiveNotice').hidden=true;
  $('archiveNotice').textContent='';
  $('repeatFirstQuestion').hidden=true;
  $('remainingTime').textContent='Лимит 30 минут';
  toggleTranscript(false);
  $('liveSpeaker').textContent='В ожидании первого вопроса';
  $('liveText').textContent='Сейчас Александр начнёт интервью…';
  started=false;finishing=false;greeted=false;liveActive=false;
  phase('connecting');
  status('Подключаюсь к GPT-Live-1…');
  readyGate=window.LiveLifecycle.createReadyGate({
    onReady:()=>{if(attempt===connectionAttempt)activateLive();},
    onTimeout:()=>{if(attempt===connectionAttempt)void abortStartup('GPT-Live не подтвердил готовность соединения за 20 секунд.');}
  });
  try {
    const peer=new RTCPeerConnection();
    pc=peer;
    pc.addEventListener('track',({track})=>{
      if(attempt!==connectionAttempt)return;
      sound.srcObject=new MediaStream([track]);
      sound.play().then(()=>{
        audioPlaybackStarted=true;
        audioPlaybackError=false;
        if(firstOutputSeen)$('repeatFirstQuestion').hidden=true;
      }).catch(()=>{
        audioPlaybackError=true;
        $('repeatFirstQuestion').textContent='Включить воспроизведение звука';
        $('repeatFirstQuestion').hidden=false;
        status('Звук не воспроизводится. Нажми «Включить воспроизведение звука» и проверь звук Windows.',true);
      });
    });
    pc.addEventListener('connectionstatechange',()=>{
      if(attempt!==connectionAttempt||!pc||pc!==peer||finishing)return;
      if(pc.connectionState==='failed'){
        if(!liveActive)void abortStartup('Не удалось установить голосовое соединение.');
        else{
          if(liveSessionId)void window.desktop.markLiveTransportLost(liveSessionId).catch(()=>{});
          void stop('connection_lost');
        }
      }
    });
    const stream=await navigator.mediaDevices.getUserMedia({
      audio:{echoCancellation:true,noiseSuppression:true,autoGainControl:true}
    });
    if(attempt!==connectionAttempt){
      stream.getTracks().forEach(t=>t.stop());
      return;
    }
    microphone=stream;
    stream.getTracks().forEach(track=>pc.addTrack(track,stream));
    channel=pc.createDataChannel('oai-events');
    channel.addEventListener('open',()=>{
      if(attempt===connectionAttempt)readyGate?.markChannel();
    });
    channel.addEventListener('message',({data})=>{
      if(attempt!==connectionAttempt)return;
      try{onEvent(JSON.parse(data));}
      catch{status('Получено некорректное событие голосового API.',true);}
    });
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIce(pc);
    if(attempt!==connectionAttempt)return;
    const answer=await window.desktop.create({
      key,sdp:pc.localDescription.sdp,count:requested,
      rememberKey:$('rememberKey').checked
    });
    if(attempt!==connectionAttempt){
      await window.desktop.hangupLive({aborted:true}).catch(()=>{});
      return;
    }
    archiveId=answer.archiveId||null;
    liveSessionId=answer.sessionId||null;
    liveDeadlineAt=Date.parse(answer.deadlineAt)||0;
    if(answer.saveWarning)status(answer.saveWarning,true);
    if(answer.archiveWarning){
      $('archiveNotice').textContent=answer.archiveWarning;
      $('archiveNotice').hidden=false;
    }
    readyGate.arm();
    await pc.setRemoteDescription({type:'answer',sdp:answer.sdp});
    if(attempt!==connectionAttempt)return;
    readyGate?.markRemote();
    if(channel?.readyState==='open')readyGate?.markChannel();
    // No "Connected" label until session.started AND the transport are ready.
    if(!liveActive)status('Ожидаю подтверждение готовности GPT-Live…');
  }catch(error){
    if(attempt===connectionAttempt)
      await abortStartup(error instanceof Error?error.message:String(error));
  }
}
function disconnectGracefully(reason='manual'){
  if(liveSessionId)void window.desktop.requestLiveClose(reason).catch(()=>{});
  return new Promise(resolve=>{
    if(lastSessionClose?.sessionId===liveSessionId && liveSessionId){
      resolve({confirmed:true});return;
    }
    if(channel?.readyState!=='open'){
      if(liveSessionId)void window.desktop.markLiveTransportLost(liveSessionId).catch(()=>{});
      resolve({confirmed:false});return;
    }
    let done=false;
    const t=setTimeout(()=>{
      if(done)return;
      done=true;closeResolve=null;
      if(liveSessionId)void window.desktop.markLiveTransportLost(liveSessionId).catch(()=>{});
      resolve({confirmed:false});
    },5000);
    closeResolve=(result={confirmed:true})=>{
      if(done)return;
      done=true;clearTimeout(t);resolve(result);
    };
    if(!send('session.close',{event_id:'end-'+Date.now()})){
      clearTimeout(t);closeResolve=null;
      if(liveSessionId)void window.desktop.markLiveTransportLost(liveSessionId).catch(()=>{});
      resolve({confirmed:false});
    }
  });
}
async function stop(reason='manual') {
  if(finishing||grading)return;
  finishing=true;
  $('stop').disabled=true;$('mute').disabled=true;
  status(reason==='time_limit'
    ? 'Лимит 30 минут достигнут. Завершаю интервью и сохраняю ответы…'
    : 'Завершаю собеседование…');
  const endedAt=new Date().toISOString(); // Before network shutdown and evaluation.
  const closed=await disconnectGracefully(reason);
  if(!closed.confirmed){
    $('archiveNotice').textContent='OpenAI не подтвердил закрытие голосовой сессии. Проверь подключение перед новым интервью.';
    $('archiveNotice').hidden=false;
  }
  try{
    await flushDraft();
    if(archiveId)await window.desktop.endInterview({
      archiveId,turns:transcript.map(t=>({...t})),endedAt
    });
  }catch(error){
    const previous=$('archiveNotice').hidden?'':$('archiveNotice').textContent+' ';
    $('archiveNotice').textContent=previous+'Не удалось сохранить окончание интервью: '+error.message;
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
  firstOutputSeen=false;greetingAttempts=0;greetingEventId=null;
  audioPlaybackStarted=false;audioPlaybackError=false;lastSessionClose=null;
  usageSeconds=0;fiveMinuteWarningShown=false;
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
  void refreshLiveStatus();
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
    void refreshLiveStatus();
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
$('acknowledgeLive').addEventListener('click',async()=>{
  try{
    await window.desktop.acknowledgeUnknownLive();
    $('liveClosureNotice').hidden=true;
    $('acknowledgeLive').hidden=true;
    status('Риск неподтверждённой предыдущей сессии принят. Можно продолжить.');
  }catch(error){status('Не удалось подтвердить продолжение: '+error.message,true);}
});
$('cancelConnecting').addEventListener('click',()=>{
  void abortStartup('Подключение отменено. Голосовая сессия закрыта.');
});
$('repeatFirstQuestion').addEventListener('click',()=>{
  if(firstOutputSeen && !audioPlaybackStarted){
    void sound.play().then(()=>{
      audioPlaybackStarted=true;audioPlaybackError=false;
      $('repeatFirstQuestion').hidden=true;
      status('Воспроизведение включено.');
    }).catch(()=>status('Не удалось включить звук. Проверь устройство вывода Windows.',true));
  }else if(!firstOutputSeen && requestOpening()){
    status('Повторно запросил первый вопрос · слушаю');
  }
});
$('stop').addEventListener('click',()=>{void stop();});
$('mute').addEventListener('click',()=>{
  if(!microphone)return;
  muted=!muted;
  microphone.getAudioTracks().forEach(track=>track.enabled=!muted);
  send(muted?'session.input_audio.mute':'session.input_audio.unmute',{event_id:'mute-'+Date.now()});
  $('muteLabel').textContent=muted?'Включить микрофон':'Выключить микрофон';
  status(muted?'Микрофон выключен':'Слушаю');
});
$('retry').addEventListener('click',()=>{
  // After a network timeout the previous Responses request might have been
  // charged already. Require informed consent before repeating it.
  if(window.confirm('Повторная оценка может вызвать ещё один платный запрос OpenAI. Продолжить?'))
    void grade();
});
$('reset').addEventListener('click',reset);
$('again').addEventListener('click',reset);
if(window.desktop?.onCloseRequest){
  window.desktop.onCloseRequest(payload=>{
    if(!liveSessionId || payload?.sessionId!==liveSessionId)return;
    if(payload.reason==='time_limit' && !finishing && !grading){
      if(liveActive)void stop('time_limit');
      else void abortStartup('Лимит времени голосовой сессии достигнут до начала интервью.');
    }else if(payload.reason==='app_quit' && !finishing && channel?.readyState==='open'){
      send('session.close',{event_id:'quit-'+Date.now()});
    }
  });
}
if(window.desktop?.onUnconfirmedClose){
  window.desktop.onUnconfirmedClose(()=>{void refreshLiveStatus();});
}
if(window.desktop?.onGradeClosePending){
  window.desktop.onGradeClosePending(()=>{
    status('Окно закроется после сохранения результата оценки…');
  });
}
if(window.desktop?.onWindowCloseRequest){
  window.desktop.onWindowCloseRequest(()=>{
    void (async()=>{
      if(!finishing && liveActive){
        finishing=true;
        const endedAt=new Date().toISOString();
        await disconnectGracefully('app_quit');
        try{
          await flushDraft();
          if(archiveId)await window.desktop.endInterview({
            archiveId,turns:transcript.map(t=>({...t})),endedAt
          });
        }catch(error){console.warn('Archive during window close:',error.message);}
      }else if(!liveActive && pc){
        await abortStartup('Закрытие окна во время подключения.');
      }
    })().catch(error=>console.warn('Close window:',error.message))
      .finally(()=>{void window.desktop.finishWindowClose().catch(()=>{});});
  });
}
window.addEventListener('beforeunload',()=>{
  if(channel?.readyState==='open')send('session.close');
  cleanup();
});
phase('idle');
void initSettings();
if(window.desktop?.listReports)void refreshArchiveHistory();
