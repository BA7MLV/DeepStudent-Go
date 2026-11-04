import assert from 'node:assert/strict';
import { SessionCommandQueue } from '../packages/client-core/src/session-queue.ts';

const records = new Map();
let writes = Promise.resolve();
const journal = { atomic(id, change) {
  const work = writes.then(() => {
    const result = change(structuredClone(records.get(id)));
    if (result.record) records.set(id, structuredClone(result.record));
    return result.value;
  });
  writes = work.then(() => {}, () => {});
  return work;
} };
let current = true, receipt = { status: 'missing' }, submits = [];
const port = {
  current: () => current,
  receipt: async () => receipt,
  submit: async (request, operationId) => {
    assert.equal(records.get(operationId).state,'uncertain','durable claim precedes external IO');
    submits.push({request,operationId});
    throw new Error('response_lost');
  },
};
const first = new SessionCommandQueue(journal,port), second = new SessionCommandQueue(journal,port);
const item = { id:'original-op', operationId:'original-op',text:'original',attachments:[{id:'persistent-blob'}],explicitSkillIds:[7] };
await first.execute(12,item,{text:'frozen original'}).catch(() => {});
assert.equal(records.get(item.id).sessionId,12);
assert.deepEqual(records.get(item.id).item.attachments,[{id:'persistent-blob'}]);
await second.execute(12,item,{text:'must not replay'}).catch(() => {});
assert.equal(submits.length,1,'reload/missing admission never auto-replays');
receipt = {status:'pending'};
await second.execute(12,item,{text:'must not replay'},true).catch(() => {});
assert.equal(submits.length,1,'pending receipt is not permission to retry, even explicitly');
receipt = {status:'accepted',task:{id:'task-original'}};
assert.equal((await second.execute(12,item,{text:'must not replay'})).id,'task-original');
assert.equal(records.get(item.id).state,'accepted');
assert.equal(submits.length,1);

receipt = {status:'missing'};
const unknown = {...item,id:'unknown',operationId:'unknown'};
await first.execute(12,unknown,{text:'original unknown'}).catch(() => {});
await Promise.allSettled([first.execute(12,unknown,{text:'edited'},true),second.execute(12,unknown,{text:'other'},true)]);
assert.equal(submits.filter(send => send.operationId === 'unknown').length,2,'one initial attempt and one original explicit retry across competing claimants');
assert.deepEqual(submits.at(-1).request,{text:'original unknown'});

current = false;
await assert.rejects(first.execute(12,{...item,id:'other',operationId:'other'},{}),/client_account_changed/);
assert.equal(records.has('other'),false);
console.log('PASS durable claim/receipt policy: pending and uncertain no replay, accepted recovery, frozen explicit retry, atomic competing claims and account rejection');
