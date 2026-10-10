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
