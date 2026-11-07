'use strict';
const assert=require('node:assert/strict');
const {app}=require('electron');
const {printReport}=require('../src/pdf-printer');
const {reportHtml}=require('../src/interview-archive');

app.on('window-all-closed',()=>{});

const base={
  id:'test',startedAt:'2026-11-07T11:00:00Z',endedAt:'2026-11-07T11:12:30Z',
  questionsRequested:8,
  transcript:Array.from({length:80},(_,i)=>({
    role:i%2?'candidate':'interviewer',
    text:(i%2?'Ответ кандидата: ':'Вопрос интервьюера: ')+
      'Проверка реального русского текста, длинного диалога, границ страниц и сохранения PDF. '.repeat(4)
  }))
};
const score={
  score:8,verdict:'Развёрнутая оценка работы кандидата.',
  strengths:['Python','Обработка исключений'],
  improve:['SQL','Проектирование API'],
  next_steps:['Повторить типовые задания']
};

async function verify(name,data) {
  const bytes=await printReport(reportHtml(data));
  assert.ok(Buffer.isBuffer(bytes),'PDF must be a Buffer');
  assert.ok(bytes.length>5000,'PDF is unexpectedly small');
  const raw=bytes.toString('latin1');
  assert.ok(raw.startsWith('%PDF-'),'No PDF header');
  assert.ok(raw.includes('%%EOF'),'No PDF trailer');
  assert.match(raw,/\/Type\s*\/Page\b/,'No PDF page object found');
  console.log(name+': real Electron PDF generated ('+bytes.length+' bytes)');
}
app.whenReady()
  .then(async()=>{
    await verify('Evaluated interview',{...base,evaluation:score});
    await verify('Unfinished interview',base);
    app.quit();
  })
  .catch(error=>{
    console.error(error);
    app.exit(1);
  });
