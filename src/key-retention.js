'use strict';
// User preference changes always outrank an asynchronous Live session request.
function createKeyRetentionPolicy() {
  let revision=0;
  return {
    snapshot:()=>revision,
    changed:()=>{revision++;},
    payload:(version,{rememberKey,count,key})=>
      version===revision ? {rememberKey,count,key} : {count}
  };
}
module.exports={createKeyRetentionPolicy};
