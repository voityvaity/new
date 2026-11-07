'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const base=path.join(__dirname,'../src');
const html=fs.readFileSync(path.join(base,'index.html'),'utf8');
const js=fs.readFileSync(path.join(base,'renderer.js'),'utf8');
const css=fs.readFileSync(path.join(base,'styles.css'),'utf8');

test('all referenced UI IDs exist and are unique',()=>{
  const ids=[...html.matchAll(/\bid="([^"]+)"/g)].map(x=>x[1]);
  assert.equal(ids.length,new Set(ids).size,'Duplicate HTML IDs');
  const referenced=[...js.matchAll(/\$\('([^']+)'\)/g)].map(x=>x[1]);
  for(const id of referenced)assert.ok(ids.includes(id),'Missing element #'+id);
  for(const id of ['setup','conversation','faultInfo','results','liveText','transcriptWrap','showKey','muteLabel'])
    assert.ok(ids.includes(id));
});
test('live controls and results begin hidden',()=>{
  for(const id of ['mute','stop','retry','reset','results','conversation','faultInfo','timer','transcriptWrap'])
    assert.match(html,new RegExp('<[^>]+id="'+id+'"[^>]*\\bhidden\\b'));
});
test('transcript uses text nodes, never HTML injection',()=>{
  assert.match(js,/line\.textContent=turn\.text/);
  assert.match(js,/\$\('liveText'\)\.textContent=current\.text/);
  assert.doesNotMatch(js,/\.innerHTML\s*=/);
});
test('desktop portrait and responsive motion settings',()=>{
  assert.match(html,/src="\.\.\/assets\/interviewer\.webp"/);
  assert.match(css,/@media\(max-width: 760px\)/);
  assert.match(css, /prefers-reduced-motion/);
});
test('explicit API key visibility control and no browser storage',()=>{
  assert.match(html,/id="key" type="password"/);
  assert.match(js,/input\.type=shown\?'text':'password'/);
  assert.doesNotMatch(js,/localStorage|sessionStorage/);
});

test('archive folder, JSON option and saved-report feedback are wired into UI',()=>{
  for(const id of ['reportFolder','chooseReportsFolder','openReportsFolder','saveJson','archiveNotice','archiveStatus','openResultFolder'])
    assert.match(html,new RegExp('\\bid="'+id+'"'));
  assert.match(js,/window\.desktop\.chooseReportsFolder\(\)/);
  assert.match(js,/window\.desktop\.saveDraft\(\{archiveId,turns\}\)/);
  assert.match(js,/window\.desktop\.endInterview\(/);
  assert.match(js,/window\.desktop\.listReports\(\)/);
  assert.match(js,/window\.desktop\.exportReport\(/);
  for(const id of ['archiveHistory','refreshArchiveHistory','retryReport'])
    assert.match(html,new RegExp('\\bid="'+id+'"'));
  assert.match(js,/result\.archive\?\.pdfFile/);
});

test('desktop logo follows the supplied graphite Q waveform artwork',()=>{
  const svg=fs.readFileSync(path.join(__dirname,'../assets/quickcue-graphite.svg'),'utf8');
  assert.match(svg,/<svg[^>]*viewBox="0 0 1254 1254"/);
  assert.match(svg,/fill-rule="evenodd"/);
  assert.match(svg,/radialGradient id="paper"/);
  assert.match(html,/class="brand-icon" src="\.\.\/assets\/quickcue-graphite\.svg"/);
  assert.doesNotMatch(html,/class="brand-mark"|JM<span/);
  const png=fs.readFileSync(path.join(__dirname,'../assets/quickcue-graphite.png'));
  assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
  assert.equal(png.readUInt32BE(16),1024);
  assert.equal(png.readUInt32BE(20),1024);
});
test('desktop design follows QuickCue semantic neutral/blue system palette',()=>{
  assert.match(css,/--accent:\s*#007aff/);
  assert.match(css,/--accent:\s*#0a84ff/);
  assert.match(css,/--bg:\s*#f2f2f7/);
  assert.match(css,/prefers-color-scheme:\s*dark/);
  assert.match(css,/--surface:\s*#ffffff/);
  assert.doesNotMatch(css,/avatar-decoration|radial-gradient/);
});

test('live transcript tracker loads before renderer and question counter is reset per interview',()=>{
 const a=html.indexOf('src="transcript-tracker.js"');
 const b=html.indexOf('src="renderer.js"');
 assert.ok(a>0 && b>a,'transcript tracker must load before UI event handlers');
 assert.match(js,/window\.LiveTranscript\.createTranscriptTracker\(\)/);
 assert.match(js,/window\.LiveTranscript\.createQuestionTracker\(requested\)/);
 assert.match(js,/appendTranscript\('candidate',evt\)/);
 assert.match(js,/appendTranscript\('interviewer',evt\)/);
 assert.match(js,/progress\.overLimit/);
 assert.match(js,/observedMainQuestions:questionTracker\.confirmed/);
});
