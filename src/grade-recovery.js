'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {atomicWrite}=require('./interview-archive');

const ID_PATTERN=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function createGradeRecoveryStore({directory}) {
  function filename(id){
    if(typeof id!=='string'||!ID_PATTERN.test(id))
      throw new Error('Некорректный идентификатор интервью.');
    return path.join(directory,id+'.json');
  }
  async function get(id){
    try{
      const data=JSON.parse(await fs.readFile(filename(id),'utf8'));
      if(data.archiveId!==id || !data.grade ||
         !Number.isInteger(data.grade.score)||data.grade.score<1||data.grade.score>10)
        throw new Error('Повреждена резервная оценка.');
      return data.grade;
    }catch(error){
      if(error.code==='ENOENT')return null;
      throw error;
    }
  }
  async function save(id,grade){
    if(!grade || !Number.isInteger(grade.score)||grade.score<1||grade.score>10)
      throw new Error('Некорректная оценка.');
    await atomicWrite(filename(id),JSON.stringify({
      archiveId:id,grade,createdAt:new Date().toISOString()
    }));
  }
  async function remove(id){await fs.rm(filename(id),{force:true});}
  return {get,save,remove};
}
module.exports={createGradeRecoveryStore};
