import Dexie from 'dexie';
import { db, legacyExecutorDatabaseName } from '../store/db';
import { cloud } from './state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { encodeRecoveryValue } from './recovery-export';

/** Retirement-only reader. Never upgrades, drains, archives or writes the old
 * database. Retire after owners export/reconcile all legacy drafts and Blobs. */
async function readLegacy<T>(owner:string, read:(database:Dexie)=>Promise<T>):Promise<T> {
  const scope=db;
  const name = legacyExecutorDatabaseName(owner);
  if (!owner || owner !== cloud.userId || !await Dexie.exists(name)) throw new Error('executor_recovery_not_found');
  const database = new Dexie(name);
  try {
    await database.open();
    const value=await database.transaction('r',database.tables,()=>read(database));
    if(owner!==cloud.userId||scope!==db)throw new Error('client_account_changed');
    return value;
  } finally { database.close(); }
}
export async function listExecutorRecovery(owner: string): Promise<{id:string}[]> {
  if(!owner||owner!==cloud.userId||!await Dexie.exists(legacyExecutorDatabaseName(owner)))return [];
  return readLegacy(owner,async database=>{
    // Key cursors and counts never materialize drafts, checkpoints or Blobs.
    const rows=(await database.table('_cloudMeta').toCollection().primaryKeys()).filter(id=>/^(executor-|resource-command:)/.test(String(id))).map(id=>({id:String(id)}));
    if(await database.table('_cloudOutbox').count())rows.push({id:'executor-legacy-outbox'});
    for(const table of database.tables)if(!['_cloudMeta','_cloudOutbox'].includes(table.name)&&await table.count()){rows.push({id:'executor-legacy-snapshot'});break;}
    return rows;
  });
}
const inspections=new WeakMap<object,{owner:string;current:()=>boolean}>();
export async function inspectExecutorRecovery(id: string) {
  const owner=cloud.userId,scope=db,runtime=await serverRuntime(owner);
  const current=()=>owner===cloud.userId&&scope===db&&isCurrentServerRuntime(runtime);
  const row=await readLegacy(owner,async database=>{
    if(id==='executor-legacy-outbox')return {id,count:await database.table('_cloudOutbox').count()};
    if(id==='executor-legacy-snapshot')return {id,tables:Object.fromEntries(await Promise.all(database.tables.filter(t=>!['_cloudMeta','_cloudOutbox'].includes(t.name)).map(async t=>[t.name,await t.count()])))};
    return /^(executor-|resource-command:)/.test(id)?database.table('_cloudMeta').get(id):undefined;
  });
  if (!row) throw new Error('executor_recovery_not_found');
  const operationId = row.value?.operationId ?? row.value?.request?.operationId;
  const [receipt, projection] = await Promise.all([
    typeof operationId === 'string' ? runtime.receipt(operationId) : Promise.resolve(null),
    runtime.read({ kind: 'executorRecovery', ...(row.value?.taskId ? { taskId: row.value.taskId } : {}), operationIds: (row.rows ?? []).map((edit: any) => edit.id) }),
  ]);
  if (!current()) throw new Error('client_account_changed');
  const detail={row,receipt,server:projection.value,observed:null};
  inspections.set(detail,{owner,current});return detail;
}
export async function exportExecutorRecovery(detail: Awaited<ReturnType<typeof inspectExecutorRecovery>>) {
  const scope=inspections.get(detail);
  if(!scope?.current())throw new Error('client_account_changed');
  const row=await readLegacy(scope.owner,async database=>{
    if(detail.row.id==='executor-legacy-outbox')return {id:detail.row.id,rows:await database.table('_cloudOutbox').toArray()};
    if(detail.row.id==='executor-legacy-snapshot') {
      const value:Record<string,unknown[]>={};
      for(const table of database.tables)if(!['_cloudMeta','_cloudOutbox'].includes(table.name))value[table.name]=await table.toArray();
      return {id:detail.row.id,value};
    }
    return database.table('_cloudMeta').get(detail.row.id);
  });
  const value=await encodeRecoveryValue({...detail,row});
  if(!scope.current())throw new Error('client_account_changed');
  return value;
}
