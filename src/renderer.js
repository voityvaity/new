'use strict';
const $ = id => document.getElementById(id);
const sound = new Audio();
sound.autoplay = true;
let pc=null, channel=null, microphone=null;
let transcript=[], requested=8;
let started=false, finishing=false, grading=false, muted=false, closeResolve=null;
let greeted=false;
let showTranscript=false, clockInterval=null, callStartedAt=0;

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
  $('plannedCount').textContent=requested+' основных вопросов';
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
function appendTranscript(role,delta,start,end) {
  if(typeof delta!=='string'||!delta)return;
  const a=Number.isFinite(start)?start:0;
  const b=Number.isFinite(end)?end:a;
  const prev=transcript.at(-1);
  if(prev&&prev.role===role&&a>=prev.start-300&&a-prev.end<=1200) {
    prev.text+=delta;
    prev.end=Math.max(prev.end,b);
  } else transcript.push({role,text:delta,start:a,end:b});
  const current=transcript.at(-1);
  if(current){
    $('liveSpeaker').textContent=role==='candidate'?'Твой ответ':'Александр спрашивает';
    $('liveText').textContent=current.text.trim()||'Ожидаем следующую реплику…';
  }
  if(showTranscript)refreshTranscript();
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
          content:'Начни прямо сейчас: представься кратко по-русски как виртуальный интервьюер тренировочного Junior Python собеседования, ориентированного на Яндекс. Сразу задай первый основной вопрос и жди ответа. Не проси пользователя начать.'
        });
      }
      break;
    case 'session.input_transcript.delta':
      appendTranscript('candidate',evt.delta,evt.start_ms,evt.end_ms);
      status('Слушаю твой ответ');speech(false);
      break;
    case 'session.output_transcript.delta':
      appendTranscript('interviewer',evt.delta,evt.start_ms,evt.end_ms);
      status('Александр говорит');speech(true);
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
    const answer=await window.desktop.create({key,sdp:pc.localDescription.sdp,count:requested});
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
  await disconnectGracefully();
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
    const result=await window.desktop.grade({turns,count:requested});
    $('score').textContent=String(result.score);
    $('verdict').textContent=result.verdict;
    for(const [element,key] of [['strengths','strengths'],['improve','improve'],['steps','next_steps']]){
      const list=$(element);list.replaceChildren();
      for(const item of result[key]||[]){
        const li=document.createElement('li');li.textContent=String(item);list.append(li);
      }
    }
    $('excerpt').textContent='Интервью завершено. Ниже — оценка твоих ответов.';
    phase('result');status('Результат готов');
  } catch(error) {
    phase('fault');
    status(error instanceof Error?error.message:String(error),true);
  } finally{grading=false;finishing=false;}
}
function reset() {
  cleanup();
  void window.desktop?.clear();
  transcript=[];finishing=false;grading=false;closeResolve=null;
  toggleTranscript(false);
  $('results').hidden=true;
  $('key').type='password';
  $('showKey').textContent='Показать';
  $('showKey').setAttribute('aria-label','Показать ключ');
  $('showKey').setAttribute('aria-pressed','false');
  $('excerpt').textContent='Новая попытка: поговори с интервьюером голосом.';
  phase('idle');status('Готов к собеседованию');
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
