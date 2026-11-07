'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {createGradeRecoveryStore}=require('../src/grade-recovery');

test('a paid grade survives an app restart in its independent rescue file',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'grade-recovery-'));
  const id=randomUUID(),grade={score:2,verdict:'Нужно практиковаться',strengths:[],improve:['Python'],next_steps:[]};
  try{
    const store=createGradeRecoveryStore({directory:root});
    assert.equal(await store.get(id),null);
    await store.save(id,grade);
    const fresh=createGradeRecoveryStore({directory:root});
    assert.deepEqual(await fresh.get(id),grade);
    await fresh.remove(id);
    assert.equal(await fresh.get(id),null);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('grade rescue refuses arbitrary filenames and invalid content',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'grade-recovery-'));
  const store=createGradeRecoveryStore({directory:root});
  try{
    await assert.rejects(store.save('../escaped',{score:5}),/идентификатор/);
    await assert.rejects(store.get('../../settings.json'),/идентификатор/);
    await assert.rejects(store.save(randomUUID(),{score:11}),/оценка/);
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
