'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
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
  assert.match(html,/src="\.\.\/assets\/interviewer\.jpg"/);
  assert.match(css,/@media\(max-width:740px\)/);
  assert.match(css, /prefers-reduced-motion/);
});
test('explicit API key visibility control and no browser storage',()=>{
  assert.match(html,/id="key" type="password"/);
  assert.match(js,/input\.type=shown\?'text':'password'/);
  assert.doesNotMatch(js,/localStorage|sessionStorage/);
});
