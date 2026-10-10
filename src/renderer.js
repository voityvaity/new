'use strict';
const $ = id => document.getElementById(id);
const sound = new Audio();
sound.autoplay = true;
let pc=null, channel=null, microphone=null;
let transcript=[], requested=8;
let started=false, finishing=false, grading=false, muted=false, closeResolve=null;
let greeted=false;

function status(message,error=false) {
  $('status').textContent=message;
  $('error').hidden=!error;
  if(error)$('error').textContent=message;
}
function speech(isSpeaking){$('portrait').classList.toggle('speaking',isSpeaking);}
function phase(mode) {
  const idle=mode==='idle', active=mode==='active', fault=mode==='fault';
  $('setup').hidden=!idle;
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
  started=false;muted=false;greeted=false;
  speech(false);
  $('mute').textContent='Выключить микрофон';
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
  const piece=delta.trim();
  if(piece)$('excerpt').textContent=(role==='candidate'?'Ты: ':'Александр: ')+piece;
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
  $('results').hidden=true;
  $('excerpt').textContent='Новая попытка: поговори с интервьюером голосом.';
  phase('idle');status('Готов к собеседованию');
}
$('start').addEventListener('click',begin);
$('stop').addEventListener('click',()=>{void stop();});
$('mute').addEventListener('click',()=>{
  if(!microphone)return;
  muted=!muted;
  microphone.getAudioTracks().forEach(track=>track.enabled=!muted);
  send(muted?'session.input_audio.mute':'session.input_audio.unmute',{event_id:'mute-'+Date.now()});
  $('mute').textContent=muted?'Включить микрофон':'Выключить микрофон';
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
