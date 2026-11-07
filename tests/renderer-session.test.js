'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');

function rendererHarness(confirmed) {
  const elements=new Map();
  let confirmations=0;
  const get=(id)=>{
    if(!elements.has(id))elements.set(id,{
      textContent:'',hidden:false,value:'',disabled:false,
      classList:{toggle(){},add(){},remove(){}},
      addEventListener(){},setAttribute(){},
      replaceChildren(){},append(){},scrollHeight:0,scrollTop:0
    });
    return elements.get(id);
  };
  const context={
    document:{getElementById:get},
    window:{
      LiveTranscript:require('../src/transcript-tracker'),
      LiveLifecycle:require('../src/live-lifecycle'),
      LivePrompts:require('../src/live-prompts'),
      desktop:{confirmLiveClosed:async()=>{confirmations++;return confirmed;}},
      addEventListener(){}
    },
    console,setTimeout,clearTimeout,setInterval,clearInterval,queueMicrotask,
    Audio:class{constructor(){this.autoplay=false;} play(){return Promise.resolve();}},
    Date,Number,String,JSON
  };
  const code=fs.readFileSync(path.join(__dirname,'../src/renderer.js'),'utf8');
  vm.runInNewContext(code+