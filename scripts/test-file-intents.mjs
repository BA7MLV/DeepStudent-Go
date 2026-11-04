import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { SystemFiles } from '../apps/api/src/storage/system-files.ts';
import { migrateFileIntents } from '../apps/api/src/storage/file-intents.ts';

const root = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/file-intents-');
let db = new Database(path.join(root, 'db.sqlite'));
db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('owner');
  CREATE TABLE system_file_entries(owner_id TEXT,path TEXT,memory_id TEXT,pending INTEGER DEFAULT 0,content TEXT,expected TEXT,PRIMARY KEY(owner_id,path));`);
migrateFileIntents(db);
let files = new SystemFiles(path.join(root, 'files'), db);
const resource = '/system/AGENTS.md';
files.write('owner', resource, 'baseline');
const filename = fs.readdirSync(path.join(root, 'files')).map(account => path.join(root, 'files', account, 'system/AGENTS.md'))[0];
const baseline = files.entry('owner', resource).intent_id;
assert.equal(files.receipt('owner', baseline).status, 'applied');
assert.equal(files.receipt('other', baseline), undefined);
assert.throws(() => db.transaction(() => { files.write('owner', resource, 'rolled-back'); throw new Error('rollback'); })(), /rollback/);
assert.equal(files.read('owner', resource), 'baseline');
assert.equal(db.prepare('SELECT COUNT(*) n FROM system_file_intents').get().n, 1);

db.transaction(() => { files.write('owner', resource, 'draft', 'baseline'); })();
const draft = files.entry('owner', resource).intent_id;
fs.writeFileSync(filename, 'external edit');
assert.throws(() => files.flush(), /system_file_changed/);
assert.equal(files.receipt('owner', draft).status, 'conflict');
assert.equal(files.receipt('owner', draft).content, 'draft');
assert.equal(files.receipt('owner', draft).expected, 'baseline');
assert.equal(files.receipt('owner', draft).observed, 'external edit');
assert.equal(files.read('owner', resource), 'external edit');
assert.throws(() => files.write('owner', resource, 'overwrite'), /system_file_intent_conflict/);
db.close(); db = new Database(path.join(root, 'db.sqlite')); migrateFileIntents(db);
files = new SystemFiles(path.join(root, 'files'), db);
files.flush();
assert.equal(files.read('owner', resource), 'external edit', 'restart never replays conflicts');
assert.equal(files.conflicts('owner').length, 1);
assert.equal(files.conflicts('other').length, 0);
assert.throws(() => files.resolve('other', draft, 'external edit', 'retry'), /system_file_intent_not_conflicted/);
assert.throws(() => files.resolve('owner', draft, 'stale observed', 'retry'), /system_revision_conflict/);
const recovered = files.resolve('owner', draft, 'external edit', 'retry');
assert.equal(recovered.status, 'applied');
assert.equal(files.read('owner', resource), 'draft');
assert.equal(files.receipt('owner', draft).status, 'superseded');
assert.equal(files.resolve('owner', draft, 'external edit', 'retry').id, recovered.id, 'lost recovery response returns the same final receipt');
assert.throws(() => files.resolve('owner', draft, 'different content', 'retry'), /system_file_resolution_conflict/);

db.transaction(() => { files.write('owner', resource, 'after rename'); })();
const renamed = files.entry('owner', resource).intent_id;
fs.writeFileSync(filename, 'after rename'); // crash after rename, before SQL receipt
files.flush(); files.flush();
assert.equal(files.receipt('owner', renamed).status, 'applied');
assert.equal(db.prepare('SELECT COUNT(*) n FROM system_file_intents WHERE id=?').get(renamed).n, 1);

db.transaction(() => { files.write('owner', resource, null); })();
const deletion = files.entry('owner', resource).intent_id;
fs.unlinkSync(filename); // crash after unlink
files.flush();
assert.equal(files.receipt('owner', deletion).status, 'applied');
assert.equal(files.read('owner', resource), undefined);

files.write('owner', resource, 'before directory fsync');
db.transaction(() => files.write('owner', resource, 'committed rename'))();
const interrupted = files.entry('owner', resource).intent_id;
const fsync = fs.fsyncSync;
try {
  fs.fsyncSync = fd => { if (fs.fstatSync(fd).isDirectory()) throw new Error('injected_directory_fsync'); return fsync(fd); };
  assert.throws(() => files.flush(), /injected_directory_fsync/);
} finally { fs.fsyncSync = fsync; }
assert.equal(files.receipt('owner', interrupted).status, 'pending');
assert.equal(fs.readFileSync(filename, 'utf8'), 'committed rename');
assert.equal(files.reconcile('other', interrupted), undefined, 'foreign receipt queries cannot finish another account intent');
assert.equal(files.receipt('owner', interrupted).status, 'pending');
assert.equal(files.reconcile('owner', interrupted).status, 'applied', 'query recovers durable rename without resubmitting a command');

db.transaction(() => files.write('owner', resource, 'discarded draft'))();
const discarded = files.entry('owner', resource).intent_id;
fs.writeFileSync(filename, 'keep external edit');
assert.throws(() => files.flush(), /system_file_changed/);
assert.equal(files.resolve('owner', discarded, 'keep external edit', 'discard').status, 'discarded');
assert.equal(files.resolve('owner', discarded, 'keep external edit', 'discard').status, 'discarded');
assert.equal(files.read('owner', resource), 'keep external edit');
assert.equal(files.receipt('owner', discarded).content, 'discarded draft', 'explicit discard still retains recoverable original bytes');
db.prepare("INSERT INTO users VALUES('isolated')").run();
db.transaction(() => files.write('owner', resource, 'another retained draft'))();
const unrelated = files.entry('owner', resource).intent_id;
fs.writeFileSync(filename, 'unrelated external change');
files.write('isolated', resource, 'isolated account save');
assert.equal(files.read('isolated', resource), 'isolated account save', 'one account save does not flush another account pending effect');
assert.equal(files.receipt('owner', unrelated).status, 'pending');
assert.throws(() => files.flush({ owner: 'owner', intentId: unrelated }), /system_file_changed/);
db.close();

const legacy = new Database(':memory:');
legacy.exec(`CREATE TABLE users(id TEXT PRIMARY KEY); INSERT INTO users VALUES('legacy');
  CREATE TABLE system_file_entries(owner_id TEXT,path TEXT,memory_id TEXT,pending INTEGER DEFAULT 0,content TEXT,expected TEXT,PRIMARY KEY(owner_id,path));`);
const legacyBytes = '原始待写入\r\n\u0000尾部', expectedBytes = '原始期待\r\n';
legacy.prepare('INSERT INTO system_file_entries VALUES(?,?,NULL,1,?,?)').run('legacy', resource, legacyBytes, expectedBytes);
migrateFileIntents(legacy);
const converted = legacy.prepare('SELECT * FROM system_file_intents').get();
assert.equal(converted.content, legacyBytes);
assert.equal(converted.expected, expectedBytes);
assert.equal(converted.status, 'pending');
assert.equal(legacy.prepare('SELECT intent_id FROM system_file_entries').get().intent_id, converted.id);
migrateFileIntents(legacy);
assert.equal(legacy.prepare('SELECT COUNT(*) n FROM system_file_intents').get().n, 1, 'legacy conversion is idempotent');
legacy.close();
console.log(`PASS file intent rollback/conflict retention/restart isolation/explicit CAS recovery/rename and unlink replay. Evidence: ${root}`);
