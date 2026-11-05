import assert from 'node:assert/strict';
export async function verifyExecutorRecovery(page,owner) {
  const result=await page.evaluate(async owner=>{
    const store=await import('/src/store/db.ts'),{cloud}=await import('/src/cloud/state.ts'),recovery=await import('/src/cloud/executor-recovery.ts'),bootstrap=await import('/src/client/bootstrap.ts');
    const other='recovery-other-account',size=8*1024*1024+17,bytes=new Uint8Array(size);for(let i=0;i<size;i++)bytes[i]=i%251;
    const seed=account=>new Promise((resolve,reject)=>{
      const request=indexedDB.open(store.legacyExecutorDatabaseName(account),1);
      request.onupgradeneeded=()=>{for(const table of ['_cloudMeta','_cloudOutbox','frames'])request.result.createObjectStore(table,{keyPath:'id'});};
      request.onerror=()=>reject(request.error);request.onsuccess=()=>{
        const db=request.result,tx=db.transaction(['_cloudMeta','_cloudOutbox','frames'],'readwrite');
        tx.objectStore('_cloudMeta').put({id:`executor-${account}`,value:{note:account}});tx.objectStore('_cloudOutbox').put({id:account,draft:new Blob([bytes])});tx.objectStore('frames').put({id:1,blob:new Blob([bytes],{type:'image/jpeg'})});tx.oncomplete=()=>{db.close();resolve();};tx.onerror=()=>reject(tx.error);
      };
    });
    await seed(owner);await seed(other);
    const check=(value,message)=>{if(!value)throw new Error(message);};
    const transaction=IDBDatabase.prototype.transaction,all=IDBObjectStore.prototype.getAll;let writes=0,fullReads=0;
    IDBDatabase.prototype.transaction=function(names,mode,...rest){if(this.name.startsWith('wangke-cloud-executor-')&&mode==='readwrite')writes++;return transaction.call(this,names,mode,...rest);};
    IDBObjectStore.prototype.getAll=function(...args){if(this.transaction.db.name.startsWith('wangke-cloud-executor-'))fullReads++;return all.apply(this,args);};
    try {
      cloud.userId=owner;
      const list=await recovery.listExecutorRecovery(owner);check(list.filter(row=>row.id.startsWith('executor-')).length===3,'metadata list');check(fullReads===0,'list must not materialize any legacy values');
      const detail=await recovery.inspectExecutorRecovery('executor-legacy-snapshot');check(fullReads===0,'snapshot inspection must only count');
      const metadata=await recovery.inspectExecutorRecovery(`executor-${owner}`);
      await recovery.markExecutorRecoveryHandled(metadata);
      check((await recovery.listExecutorRecovery(owner)).find(row=>row.id===`executor-${owner}`).handled,'handled marker is separate and visible');
      // This is an explicit old-writer fault injection, not a recovery write.
      // Keep the original method so the reader's zero-write counter stays scoped.
      await new Promise((resolve,reject)=>{const request=indexedDB.open(store.legacyExecutorDatabaseName(owner));request.onerror=()=>reject(request.error);request.onsuccess=()=>{const source=request.result,tx=transaction.call(source,['_cloudMeta'],'readwrite');tx.objectStore('_cloudMeta').put({id:`executor-${owner}`,value:{operationId:'new-legacy-evidence',state:'uncertain'}});tx.oncomplete=()=>{source.close();resolve();};tx.onerror=()=>reject(tx.error);};});
      const changed=(await recovery.listExecutorRecovery(owner)).find(row=>row.id===`executor-${owner}`);
      check(changed.pending&&!changed.handled,'same-key new command evidence must reappear');
      const output=await recovery.exportExecutorRecovery(detail),blob=output.row.value.frames[0].blob;
      check(blob.size===size,'large Blob size');const decoded=atob(blob.$blob);check(decoded.length===size,'large Blob export bytes');for(let i=0;i<size;i++)if(decoded.charCodeAt(i)!==bytes[i])throw new Error('large Blob byte mismatch');
      const late=recovery.listExecutorRecovery(owner);cloud.userId=other;store.useCloudDatabase(other);bootstrap.disposeServerRuntime();
      await late.then(()=>{throw new Error('late old list accepted');},()=>{});
      check((await recovery.listExecutorRecovery(other)).some(r=>r.id===`executor-${other}`),'other account list');check((await recovery.listExecutorRecovery(owner)).length===0,'cross account list');
      await recovery.exportExecutorRecovery(detail).then(()=>{throw new Error('stale export accepted');},()=>{});
      cloud.userId=owner;store.useCloudDatabase(owner);await recovery.exportExecutorRecovery(detail).then(()=>{throw new Error('A-B-A stale generation accepted');},()=>{});
      const outboxDetail=await recovery.inspectExecutorRecovery('executor-legacy-outbox');
      await recovery.markExecutorRecoveryHandled(outboxDetail).then(()=>{throw new Error('keys-only outbox reminder incorrectly dismissible');},()=>{});
      const outbox=await recovery.exportExecutorRecovery(outboxDetail);check(outbox.row.rows[0].draft.size===size,'outbox draft preserved');
      check((await recovery.listExecutorRecovery(owner)).find(row=>row.id==='executor-legacy-outbox').handled===false,'unverified outbox cannot hide changed payload bytes');
      await new Promise((resolve,reject)=>{const request=indexedDB.open(store.legacyExecutorDatabaseName(owner));request.onerror=()=>reject(request.error);request.onsuccess=()=>{const source=request.result,tx=transaction.call(source,['_cloudMeta'],'readwrite');tx.objectStore('_cloudMeta').put({id:`executor-${owner}`,value:{operationId:'new-legacy-evidence',state:'confirmed',receipt:{status:'completed'},draft:new Blob(['changed attachment'])}});tx.oncomplete=()=>{source.close();resolve();};tx.onerror=()=>reject(tx.error);};});
      const attached=(await recovery.listExecutorRecovery(owner)).find(row=>row.id===`executor-${owner}`);
      check(attached.pending&&attached.dismissible===false,'old completed metadata cannot confirm unverified attachment bytes');
      await store.db.table('_historyRecovery').put({id:`receipt:${attached.id}:${attached.fingerprint}`,receipt:{status:'completed'}});
      check((await recovery.listExecutorRecovery(owner)).find(row=>row.id===attached.id).pending,'identity-only remote receipt cannot hide unverified attachment bytes');
      check(writes===0,'recovery wrote legacy data');return {size,writes,listFullReads:0};
    }finally{IDBDatabase.prototype.transaction=transaction;IDBObjectStore.prototype.getAll=all;}
  },owner);
  assert.equal(result.writes,0);return result;
}
