/** Real typed resource command + isolated SQLite. Not browser/production startup evidence. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fixtureDomain } from './fixture-domain.mjs';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/subtitle-import-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { recordParentSql } = await import('../apps/api/src/realtime/record-projections.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
let store;
const evidence = { checks: [] };
try {
  await app.ready();
  const initialized = await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'subtitle-import-password-123' } });
  assert.equal(initialized.statusCode, 201, initialized.body);
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'subtitle-import-password-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id, other = 'foreign-owner';
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, other, new Date().toISOString());
  const records = new CloudRecords(store);
  const insert = store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)');
  const put = (table, key, value, who = owner) => insert.run(who, table, JSON.stringify(key), value === null ? null : JSON.stringify(value));
  put('videos', 'course', { id: 'course', status: 'new' });
  const segment = (id, videoId = 'course') => ({ id, videoId, idx: id, start: id, end: id + 1, text: `segment-${id}`, status: 1 });
  const track = (id, videoId = 'course') => ({ id, videoId, lang: `lang-${id}`, lanDoc: `Language ${id}`, cues: [{ start: 0, end: 1, text: 'Track' }] });
  store.transaction(() => {
    for (let id = 1; id <= 10000; id++) {
      put('segments', 100000 + id, { ...segment(100000 + id, 'unrelated'), text: 'UNRELATED_SUBTITLE_BODY'.repeat(50) });
      put('subtitleTracks', 100000 + id, { ...track(100000 + id, 'unrelated'), privateBody: 'UNRELATED_SUBTITLE_BODY'.repeat(50) });
    }
    for (let id = 1; id <= 401; id++) put('segments', id, segment(id));
    put('subtitleTracks', 1, track(1));
    put('segments', 900001, segment(900001), other);
    put('subtitleTracks', 900001, track(900001), other);
  });
  const snapshot = () => store.db.prepare(`SELECT table_name,record_key,value,revision FROM cloud_records
    WHERE owner_id=? AND (table_name='videos' OR table_name IN ('segments','subtitleTracks') AND (${recordParentSql})=?) ORDER BY table_name,record_key`).all(owner, 'course');
  const receipt = id => store.db.prepare('SELECT * FROM client_commands WHERE owner_id=? AND operation_id=?').get(owner, id);
  const operation = { kind: 'importSubtitles', courseId: 'course', primary: true,
    segments: Array.from({ length: 451 }, (_, idx) => ({ idx, start: idx, end: idx + 1, text: `new-${idx}`, status: 1 })),
    tracks: [{ lang: 'zh', lanDoc: '中文', primary: 1, cues: [{ start: 0, end: 1, text: 'New track' }] }] };
  const command = { operationId: crypto.randomUUID(), operation };
  const originalParse = JSON.parse, originalApply = CloudRecords.prototype.apply;
  let peakBatch = 0;
  JSON.parse = function(text, ...args) { assert.ok(!String(text).includes('UNRELATED_SUBTITLE_BODY'), 'unrelated subtitle bodies must never be parsed'); return originalParse(text, ...args); };
  CloudRecords.prototype.apply = function(who, mutations, ...args) { peakBatch = Math.max(peakBatch, mutations.length); assert.ok(mutations.length <= 200); return originalApply.call(this, who, mutations, ...args); };
  let result;
  try { result = await fixtureDomain(app, cookie, 'resourceCommand', command); }
  finally { JSON.parse = originalParse; CloudRecords.prototype.apply = originalApply; }
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(peakBatch > 0 && peakBatch <= 200);
  const after = snapshot();
  assert.equal(after.filter(row => row.table_name === 'segments' && row.value !== null).length, 451);
  assert.equal(after.filter(row => row.table_name === 'subtitleTracks' && row.value !== null).length, 1);
  assert.equal(records.get(owner, 'segments', 1), null);
  assert.equal(records.get(other, 'segments', 900001).text, 'segment-900001');
  assert.equal(records.get(owner, 'videos', 'course').status, 'transcribed');
  assert.equal(receipt(command.operationId).status, 'completed');
  assert.equal((await fixtureDomain(app, cookie, 'resourceCommand', command)).ok, true);
  assert.deepEqual(snapshot(), after, 'same operation receipt must not replace subtitles twice');
  const reused = await fixtureDomain(app, cookie, 'resourceCommand', { ...command, operation: { ...operation, primary: false } });
  assert.equal(reused.ok, false); assert.equal(reused.error.code, 'client/conflict');
  evidence.checks.push('20k unrelated subtitle rows never parsed; 401 old/451 new segments use <=200-mutation batches, owner isolation, atomic status/receipt and stable-ID idempotency');

  // Fail after segment replacement, before the final track/course/receipt writes.
  const failedId = crypto.randomUUID();
  CloudRecords.prototype.apply = function(who, mutations, ...args) {
    if (mutations.some(row => row.table === 'subtitleTracks' && row.after !== null)) throw new Error('injected_subtitle_track_failure');
    return originalApply.call(this, who, mutations, ...args);
  };
  try { assert.equal((await fixtureDomain(app, cookie, 'resourceCommand', { operationId: failedId, operation })).ok, false); }
  finally { CloudRecords.prototype.apply = originalApply; }
  assert.deepEqual(snapshot(), after, 'a later batch failure must roll back every prior deletion/insertion');
  assert.equal(receipt(failedId), undefined, 'failed attempt must not publish a successful receipt');
  assert.equal((await fixtureDomain(app, cookie, 'resourceCommand', { operationId: failedId, operation })).ok, true, 'SQL rollback permits same-ID repaired retry');
  evidence.checks.push('injected late-track failure rolls back all batches, course state and receipt; original identity can retry after repair');

  const budgetId = crypto.randomUUID();
  put('subtitleTracks', 999999, { ...track(999999), privateBody: 'x'.repeat(16 * 1024 * 1024) });
  const oversized = snapshot();
  const budget = await fixtureDomain(app, cookie, 'resourceCommand', { operationId: budgetId, operation });
  assert.equal(budget.ok, false); assert.equal(budget.error.code, 'client/domain'); assert.equal(budget.error.details.code, 'subtitle_import_budget_exceeded');
  assert.deepEqual(snapshot(), oversized, 'preflight failure must not delete either collection');
  assert.equal(receipt(budgetId), undefined);
  store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='subtitleTracks' AND record_key=?").run(owner, JSON.stringify(999999));
  assert.equal((await fixtureDomain(app, cookie, 'resourceCommand', { operationId: budgetId, operation })).ok, true);
  evidence.checks.push('old complete-snapshot byte budget is checked before any delete, explicit typed failure and same-ID repaired retry');
  evidence.plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT record_key FROM cloud_records INDEXED BY cloud_records_parent_key
    WHERE owner_id=? AND table_name=? AND (${recordParentSql})=? AND value IS NOT NULL ORDER BY record_key LIMIT 20101`).all(owner, 'segments', 'course');
  assert.ok(evidence.plan.some(row => /SEARCH.*cloud_records_parent_key/.test(row.detail)));
  assert.ok(evidence.plan.every(row => !/TEMP|SCAN/.test(row.detail)));
  evidence.peakBatch = peakBatch; evidence.passed = true;
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS subtitle import scope: ${directory}`, evidence.checks);
} finally { store?.close(); await app.close(); }
