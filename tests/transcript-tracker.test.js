'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createTranscriptTracker,createQuestionTracker}=require('../src/transcript-tracker');

test('interleaved interviewer and candidate deltas never steal another speaker fragment',()=>{
  const t=createTranscriptTracker();
  t.append('candidate','Когда я ',1000,1200,'a1');
  t.append('interviewer','Да, ',1300,1400,'b1');
  t.append('candidate','читаю файл, ',1400,1800,'a2');
  t.append('interviewer','продолжайте.',1800,2200,'b2');
  t.append('candidate','беру строки по одной.',2200,2600,'a3');
  const turns=t.turns();
  assert.equal(turns.length,2);
  const candidate=turns.find(x=>x.role==='candidate');
  const interviewer=turns.find(x=>x.role==='interviewer');
  assert.equal(candidate.text,'Когда я читаю файл, беру строки по одной.');
  assert.equal(interviewer.text,'Да, продолжайте.');
  assert.equal(candidate.start,1000);
  assert.equal(candidate.end,2600);
});

test('preserves raw fragments, repeated words, and ignores exact duplicate server event IDs',()=>{
  const t=createTranscriptTracker();
  t.append('interviewer','Вопрос ',300,400,'evt-1');
  t.append('interviewer','Вопрос ',300,400,'evt-1');
  t.append('interviewer','1: зачем генератор?',400,500,'evt-2');
  assert.equal(t.turns()[0].text,'Вопрос 1: зачем генератор?');
  const again=createTranscriptTracker();
  again.append('candidate','да да ',0,200,'one');
  again.append('candidate','да',200,300,'two');
  assert.equal(again.turns()[0].text,'да да да');
});

test('separates longer speech pauses for same person and orders by audio time',()=>{
  const t=createTranscriptTracker();
  t.append('interviewer','Сначала ',1000,1300,'b1');
  t.append('candidate','Ответ.',1600,2200,'a1');
  t.append('interviewer','Теперь другой вопрос.',4900,5200,'b2');
  assert.deepEqual(t.turns().map(x=>x.role),['interviewer','candidate','interviewer']);
  assert.equal(t.turns().length,3);
});

test('missing timestamps do not accidentally merge unrelated turns',()=>{
  const t=createTranscriptTracker();
  t.append('candidate','Раз.',undefined,undefined,'evt-1');
  t.append('candidate','Два.',undefined,undefined,'evt-2');
  assert.equal(t.turns().length,2);
  assert.equal(t.turns()[0].start,null);
});

test('counts only sequential explicitly labelled main questions; not clarification marks',()=>{
  const t=createTranscriptTracker();
  const q=createQuestionTracker(5);
  t.append('interviewer','Привет. Вопрос ',0,350,'1');
  assert.equal(q.inspect(t.turns()).confirmed,0);
  t.append('interviewer','1: что такое dict?',350,950,'2');
  assert.equal(q.inspect(t.turns()).confirmed,1);
  t.append('candidate','Словарь.',1000,1400,'3');
  t.append('interviewer','А когда он удобен?',1450,1800,'4');
  assert.equal(q.inspect(t.turns()).confirmed,1,'Follow-up does not count');
  t.append('interviewer',' Вопрос 2: чем отличается list?',1900,2350,'5');
  assert.equal(q.inspect(t.turns()).confirmed,2);
});

test('question limit detects an explicitly numbered extra and gaps',()=>{
  const q=createQuestionTracker(5);
  for(let n=1;n<=5;n++){
    const r=q.inspect([{role:'interviewer',text:Array.from({length:n},(_,i)=>'Вопрос '+(i+1)+': '+i).join('? ') }]);
    assert.equal(r.confirmed,n);
  }
  assert.equal(q.inspect([{role:'interviewer',text:'Вопрос 6: лишний'}]).overLimit,true);
  const q2=createQuestionTracker(8);
  assert.equal(q2.inspect([{role:'interviewer',text:'Вопрос 3: слишком рано.'}]).gapDetected,true);
  assert.equal(q2.confirmed,0);
  q2.reset();
  assert.equal(q2.confirmed,0);
});
