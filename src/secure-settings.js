'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const {questionCount: normalizeCount} = require('./logic');
const {atomicWrite} = require('./interview-archive');

function createSettingsStore({userData, secureStorage, defaultReportDirectory = path.join(userData, 'Интервью')}) {
  const filename=path.join(userData,'settings.json');
  const defaults=()=>({rememberKey:true,count:8,key:'',reportDirectory:defaultReportDirectory,saveJson:true});
  let writes = Promise.resolve();

  async function read() {
    try {
      const raw=JSON.parse(await fs.readFile(filename,'utf8'));
      let key='';
      if(raw.secret && secureStorage.isEncryptionAvailable()){
        try{key=secureStorage.decryptString(Buffer.from(raw.secret,'base64'));}catch{key='';}
      }
      return {
        rememberKey:raw.rememberKey!==false, count:normalizeCount(raw.count), key,
        reportDirectory:typeof raw.reportDirectory==='string' && path.isAbsolute(raw.reportDirectory)
          ? raw.reportDirectory : defaultReportDirectory,
        saveJson:raw.saveJson!==false
      };
    }catch{return defaults();}
  }

  async function writeSettings({rememberKey,count,key,reportDirectory,saveJson}={}) {
    const current=await read();
    const remember=rememberKey === undefined ? current.rememberKey : Boolean(rememberKey);
    const n=count===undefined?current.count:normalizeCount(count);
    const finalKey=key === undefined ? current.key : String(key ?? '');
    const folder=reportDirectory===undefined ? current.reportDirectory : reportDirectory;
    if(typeof folder!=='string'||!path.isAbsolute(folder)) throw new Error('Нужна абсолютная папка для отчётов.');
    const withJson=saveJson===undefined ? current.saveJson : Boolean(saveJson);
    let secret=null;
    if(remember && finalKey){
      if(!secureStorage.isEncryptionAvailable()){
        throw new Error('Безопасное хранилище Windows недоступно. Ключ не сохранён.');
      }
      secret=secureStorage.encryptString(finalKey).toString('base64');
    }
    await atomicWrite(filename,JSON.stringify({
      rememberKey:remember,count:n,secret,reportDirectory:folder,saveJson:withJson
    }));
    return {rememberKey:remember,count:n,hasKey:Boolean(secret),reportDirectory:folder,saveJson:withJson};
  }

  // Serialize settings changes so concurrent toggles cannot overwrite each other.
  function save(changes={}) {
    const next=writes.then(()=>writeSettings(changes));
    writes=next.catch(()=>{});
    return next;
  }
  return {read,save};
}
module.exports={createSettingsStore};
