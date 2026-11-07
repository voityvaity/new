'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {app,BrowserWindow,nativeTheme}=require('electron');

app.on('window-all-closed',()=>{});

async function check(mode,width=1080,height=840) {
  nativeTheme.themeSource=mode;
  const window=new BrowserWindow({
    width,height,show:false,backgroundColor:mode==='dark'?'#000000':'#f2f2f7',
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}
  });
  try{
    await window.loadFile(path.join(__dirname,'../src/index.html'));
    const checkScript=[
      '(() => {',
      'const icon=document.querySelector(".brand-icon");',
      'const panel=document.querySelector(".panel");',
      'const styles=getComputedStyle(document.documentElement);',
      'return {title:document.querySelector(".brand-name")?.textContent,',
      'iconWidth:icon?.naturalWidth, iconHeight:icon?.naturalHeight,',
      'panelBackground:getComputedStyle(panel).backgroundColor,',
      'accent:styles.getPropertyValue("--accent").trim(),',
      'startVisible:!document.querySelector("#start").hidden,',
      'startRect:(()=>{const r=document.querySelector("#start").getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height};})(),',
      'viewportHeight:window.innerHeight,',
      'extrasCollapsed:!document.querySelector("#extras").open,',
      'contextCollapsed:!document.querySelector("#interviewContext").open,',
      'fields:!!document.querySelector("#key")&&!!document.querySelector("#count")};',
      '})()'
    ].join('\n');
    const state=await window.webContents.executeJavaScript(checkScript);
    assert.match(state.title,/QuickCue/);
    assert.equal(state.iconWidth,1024);
    assert.equal(state.iconHeight,1024);
    assert.equal(state.accent,mode==='dark'?'#0a84ff':'#007aff');
    assert.equal(state.startVisible,true);
    assert.equal(state.extrasCollapsed,true,'Optional settings must start collapsed');
    assert.equal(state.contextCollapsed,true,'Resume and vacancy should not clutter setup');
    assert.ok(state.startRect.height>=44,'Primary action is too small');
    assert.ok(state.startRect.top>=0 && state.startRect.bottom<=state.viewportHeight,
      'Start button is outside the visible viewport: '+JSON.stringify(state.startRect)+
      ' of '+state.viewportHeight);
    assert.equal(state.fields,true);
    assert.notEqual(state.panelBackground,'rgba(0, 0, 0, 0)');
    const image=await window.webContents.capturePage();
    const png=image.toPNG();
    assert.ok(png.length>20000,'Desktop screenshot unexpectedly small');
    const target=path.join(__dirname,'../ui-preview');
    await fs.mkdir(target,{recursive:true});
    await fs.writeFile(path.join(target,'quickcue-'+mode+(width<1000?'-compact':'')+'.png'),png);
    console.log('QuickCue '+mode+' theme and supplied graphite waveform icon OK; screenshot '+png.length+' bytes');
  } finally {
    if(!window.isDestroyed())window.destroy();
  }
}
app.whenReady().then(async()=>{
  await check('light');
  await check('dark');
  // Minimum supported Windows size: the user must still see Start without scroll.
  await check('light',730,640);
  app.quit();
}).catch(e=>{console.error(e);app.exit(1);});
