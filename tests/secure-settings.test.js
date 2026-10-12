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
