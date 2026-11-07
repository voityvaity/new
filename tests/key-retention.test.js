'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {createKeyRetentionPolicy}=require('../src/key-retention');
const {createSettingsStore}=require('../src/secure-settings');

const storage={
  isEncryptionAvailable:()=>true,
  encryptString:s=>Buffer.from(s),
  decryptString:b=>b.toString()
};
test('clearing saved API key outranks a late Live create response',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'key-race-'));
  try{
    const prefs=createSettingsStore({userData:folder,secureStorage:storage});
    const policy=createKeyRetentionPolicy();
    const version=policy.snapshot();
    await prefs.save({rememberKey:true,key:'sk-before'});
    policy.changed(); // User clicks Clear while network call is pending.
    await prefs.save({key:''});
    await prefs.save(policy.payload(version,{
      rememberKey:true,count:5,key:'sk-before'
    }));
    const saved=await prefs.read();
    assert.equal(saved.key,'');
    assert.equal(saved.count,5);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('unchanged user consent still saves encrypted key normally',()=>{
  const p=createKeyRetentionPolicy(),version=p.snapshot();
  assert.deepEqual(p.payload(version,{rememberKey:true,count:8,key:'sk-key'}),
    {rememberKey:true,count:8,key:'sk-key'});
  p.changed();
  assert.deepEqual(p.payload(version,{rememberKey:true,count:8,key:'sk-key'}),
    {count:8});
});
