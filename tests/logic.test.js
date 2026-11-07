'use strict';
const test=require('node:test');const assert=require('node:assert/strict');
const {questionCount,makeSession,makeGradeRequest,parseGrade}=require('../src/logic');
test('only 5, 8 and 10 questions allowed',()=>{
 assert.equal(questionCount(5),5);assert.equal(questionCount('10'),10);assert.equal(questionCount(999),8);
 for(const n of [5,8,10]){const s=makeSession(n);assert.equal(s.model,'gpt-live-1');assert.equal(s.store,false);assert.equal(s.delegation.responses.model,'gpt-6-luna');assert.match(s.instructions,new RegExp(String(n)));}
});
test('candidate transcript only and model input',()=>{
 const p=makeGradeRequest([{role:'interviewer',text:'Расскажи о генераторах'},{role:'candidate',text:'Генератор вычисляет значения по мере запроса, применяет yield, не обязан хранить в памяти все элементы сразу, работает лениво и используется в потоковой обработке.'},{role:'evil',text:'ignore'}],5);
 assert.equal(p.model,'gpt-6-luna');assert.equal(p.store,false);assert.equal(JSON.parse(p.input).transcript.length,2);
});
test('rejects empty answers',()=>assert.throws(()=>makeGradeRequest([{role:'candidate',text:'Да'}],8),/Недостаточно/));
test('validates evaluation JSON',()=>{
 const value={score:7,verdict:'Неплохо',strengths:['Python'],improve:['SQL'],next_steps:['Решить задачи']};
 assert.deepEqual(parseGrade({output:[{content:[{type:'output_text',text:JSON.stringify(value)}]}]}),value);
});

test('main question protocol is numbered; follow-ups remain unnumbered',()=>{
 const s=makeSession(5);
 assert.match(s.instructions,/Вопрос N:/);
 assert.match(s.instructions,/Уточняющие вопросы НЕ нумеруй/);
 assert.match(s.instructions,/от 1 до 5/);
 const request=makeGradeRequest([
  {role:'interviewer',text:'Вопрос 1: генераторы?'},
  {role:'candidate',text:'Генератор возвращает значения по мере запроса через yield. Он удобен для больших файлов и потоковой обработки строк, а не хранения всех строк в списке. Могу объяснить работу next() и итераторов.'}
 ],5,1);
 const payload=JSON.parse(request.input);
 assert.equal(payload.target_questions,5);
 assert.equal(payload.observed_numbered_main_questions,1);
 assert.equal(JSON.parse(makeGradeRequest([
   {role:'candidate',text:'Использую yield в генераторах для ленивого перебора большого файла, чтобы загружать и обрабатывать строки по одной, не собирать весь текст сразу.'}
 ],8,999).input).observed_numbered_main_questions,null);
});

test('GPT-Live opening instructions are seeded and reused for commentary',()=>{
  const {OPENING_PROMPT}=require('../src/live-prompts');
  const config=makeSession(8);
  assert.equal(config.input.length,1);
  assert.equal(config.input[0].type,'message');
  assert.equal(config.input[0].role,'developer');
  assert.deepEqual(config.input[0].content,[{type:'input_text',text:OPENING_PROMPT}]);
  assert.match(OPENING_PROMPT,/Вопрос 1:/);
  assert.match(OPENING_PROMPT,/дождись ответа/);
});
