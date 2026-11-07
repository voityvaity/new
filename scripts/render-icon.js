'use strict';
// Rasterize the approved graphite Q/waveform contours for a Windows icon.
// Source traced from the user's attached graphite-q-wave-source.png.
const fs=require('node:fs/promises');
const path=require('node:path');
const assert=require('node:assert/strict');
const {app,BrowserWindow}=require('electron');
app.on('window-all-closed',()=>{});
app.whenReady().then(async()=>{
  const window=new BrowserWindow({
    width:1024,height:1024,useContentSize:true,show:false,frame:false,
    backgroundColor:'#f8f9fb',
    webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}
  });
  try {
    await window.loadFile(path.join(__dirname,'../assets/quickcue-graphite.svg'));
    const image=await window.webContents.capturePage();
    const normalized=image.resize({width:1024,height:1024});
    const png=normalized.toPNG();
    assert.equal(png.subarray(0,8).toString('hex'),'89504e470d0a1a0a');
    assert.equal(png.readUInt32BE(16),1024);
    assert.equal(png.readUInt32BE(20),1024);
    if(png.length<10000)throw new Error('QuickCue icon is unexpectedly small.');
    const output=path.join(__dirname,'../assets/quickcue-graphite.png');
    await fs.writeFile(output,png);
    console.log('QuickCue graphite logo rendered to '+output+' ('+png.length+' bytes)');
  } finally {
    if(!window.isDestroyed())window.destroy();
  }
  app.quit();
}).catch(error=>{console.error(error);app.exit(1);});