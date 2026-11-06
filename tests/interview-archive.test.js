'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createInterviewArchive,cleanTurns,escapeHtml,reportHtml}=require('../src/interview-archive');

const evaluation={
  score:8,verdict:'Хороший результат',
  strengths:['Знание Python'],improve:['SQL'],
  next_steps:['Практиковаться']
};
const turns=[
  {role:'interviewer',text:'Что такое генератор?',start:0,end:1100},
  {role:'candidate',text:'Генератор выдаёт значения по одному.',start:1500,end:3000}
];

test('sanitizes report HTML and ignores unsupported transcript roles',()=>{
  assert.equal(escapeHtml('<script>&"'), '&lt;script&gt;&amp;&quot;');
  assert.equal(cleanTurns([{role:'evil',text:'bad'},...turns]).length,2);
  const html=reportHtml({
    id:'example',startedAt:'2026-11-06T10:00:00Z',endedAt:'2026-11-06T10:10:00Z',
    questionsRequested:5, transcript:[{role:'candidate',text:'<script>alert(1)</script>'}],
    evaluation:{...evaluation,verdict:'<img src=x>'}
  });
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
  assert.ok(html.includes('&lt;img src=x&gt;'));
  assert.ok(!html.includes('<script>'));
});

test('automatically saves PDF and JSON and removes the in-progress draft',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mock-archive-'));
  try{
    let rendered='';
    const archive=createInterviewArchive({
      draftDirectory:path.join(root,'drafts'),
      generatePdf:async html=>{rendered=html;return Buffer.from('%PDF-1.4 test');}
    });
    const started=await archive.start(5);
    await archive.snapshot(turns);
    assert.equal((await fs.readdir(path.join(root,'drafts'))).length,1);
    const result=await archive.finalize({
      turns,evaluation,reportDirectory:path.join(root,'results'),saveJson:true
    });
    assert.match(result.pdfFile,/Оценка-8.*\.pdf$/);
    assert.match(rendered,/Что такое генератор/);
    assert.equal((await fs.readFile(result.pdfFile,'utf8')),'%PDF-1.4 test');
    const data=JSON.parse(await fs.readFile(result.jsonFile,'utf8'));
    assert.equal(data.id,started.id);
    assert.equal(data.questionsRequested,5);
    assert.equal(data.transcript.length,2);
    assert.equal(data.evaluation.score,8);
    assert.deepEqual(await fs.readdir(path.join(root,'drafts')),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('JSON can be disabled and a failed PDF preserves the draft',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mock-archive-'));
  try{
    const fail=createInterviewArchive({
      draftDirectory:path.join(root,'drafts'),
      generatePdf:async()=>{throw new Error('printer unavailable');}
    });
    await fail.start(8);
    await fail.snapshot(turns);
    await assert.rejects(fail.finalize({
      turns,evaluation,reportDirectory:path.join(root,'results'),saveJson:false
    }),/printer unavailable/);
    assert.equal((await fs.readdir(path.join(root,'drafts'))).length,1);
    const success=createInterviewArchive({
      draftDirectory:path.join(root,'other-drafts'),
      generatePdf:async()=>Buffer.from('%PDF-1.4')
    });
    await success.start(8);
    const completed=await success.finalize({
      turns,evaluation,reportDirectory:path.join(root,'results'),saveJson:false
    });
    assert.equal(completed.jsonFile,null);
    assert.deepEqual((await fs.readdir(path.join(root,'results'))).filter(x=>x.endsWith('.json')),[]);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});

test('serialized snapshots keep the newest transcript',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'mock-archive-'));
  try{
    const archive=createInterviewArchive({draftDirectory:root,generatePdf:async()=>Buffer.from('pdf')});
    const {id}=await archive.start(10);
    await Promise.all([
      archive.snapshot([{role:'candidate',text:'первый'}]),
      archive.snapshot([{role:'candidate',text:'последний'}])
    ]);
    const data=JSON.parse(await fs.readFile(path.join(root,id+'.json'),'utf8'));
    assert.equal(data.transcript[0].text,'последний');
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
