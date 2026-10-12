'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {questionCount: normalizeCount} = require('./logic');

function createSettingsStore({userData, secureStorage}) {
  const filename=path.join(userData,'settings.json');
  const defaults=()=>({rememberKey:true,count:8,key:''});

  async function read() {
    try {
      const raw=JSON.parse(await fs.readFile(filename,'utf8'));
      let key='';
      if(raw.secret && secureStorage.isEncryptionAvailable()){
        try{key=secureStorage.decryptString(Buffer.from(raw.secret,'base64'));}catch{key='';}
      }
      return {rememberKey:raw.rememberKey!==false,count:normalizeCount(raw.count),key};
    }catch{return defaults();}
  }

  async function save({rememberKey,count,key}={}) {
    const current=await read();
    const remember=rememberKey === undefined ? current.rememberKey : Boolean(rememberKey);
    const n=count===undefined?current.count:normalizeCount(count);
    const finalKey=key === undefined ? current.key : String(key ?? '');
    let secret=null;
    if(remember && finalKey){
      if(!secureStorage.isEncryptionAvailable()){
        throw new Error('Безопасное хранилище Windows недоступно. Ключ не сохранён.');
      }
      secret=secureStorage.encryptString(finalKey).toString('base64');
    }
    await fs.mkdir(userData,{recursive:true});
    await fs.writeFile(filename,JSON.stringify({rememberKey:remember,count:n,secret}),{mode:0o600});
    return {rememberKey:remember,count:n,hasKey:Boolean(secret)};
  }

  return {read,save};
}
module.exports={createSettingsStore};
