'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {createInterviewArchive, cleanTurns, escapeHtml, reportHtml, durationLabel} =
  require('../src/interview-archive');

const evaluation = {
  score:8,verdict:'Хороший результат',
  strengths:['Знание Python'],improve:['SQL'],next_steps:['Практиковаться']
};
const turns = [
  {role:'interviewer',text:'Что такое генератор?',start:0,end:1100},
  {role:'candidate',text:'Генератор выдаёт значения по одному.',start:1500,end:3000}
];
const validPdf = Buffer.concat([Buffer.from('%PDF-1.7\n'),Buffer.alloc(2048),Buffer.from('\n%%EOF')]);
const makeArchive = (root,printer=async()=>validPdf) =>
  createInterviewArchive({draftDirectory:path.join(root,'drafts'),generatePdf:printer});

async function withTemp(fn) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'interview-archive-'));
  try {await fn(root);} finally {await fs.rm(root,{recursive:true,force:true});}
}

test('escapes HTML content in both graded and unfinished PDFs',()=>{
  assert.equal(escapeHtml('<script>&"'),'&lt;script&gt;&amp;&quot;');
  assert.equal(cleanTurns([{role:'evil',text:'bad'},...turns]).length,2);
  const base={
    id:'sample',startedAt:'2026-11-06T10:00:00Z',
    endedAt:'2026-11-06T10:10:00Z',questionsRequested:5,
    transcript:[{role:'candidate',text:'<script>alert(1)</script>'}]
  };
  const graded=reportHtml({...base,evaluation:{...evaluation,verdict:'<img src=x>'}});
  const unfinished=reportHtml(base);
  assert.match(graded,/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(graded,/&lt;img src=x&gt;/);
  assert.doesNotMatch(graded,/<script>/);
  assert.match(unfinished,/Без оценки/);
  assert.match(unfinished,/Сохранена доступная расшифровка/);
});

test('duration ends when conversation ends, not after grading or PDF export',()=>{
  const record={
    startedAt:'2026-11-06T10:00:00Z',endedAt:'2026-11-06T10:05:10Z',
    updatedAt:'2026-11-06T11:45:00Z'
  };
  assert.equal(durationLabel(record),'5 мин 10 сек');
  assert.match(reportHtml({...record,questionsRequested:5,transcript:[]}),/5 мин 10 сек/);
});

test('persists evaluation before PDF and supports retry with JSON disabled',async()=>{
  await withTemp(async root=>{
    let fail=true;
    const printer=async()=>{
      if(fail)throw new Error('PDF renderer unavailable');
      return validPdf;
    };
    const a=makeArchive(root,printer);
    const {id}=await a.start(5);
    await a.snapshot(id,turns);
    await a.end(id,turns,new Date(Date.now()+1000).toISOString());
    await a.storeEvaluation(id,evaluation);
    const directory=path.join(root,'reports');
    await assert.rejects(a.exportReport(id,directory,false),/PDF renderer unavailable/);
    const stored=JSON.parse(await fs.readFile(path.join(root,'drafts',id+'.json'),'utf8'));
    assert.equal(stored.evaluation.score,8);
    assert.equal(stored.status,'evaluated');
    assert.equal((await a.list())[0].hasEvaluation,true);
    fail=false;
    const exported=await a.exportReport(id,directory,false);
    assert.equal(exported.jsonFile,null);
    assert.ok(exported.pdfFile.endsWith('.pdf'));
    assert.deepEqual(await fs.readFile(exported.pdfFile),validPdf);
    assert.equal((await a.list())[0].status,'exported');
    assert.equal((await fs.readdir(directory)).filter(n=>n.endsWith('.json')).length,0);
  });
});

test('recovers a crashed unfinished interview after restart, no API call',async()=>{
  await withTemp(async root=>{
    const before=makeArchive(root);
    const {id}=await before.start(8);
    await before.snapshot(id,turns);
    const after=makeArchive(root);
    const history=await after.list();
    assert.equal(history.length,1);
    assert.equal(history[0].id,id);
    assert.equal(history[0].hasEvaluation,false);
    const folder=path.join(root,'manual-recovery');
    const exported=await after.exportReport(id,folder,true);
    assert.match(exported.pdfFile,/Без-оценки/);
    const report=JSON.parse(await fs.readFile(exported.jsonFile,'utf8'));
    assert.equal(report.transcript.length,2);
    assert.equal(report.evaluation,undefined);
    assert.ok((await fs.readFile(exported.pdfFile)).equals(validPdf));
  });
});

test('serializes snapshots and ignores late writes after the interview ends',async()=>{
  await withTemp(async root=>{
    const archive=makeArchive(root);
    const {id}=await archive.start(10);
    await Promise.all([
      archive.snapshot(id,[{role:'candidate',text:'first'}]),
      archive.snapshot(id,[{role:'candidate',text:'latest'}])
    ]);
    const before=JSON.parse(await fs.readFile(path.join(root,'drafts',id+'.json'),'utf8'));
    assert.equal(before.transcript[0].text,'latest');
    await archive.end(id,turns);
    await archive.snapshot(id,[{role:'candidate',text:'late and unwanted'}]);
    const after=JSON.parse(await fs.readFile(path.join(root,'drafts',id+'.json'),'utf8'));
    assert.equal(after.transcript.length,2);
    await assert.rejects(archive.exportReport('../other',root),/Некорректный/);
  });
});

test('rejects malformed PDF and keeps recovery data',async()=>{
  await withTemp(async root=>{
    const archive=makeArchive(root,async()=>Buffer.from('not a PDF'));
    const {id}=await archive.start(5);
    await archive.end(id,turns);
    await archive.storeEvaluation(id,evaluation);
    await assert.rejects(archive.exportReport(id,root,false),/корректный PDF/);
    const stored=JSON.parse(await fs.readFile(path.join(root,'drafts',id+'.json'),'utf8'));
    assert.equal(stored.evaluation.score,8);
  });
});

test('full long transcript is retained in local recovery and JSON export',async()=>{
  await withTemp(async root=>{
    const archive=makeArchive(root);
    const {id}=await archive.start(5);
    const longText='Слова ответа '.repeat(2500);
    const full=[{role:'candidate',text:longText,start:0,end:30000}];
    await archive.snapshot(id,full);
    await archive.end(id,full);
    const file=path.join(root,'drafts',id+'.json');
    const stored=JSON.parse(await fs.readFile(file,'utf8'));
    assert.equal(stored.transcript[0].text,longText);
    const exported=await archive.exportReport(id,path.join(root,'reports'),true);
    const doc=JSON.parse(await fs.readFile(exported.jsonFile,'utf8'));
    assert.equal(doc.transcript[0].text,longText);
  });
});
test('oversized transcript is rejected explicitly, never silently clipped',async()=>{
  await withTemp(async root=>{
    const a=makeArchive(root);
    const {id}=await a.start(5);
    await assert.rejects(a.snapshot(id,[{role:'candidate',text:'А'.repeat(500001)}]),
      /слишком велика/);
    await assert.rejects(a.snapshot(id,Array.from({length:2001},()=>({
      role:'candidate',text:'Тест'
    }))),/Слишком много фрагментов/);
  });
});

test('stored evaluation can be reused without another paid model call',async()=>{
  await withTemp(async root=>{
    const archive=makeArchive(root);
    const {id}=await archive.start(5);
    assert.equal(await archive.getEvaluation(id),null);
    await archive.end(id,turns);
    await archive.storeEvaluation(id,evaluation);
    const revived=makeArchive(root);
    assert.deepEqual(await revived.getEvaluation(id),evaluation);
  });
});
