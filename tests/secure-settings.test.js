'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const os=require('node:os');
const fs=require('node:fs/promises');
const path=require('node:path');
const {createSettingsStore}=require('../src/secure-settings');
const storage={
  isEncryptionAvailable:()=>true,
  encryptString:s=>Buffer.from('stored|'+s,'utf8'),
  decryptString:b=>b.toString('utf8').replace(/^stored\|/,'')
};
test('persists key in protected format and restores it',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-prefs-'));
  try{
    const prefs=createSettingsStore({userData:folder,secureStorage:storage});
    await prefs.save({rememberKey:true,count:10,key:'sk-example-for-test-only'});
    const raw=await fs.readFile(path.join(folder,'settings.json'),'utf8');
    assert.doesNotMatch(raw,/sk-example-for-test-only/);
    const loaded=await prefs.read();
    assert.equal(loaded.key,'sk-example-for-test-only');
    assert.equal(loaded.count,10);
    await prefs.save({count:5});
    assert.equal((await prefs.read()).key,'sk-example-for-test-only');
    await prefs.save({rememberKey:false});
    assert.equal((await prefs.read()).key,'');
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('no unencrypted fallback',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-prefs-'));
  try{
    const prefs=createSettingsStore({userData:folder,secureStorage:{isEncryptionAvailable:()=>false}});
    await assert.rejects(prefs.save({rememberKey:true,key:'sk-example-for-test-only'}),/Безопасное/);
    await assert.rejects(fs.readFile(path.join(folder,'settings.json'),'utf8'),{code:'ENOENT'});
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('report directory and JSON preference survive restart and concurrent updates',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-prefs-'));
  try{
    const defaults=path.join(folder,'reports-default');
    const chosen=path.join(folder,'reports-selected');
    const prefs=createSettingsStore({userData:folder,secureStorage:storage,defaultReportDirectory:defaults});
    const initial=await prefs.read();
    assert.equal(initial.reportDirectory,defaults);
    assert.equal(initial.saveJson,true);
    await Promise.all([
      prefs.save({reportDirectory:chosen}),
      prefs.save({saveJson:false}),
      prefs.save({count:10})
    ]);
    const restarted=createSettingsStore({userData:folder,secureStorage:storage,defaultReportDirectory:defaults});
    const saved=await restarted.read();
    assert.equal(saved.reportDirectory,chosen);
    assert.equal(saved.saveJson,false);
    assert.equal(saved.count,10);
    await assert.rejects(prefs.save({reportDirectory:'relative-path'}),/абсолютная/);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('settings replacement is atomic and leaves no temporary file after concurrent saves',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-settings-'));
  try{
    const prefs=createSettingsStore({userData:folder,secureStorage:storage});
    await Promise.all(Array.from({length:12},(_,i)=>prefs.save({count:[5,8,10][i%3]})));
    const items=await fs.readdir(folder);
    assert.deepEqual(items.sort(),['settings.json']);
    const raw=JSON.parse(await fs.readFile(path.join(folder,'settings.json'),'utf8'));
    assert.ok([5,8,10].includes(raw.count));
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('corrupt settings are reported and never silently overwritten with defaults',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-prefs-'));
  try{
    const filename=path.join(folder,'settings.json');
    await fs.writeFile(filename,'{not valid json','utf8');
    const prefs=createSettingsStore({userData:folder,secureStorage:storage});
    await assert.rejects(prefs.read(),/Не удалось прочитать settings.json/);
    await assert.rejects(prefs.save({count:5}),/Не удалось прочитать settings.json/);
    assert.equal(await fs.readFile(filename,'utf8'),'{not valid json');
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});

test('default candidate profile and empty vacancy appear in existing settings',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-profile-'));
  try{
    const pref=createSettingsStore({userData:folder,secureStorage:storage});
    const original=await pref.read();
    assert.match(original.candidateProfile,/Егор Фенин/);
    assert.equal(original.targetVacancy,'');
    await pref.save({count:10});
    const after=createSettingsStore({userData:folder,secureStorage:storage});
    assert.equal((await after.read()).candidateProfile,original.candidateProfile);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('edited or intentionally cleared context is retained on restart',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-profile-'));
  try{
    const pref=createSettingsStore({userData:folder,secureStorage:storage});
    await pref.save({candidateProfile:'Проект — FastAPI',targetVacancy:'Python Backend'});
    const after=createSettingsStore({userData:folder,secureStorage:storage});
    assert.equal((await after.read()).targetVacancy,'Python Backend');
    assert.equal((await after.read()).candidateProfile,'Проект — FastAPI');
    await pref.save({candidateProfile:'',targetVacancy:''});
    const cleared=await after.read();
    assert.equal(cleared.candidateProfile,'');
    assert.equal(cleared.targetVacancy,'');
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('too-long context is rejected without overwriting previous text',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'mock-profile-'));
  try{
    const pref=createSettingsStore({userData:folder,secureStorage:storage});
    await pref.save({candidateProfile:'old'});
    await assert.rejects(pref.save({candidateProfile:'x'.repeat(10001)}),/максимум/);
    assert.equal((await pref.read()).candidateProfile,'old');
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
