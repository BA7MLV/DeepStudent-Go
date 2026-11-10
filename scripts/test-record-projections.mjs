/** Isolated projection contract, fault and scale evidence. No real model or IM. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { RecordProjections, recordParentSql, PROJECTION_PAGE_BYTES } from '../apps/api/src/realtime/record-projections.ts';
import { assembleRuntimeDomains } from '../apps/api/src/realtime/runtime-domains.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/record-projections-');
const dbPath = path.join(directory, 'db.sqlite');
let store = new DatabaseStore(dbPath, path.join(directory, 'system'));
const evidence = { environment: { node: process.version, platform: process.platform, arch: process.arch, network: 'none; synchronous SQLite API microbenchmark, not browser' }, checks: [], scale: [] };
const owner = 'fixture-owner', other = 'fixture-other';
const insert = () => store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)');
const put = (table, key, value, who = owner) => insert().run(who, table, JSON.stringify(key), value === null ? null : JSON.stringify(value));
try {
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
  for (const size of [1000, 10000, 100000]) {
    // Independent scoped fixtures of known cardinality; other scopes coexist.
    store.transaction(() => {
      const query = insert();
      for (let id = 1; id <= size; id++) query.run(owner, 'chats', JSON.stringify(size * 10 + id), JSON.stringify({
        id: size * 10 + id, sessionId: size, videoId: `course-${size}`, role: id % 2 ? 'user' : 'assistant', createdAt: id,
        content: 'deterministic scale fixture '.repeat(8),
      }));
    });
    const reads = new RecordProjections(store), samples = [];
    for (let n = 0; n < 21; n++) {
      const start = performance.now();
      const page = reads.page(owner, { kind: 'collectionPage', table: 'chats', parent: size });
      const elapsedMs = performance.now() - start;
      assert.equal(page.records.length, 50);
      assert.ok(page.next);
      assert.ok(Buffer.byteLength(JSON.stringify(page)) < PROJECTION_PAGE_BYTES + 4096);
      if (n) samples.push(elapsedMs); // First sample is explicit warm-up.
    }
    const plan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT table_name,record_key,value,revision FROM cloud_records
      WHERE owner_id=? AND table_name=? AND value IS NOT NULL AND (${recordParentSql})=? ORDER BY record_key LIMIT ?`).all(owner, 'chats', size, 51);
    assert.ok(plan.some(row => row.detail.includes('cloud_records_parent_key')), JSON.stringify(plan));
    assert.ok(!plan.some(row => /SCAN |TEMP B-TREE/.test(row.detail)), JSON.stringify(plan));
    samples.sort((a, b) => a - b);
    evidence.scale.push({ messages: size, samples: samples.length, p50Ms: samples[9], p95Ms: samples[18], peakMs: samples.at(-1),
      returned: 50, queryPlan: plan, bytes: Buffer.byteLength(JSON.stringify(reads.page(owner, { kind: 'collectionPage', table: 'chats', parent: size }))),
      actualScannedRows: null, note: 'Indexed search proven; SQLite VM step/scan counters not exposed by this harness' });
  }
  evidence.checks.push('1k/10k/100k scoped pages: 50 rows, bounded bytes, indexed query without sort/temp scan');
  const reads = new RecordProjections(store);
  const request = { kind: 'collectionPage', table: 'chats', parent: 1000 };
  const first = reads.page(owner, request);
  const second = reads.page(owner, { ...request, cursor: first.next });
  assert.equal(new Set([...first.records, ...second.records].map(row => row.key)).size, 100);
  assert.throws(() => reads.page(other, { ...request, cursor: first.next }), /projection_cursor_scope/);
  assert.throws(() => reads.page(owner, { ...request, parent: 10000, cursor: first.next }), /projection_cursor_scope/);
  assert.throws(() => reads.page(owner, { ...request, table: 'chatSessions', cursor: first.next }), /projection_cursor_scope/);
  assert.throws(() => reads.page(owner, { ...request, cursor: first.next.slice(0, -1) + '!' }), /invalid_projection_cursor/);
  assert.throws(() => reads.page(owner, { kind: 'collectionPage', table: 'chats' }), /projection_parent_required/);
  assert.throws(() => reads.page(owner, { kind: 'collectionPage', table: 'preferences' }), /invalid_projection_table/);
  evidence.checks.push('scope/owner/table-bound signed cursors; tamper rejection; no account-wide message selector');
  put('cards', 1, { id: 1, videoId: 'unrelated', q: 'question', a: 'answer' });
  assert.equal(reads.page(owner, { ...request, cursor: first.next }).records.length, 50);
  put('chats', 999, { id: 999, sessionId: 1000, createdAt: 999, role: 'user', content: 'new concurrent message' });
  assert.throws(() => reads.page(owner, { ...request, cursor: first.next }), /projection_cursor_expired/);
  evidence.checks.push('unrelated domain leaves cursor valid; concurrent scoped append invalidates rather than mixing snapshots');
  const fresh = reads.page(owner, request);
  const domains = assembleRuntimeDomains({ store });
  const metadataRequest = { kind: 'courseMetadata', ids: Array.from({ length: 720 }, (_, i) => `metadata-${i}`), covers: false };
  store.transaction(() => { for (const id of metadataRequest.ids) put('videos', id, { id, name: `Name ${id}`, kind: 'material', unrelatedBody: 'do not disclose'.repeat(300) }); });
  put('covers', 'metadata-0', { videoId: 'metadata-0', source: 'user', blob: { $file: 'immutable-cover', type: 'image/png', unwanted: 'x'.repeat(1024 * 1024) }, unrelatedBody: 'private cover body' });
  const metadata = reads.courseMetadata(owner, metadataRequest);
  assert.equal(metadata.items.length, 720);
  assert.ok(Buffer.byteLength(JSON.stringify(metadata)) < 100 * 1024);
  assert.deepEqual(metadata.items[0], { id: 'metadata-0', course: { name: 'Name metadata-0', kind: 'material' }, cover: null });
  const oneMetadata = { ...metadataRequest, ids: ['metadata-0', 'never-existed', 'metadata-0'], covers: true };
  assert.deepEqual(reads.courseMetadata(owner, oneMetadata).items, [
    { id: 'metadata-0', course: { name: 'Name metadata-0', kind: 'material' }, cover: { source: 'user', blob: { $file: 'immutable-cover', type: 'image/png' } } },
    { id: 'never-existed', course: null, cover: null },
  ]);
  assert.ok(reads.courseMetadata(other, oneMetadata).items.every(item => !item.course && !item.cover));
  put('videos', 'metadata-deleted', null);
  assert.equal(reads.courseMetadata(owner, { ...oneMetadata, ids: ['metadata-deleted'] }).items[0].course, null);
  assert.throws(() => reads.courseMetadata(owner, { ...metadataRequest, ids: [...metadataRequest.ids, 'over-limit'] }), /invalid_course_metadata_scope/);
  for (const ids of [[null], [''], ['x'.repeat(257)]]) assert.throws(() => reads.courseMetadata(owner, { ...metadataRequest, ids }), /invalid_course_metadata_scope/);
  put('videos', 'metadata-huge', { id: 'metadata-huge', name: 'x'.repeat(PROJECTION_PAGE_BYTES) });
  assert.throws(() => reads.courseMetadata(owner, { ...metadataRequest, ids: ['metadata-huge'] }), /course_metadata_budget_exceeded/);
  const change = (table, id) => ({ domain: 'cloud_records', entity: `${table}:${JSON.stringify(id)}` });
  assert.equal(domains.matches(metadataRequest, change('videos', 'metadata-0')), true);
  assert.equal(domains.matches(metadataRequest, change('videos', 'unrelated')), false);
  assert.equal(domains.matches(metadataRequest, change('covers', 'metadata-0')), false);
  assert.equal(domains.matches(oneMetadata, change('covers', 'metadata-0')), true);
  assert.equal(domains.matches(oneMetadata, { domain: 'record_collection', entity: JSON.stringify(['videos', '*']) }), false);
  const metadataPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT json_extract(value,'$.name') FROM cloud_records WHERE owner_id=? AND table_name='videos' AND record_key=? AND value IS NOT NULL").all(owner, JSON.stringify('metadata-0'));
  assert.ok(metadataPlan.every(row => !/SCAN |TEMP B-TREE/.test(row.detail)), JSON.stringify(metadataPlan));
  evidence.metadataQueryPlan = metadataPlan;
  evidence.checks.push('explicit course metadata: 720 IDs/512KiB cap, dedup/owner/tombstone, allowlisted names/kinds/optional file refs without large bodies, indexed exact keys and narrow cover invalidation');
  const colorCourse = 'color-course';
  store.transaction(() => {
    for (let id = 0; id < 1000; id++) put('frames', 800000 + id, { id: 800000 + id, videoId: colorCourse, ts: id,
      kind: id === 750 ? 'slide' : 'scene', blob: { $file: `color-file-${id}`, type: 'image/png' }, privateBody: 'UNREQUESTED_FRAME'.repeat(1000) });
  });
  assert.deepEqual(reads.courseColorFrame(owner, colorCourse), { frame: { blob: { $file: 'color-file-750', type: 'image/png' } } });
  assert.deepEqual(reads.courseColorFrame(other, colorCourse), { frame: null });
  store.db.prepare("UPDATE cloud_records SET value=NULL WHERE owner_id=? AND table_name='frames' AND record_key=?").run(owner, JSON.stringify(800750));
  assert.equal(reads.courseColorFrame(owner, colorCourse).frame.blob.$file, 'color-file-0');
  store.db.prepare("UPDATE cloud_records SET value=? WHERE owner_id=? AND table_name='frames' AND record_key=?")
    .run(JSON.stringify({ id: 800000, videoId: colorCourse, ts: 0, blob: { $file: 'x'.repeat(PROJECTION_PAGE_BYTES), type: 'image/png' } }), owner, JSON.stringify(800000));
  assert.throws(() => reads.courseColorFrame(owner, colorCourse), /course_color_budget_exceeded/);
  const colorRequest = { kind: 'courseColorFrame', videoId: colorCourse };
  assert.equal(domains.matches(colorRequest, { domain: 'record_collection', entity: JSON.stringify(['frames', `parent:${JSON.stringify(colorCourse)}`]) }), true);
  assert.equal(domains.matches(colorRequest, { domain: 'record_collection', entity: JSON.stringify(['frames', 'parent:"other"']) }), false);
  evidence.colorQueryPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT record_key FROM cloud_records INDEXED BY cloud_records_color_frame
    WHERE owner_id=? AND table_name='frames' AND value IS NOT NULL AND json_extract(value,'$.videoId')=?
    ORDER BY CASE WHEN json_extract(value,'$.kind')='slide' THEN 0 ELSE 1 END,json_extract(value,'$.ts'),record_key LIMIT 1`).all(owner, colorCourse);
  assert.ok(evidence.colorQueryPlan.every(row => !/SCAN |TEMP B-TREE/.test(row.detail)), JSON.stringify(evidence.colorQueryPlan));
  evidence.checks.push('dynamic colour selects one indexed slide-first/earliest frame from 1k bodies, returns only bounded file metadata; owner/tombstone/fallback/budget and scope invalidation covered');
  const readinessRequest = { kind: 'courseReadiness', videoId: 'readiness-course' };
  assert.equal(domains.matches(readinessRequest, { domain: 'record_collection', entity: JSON.stringify(['segments', 'parent:"readiness-course"']) }), true);
  assert.equal(domains.matches(readinessRequest, { domain: 'record_collection', entity: JSON.stringify(['materialBlocks', 'parent:"readiness-course"']) }), true);
  assert.equal(domains.matches(readinessRequest, { domain: 'record_collection', entity: JSON.stringify(['segments', 'parent:"other-course"']) }), false);
  put('segments', 700001, { id: 700001, videoId: 'readiness-course', status: 1, text: 'ready' });
  assert.deepEqual(reads.courseReadiness(owner, 'readiness-course'), { hasMaterialText: false, hasSubtitles: true });
  assert.deepEqual(reads.courseReadiness(other, 'readiness-course'), { hasMaterialText: false, hasSubtitles: false });
  const readinessPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT 1 FROM cloud_records
    WHERE owner_id=? AND table_name='segments' AND json_extract(value,'$.videoId')=?
      AND json_extract(value,'$.status')=1 AND length(json_extract(value,'$.text'))>0 LIMIT 1`).all(owner, 'readiness-course');
  assert.ok(readinessPlan.some(row => row.detail.includes('cloud_records_ready_segments')), JSON.stringify(readinessPlan));
  assert.ok(!readinessPlan.some(row => /SCAN |TEMP B-TREE/.test(row.detail)), JSON.stringify(readinessPlan));
  evidence.readinessQueryPlan = readinessPlan;
  evidence.checks.push('course readiness returns only booleans, isolates owner/scope, uses partial ready-segment index and exact collection invalidation');
  // Bounded cover backfill: keys only, forward keyset, facts decide eligibility.
  store.transaction(() => {
    for (let id = 0; id < 200; id++) put('videos', `bf-${String(id).padStart(3, '0')}`, { id: `bf-${String(id).padStart(3, '0')}`, name: `Backfill ${id}` });
    put('videos', 'bf-200', { id: 'bf-200', name: 'Skipped', coverState: 'skipped' });
    put('videos', 'bf-201', { id: 'bf-201', name: 'Done pdf', coverState: 'done', materialFormat: 'pdf' });
    put('videos', 'bf-202', { id: 'bf-202', name: 'Done markdown', coverState: 'done', materialFormat: 'md' });
    put('videos', 'bf-203', { id: 'bf-203', name: 'Retry failed', coverState: 'failed' });
    put('videos', 'bf-204', { id: 'bf-204', name: 'Has cover' });
    put('videos', 'bf-205', null);
    put('covers', 'bf-204', { videoId: 'bf-204', source: 'user', blob: { $file: 'existing-cover' } });
    put('videos', 'bf-206', { id: 'bf-206', name: 'Other owner' }, other);
  });
  const collect = () => {
    const ids = []; let cursor, pages = 0, first, previous = '';
    for (;;) {
      const page = reads.coverCandidates(owner, { kind: 'coverCandidates', ...(cursor ? { cursor } : {}) });
      first ??= page;
      assert.ok(page.ids.length <= 100);
      assert.equal(JSON.stringify(page), JSON.stringify({ ids: page.ids, version: page.version, epoch: page.epoch, ...(page.next ? { next: page.next } : {}) }), 'only keys and scope identity are returned');
      for (const id of page.ids) assert.ok(id > previous, 'keyset pages move strictly forward');
      previous = page.ids.at(-1) ?? previous;
      ids.push(...page.ids); pages++;
      if (!page.next) break;
      cursor = page.next;
      assert.ok(pages < 100, 'cover backfill pagination must terminate');
    }
    return { ids, pages, first };
  };
  const backfill = collect();
  assert.equal(new Set(backfill.ids).size, backfill.ids.length);
  const own = backfill.ids.filter(id => id.startsWith('bf-'));
  assert.deepEqual(own.filter(id => ['bf-200', 'bf-201', 'bf-204', 'bf-205', 'bf-206'].includes(id)), []);
  assert.deepEqual(own.filter(id => ['bf-202', 'bf-203'].includes(id)).sort(), ['bf-202', 'bf-203']);
  assert.equal(own.length, 202);
  assert.equal(backfill.pages, Math.ceil(backfill.ids.length / 100));
  assert.deepEqual(reads.coverCandidates(other, { kind: 'coverCandidates' }).ids, ['bf-206']);
  assert.throws(() => reads.coverCandidates(owner, { kind: 'coverCandidates', cursor: backfill.first.next.slice(0, -2) + 'x' }), /invalid_projection_cursor/);
  put('videos', 'bf-207', { id: 'bf-207', name: 'Concurrent addition' });
  assert.throws(() => reads.coverCandidates(owner, { kind: 'coverCandidates', cursor: backfill.first.next }), /projection_cursor_expired/);
  const backfillPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT v.record_key FROM cloud_records AS v INDEXED BY sqlite_autoindex_cloud_records_1
    WHERE v.owner_id=? AND v.table_name='videos' AND v.value IS NOT NULL AND v.record_key>?
    AND NOT EXISTS (SELECT 1 FROM cloud_records AS c
      WHERE c.owner_id=v.owner_id AND c.table_name='covers' AND c.record_key=v.record_key AND c.value IS NOT NULL)
    AND (json_extract(v.value,'$.coverState') IS NULL
      OR json_extract(v.value,'$.coverState') NOT IN ('skipped','done')
      OR (json_extract(v.value,'$.coverState')='done' AND json_extract(v.value,'$.materialFormat')='md'))
    ORDER BY v.record_key LIMIT 101`).all(owner, '');
  assert.ok(backfillPlan.some(row => row.detail.includes('sqlite_autoindex_cloud_records_1')));
  assert.equal(backfillPlan.some(row => row.detail.includes('TEMP B-TREE')), false);
  evidence.backfillPlan = backfillPlan;
  evidence.checks.push('cover backfill returns 100-key forward pages only: existing covers/skipped/done-pdf/tombstone/other-owner excluded, done-markdown/failed included, signed cursor tamper+expiry, indexed keyset without temp sort');
  const matches = (parent, change) => domains.matches({ ...request, parent }, change);
  const notificationsBeforeMove = store.db.prepare('SELECT COALESCE(MAX(revision),0) AS n FROM client_changes').get().n;
  // Move through CloudRecords' real DELETE + INSERT semantics: both parents invalidated.
  const destination = reads.page(owner, { ...request, parent: 10000 });
  store.transaction(() => {
    store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='chats' AND record_key=?").run(owner, '999');
    put('chats', 999, { id: 999, sessionId: 10000, createdAt: 999, role: 'user', content: 'moved' });
  });
  assert.throws(() => reads.page(owner, { ...request, cursor: fresh.next }), /projection_cursor_expired/);
  assert.throws(() => reads.page(owner, { ...request, parent: 10000, cursor: destination.next }), /projection_cursor_expired/);
  const changes = store.db.prepare('SELECT * FROM client_changes WHERE revision>?').all(notificationsBeforeMove);
  for (const parent of [1000, 10000, undefined]) assert.ok(changes.some(change => matches(parent, change)), `move wakes ${parent ?? 'whole collection'}`);
  assert.ok(changes.every(change => !matches(100000, change)), 'unrelated parent receives no invalidation');
  evidence.checks.push('exact collection invalidation includes OLD/NEW and whole-table readers, excludes unrelated parent');
  const beforeRollback = reads.page(owner, request);
  assert.throws(() => store.transaction(() => { put('chats', 998, { id: 998, sessionId: 1000 }); throw new Error('injected_rollback'); }), /injected_rollback/);
  assert.equal(reads.page(owner, { ...request, cursor: beforeRollback.next }).records.length, 50);
  evidence.checks.push('OLD and NEW invalidate moved membership; rolled-back write rolls back head version');
  put('cards', 2, null);
  put('cards', 3, { id: 3, videoId: 'secret', q: 'other owner secret' }, other);
  const exact = reads.keys(owner, { kind: 'recordKeys', keys: [{ table: 'cards', key: 1 }, { table: 'cards', key: 2 }, { table: 'cards', key: 3 }] });
  assert.ok(exact.records[0].value);
  assert.equal(exact.records[1].value, null); assert.ok(exact.records[1].revision > 0);
  assert.deepEqual(exact.records[2], { table: 'cards', key: 3, value: null, revision: 0 });
  assert.throws(() => reads.keys(owner, { kind: 'recordKeys', keys: Array.from({ length: 101 }, (_, key) => ({ table: 'cards', key })) }), /projection_keys_limit/);
  assert.throws(() => reads.keys(owner, { kind: 'recordKeys', keys: [{ table: 'cards', key: 1 }, { table: 'cards', key: 1 }] }), /duplicate_projection_key/);
  evidence.checks.push('exact key receipts expose tombstone revision, distinguish never-present, enforce owner and budgets');
  put('handouts', 1, { id: 1, videoId: 'large', content: 'x'.repeat(PROJECTION_PAGE_BYTES) });
  put('handouts', 2, { id: 2, videoId: 'large', content: 'second record' });
  const large = reads.page(owner, { kind: 'collectionPage', table: 'handouts', parent: 'large' });
  assert.equal(large.records.length, 1);
  assert.equal(large.records[0].value.content.length, PROJECTION_PAGE_BYTES);
  assert.ok(large.next);
  assert.equal(reads.page(owner, { kind: 'collectionPage', table: 'handouts', parent: 'large', cursor: large.next }).records[0].key, 2);
  evidence.checks.push('one exceptional complete record is preserved; following record stays on the next bounded page');
  for (const key of [10, 11]) put('handouts', key, { id: key, videoId: 'key-budget', content: 'x'.repeat(9 * 1024 * 1024) });
  assert.throws(() => reads.keys(owner, { kind: 'recordKeys', keys: [10, 11].map(key => ({ table: 'handouts', key })) }), /projection_keys_bytes_limit/);
  evidence.checks.push('exact-key aggregate byte budget rejects oversized batches before loading all requested bodies');
  for (let id = 1; id <= 121; id++) put('skills', id, { id, name: `skill-${id}`, description: 'metadata', body: 'not-in-discovery'.repeat(10000),
    enabled: id % 2, builtin: 0, updatedAt: id, legacyIds: [id + 1000], legacyNames: ['old-name'], mcpRequired: ['fixture'], futureLargeField: 'private-large-field' });
  put('skills', 122, null);
  put('skills', 123, { id: 123, name: 'other-owner-secret', body: 'secret' }, other);
  const skillRequest = { kind: 'skillIndex' }, skillFirst = reads.skillIndex(owner, skillRequest), discovered = [];
  let skillPage = skillFirst;
  for (;;) {
    assert.ok(skillPage.skills.length <= 50);
    assert.ok(Buffer.byteLength(JSON.stringify(skillPage)) < PROJECTION_PAGE_BYTES);
    assert.equal(skillPage.version, skillFirst.version);
    for (const item of skillPage.skills) {
      assert.equal('body' in item, false); assert.equal('futureLargeField' in item, false);
      assert.deepEqual(item.mcpRequired, ['fixture']); assert.deepEqual(item.legacyIds, [item.id + 1000]);
    }
    discovered.push(...skillPage.skills);
    if (!skillPage.next) break;
    skillPage = reads.skillIndex(owner, { ...skillRequest, cursor: skillPage.next });
  }
  assert.equal(discovered.length, 121); assert.equal(new Set(discovered.map(row => row.id)).size, 121);
  assert.ok(discovered.every(row => row.refCount === 0));
  put('skillRefs', 4001, { id: 4001, skillId: 1, path: 'references/example.md', body: 'not downloaded by index' });
  put('skillRefs', 4002, { id: 4002, skillId: 2, path: 'references/other.md', body: 'other skill' });
  const countedSkills = reads.skillIndex(owner, skillRequest);
  assert.equal(countedSkills.skills.find(row => row.id === 1).refCount, 1);
  assert.equal(countedSkills.skills.find(row => row.id === 10).refCount, 0);
  const refHeadBeforeMove = countedSkills;
  store.db.prepare("UPDATE cloud_records SET value=json_set(value,'$.skillId',2) WHERE owner_id=? AND table_name='skillRefs' AND record_key='4001'").run(owner);
  const afterReferenceMove = reads.skillIndex(owner, skillRequest);
  assert.equal(afterReferenceMove.skills.find(row => row.id === 1).refCount, 0);
  assert.equal(afterReferenceMove.skills.find(row => row.id === 2).refCount, 2);
  assert.throws(() => reads.skillIndex(owner, { ...skillRequest, cursor: refHeadBeforeMove.next }), /projection_cursor_expired/);
  assert.throws(() => store.transaction(() => {
    store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND record_key='4001'").run(owner);
    throw new Error('reference_count_rollback');
  }), /reference_count_rollback/);
  assert.deepEqual(reads.skillIndex(owner, skillRequest), afterReferenceMove, 'reference count and catalog version both roll back');
  store.db.prepare("UPDATE cloud_records SET value=NULL WHERE owner_id=? AND table_name='skillRefs' AND record_key='4001'").run(owner);
  assert.equal(reads.skillIndex(owner, skillRequest).skills.find(row => row.id === 2).refCount, 1);
  store.db.prepare("DELETE FROM cloud_records WHERE owner_id=? AND table_name='skillRefs' AND record_key='4002'").run(owner);
  assert.equal(reads.skillIndex(owner, skillRequest).skills.find(row => row.id === 2).refCount, 0);
  evidence.checks.push('skill reference counts follow parent moves, tombstones and physical deletion; rollback preserves both counts and signed catalog head');
  const handoutCourse = 'handout-demand';
  for (let id = 6001; id <= 6121; id++) put('handouts', id, { id, videoId: handoutCourse, title: `handout-${id}`, createdAt: id,
    sectionsJson: JSON.stringify([{ title: 'section', text: `complete-${id}` }]), blob: { $file: `handout-${id}`, type: 'application/docx' }, outlineJson: '{}' });
  put('handouts', 6122, { id: 6122, videoId: handoutCourse, createdAt: 6121, title: 'tie-latest', sectionsJson: 'complete-selected-document' });
  put('handouts', 6200, { id: 6200, videoId: 'other-handout-course', createdAt: 99999, title: 'other-course' });
  put('handouts', 6300, { id: 6300, videoId: handoutCourse, createdAt: 99999, title: 'other-owner' }, other);
  put('handouts', 6400, null);
  assert.equal(reads.latestHandout(owner, handoutCourse).record.key, 6122);
  assert.equal(reads.latestHandout(owner, handoutCourse).record.value.sectionsJson, 'complete-selected-document');
  assert.equal(reads.latestHandout(other, handoutCourse).record.key, 6300);
  assert.equal(reads.latestHandout(owner, 'missing-handout-course').record, null);
  assert.throws(() => reads.latestHandout(owner, ''), /invalid_course_scope/);
  const handoutRequest = { kind: 'latestHandout', videoId: handoutCourse };
  assert.equal(domains.matches(handoutRequest, { domain: 'record_collection', entity: JSON.stringify(['handouts', `parent:${JSON.stringify(handoutCourse)}`]) }), true);
  assert.equal(domains.matches(handoutRequest, { domain: 'record_collection', entity: JSON.stringify(['handouts', 'parent:"other-handout-course"']) }), false);
  store.db.prepare("UPDATE cloud_records SET value=NULL WHERE owner_id=? AND table_name='handouts' AND record_key='6122'").run(owner);
  assert.equal(reads.latestHandout(owner, handoutCourse).record.key, 6121);
  store.db.prepare("UPDATE cloud_records SET value=json_set(value,'$.videoId','other-handout-course') WHERE owner_id=? AND table_name='handouts' AND record_key='6121'").run(owner);
  assert.equal(reads.latestHandout(owner, handoutCourse).record.key, 6120);
  put('handouts', 6500, { id: 6500, videoId: handoutCourse, createdAt: 1, sectionsJson: 'x'.repeat(17 * 1024 * 1024) });
  assert.equal(reads.latestHandout(owner, handoutCourse).record.key, 6120, 'huge historical version does not block the selected document');
  store.db.prepare("UPDATE cloud_records SET value=json_set(value,'$.createdAt',999999) WHERE owner_id=? AND table_name='handouts' AND record_key='6500'").run(owner);
  assert.throws(() => reads.latestHandout(owner, handoutCourse), /projection_record_bytes_limit/);
  const handoutPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT record_key,length(CAST(value AS BLOB)) AS bytes FROM cloud_records INDEXED BY cloud_records_handout_latest
    WHERE owner_id=? AND table_name='handouts' AND value IS NOT NULL AND json_extract(value,'$.videoId')=?
    ORDER BY json_extract(value,'$.createdAt') DESC,json_extract(value,'$.id') DESC LIMIT 1`).all(owner, handoutCourse);
  assert.ok(handoutPlan.some(row => row.detail.includes('cloud_records_handout_latest')));
  assert.equal(handoutPlan.some(row => row.detail.includes('TEMP B-TREE')), false);
  evidence.handoutPlan = handoutPlan;
  evidence.checks.push('latest handout selects one complete indexed document from 122 historic versions, owner/course/createdAt+id/tombstone/move isolation; old oversized body skipped, selected oversized body rejected before loading; exact parent invalidation');
  const mediaCourse = 'handout-media-demand';
  put('videos', mediaCourse, { id: mediaCourse, name: 'Authoritative media course' });
  const mediaDocument = { id: 6600, videoId: mediaCourse, createdAt: 1, outlineJson: '{}', sectionsJson: JSON.stringify([{ heading: 'Figures', blocks: [
    { type: 'figure', ts: 3.5 }, { type: 'figure', ts: 3.8 }, { type: 'figure', ts: 8 }, { type: 'para', text: 'unrelated figure text' }] }]) };
  put('handouts', mediaDocument.id, mediaDocument);
  put('frames', 7001, { id: 7001, videoId: mediaCourse, ts: 3.5, blob: { $file: 'old-frame' }, caption: 'never-return-caption' });
  put('frames', 7002, { id: 7002, videoId: mediaCourse, ts: 3.9, blob: { $file: 'new-frame' }, caption: 'never-return-caption' });
  put('frames', 7003, { id: 7003, videoId: 'other-media-course', ts: 8, blob: { $file: 'other-course-frame' } });
  put('frames', 7004, { id: 7004, videoId: mediaCourse, ts: 8, blob: { $file: 'other-owner-frame' } }, other);
  put('frames', 7005, { id: 7005, videoId: mediaCourse, ts: 9999, blob: { $file: 'unreferenced-frame' }, caption: 'x'.repeat(1024 * 1024) });
  const selectedMedia = reads.latestHandout(owner, mediaCourse).media;
  assert.deepEqual(selectedMedia, { courseName: 'Authoritative media course', frames: [{ ts: 3.9, blob: { $file: 'new-frame' } }] });
  assert.equal(domains.matches({ kind: 'latestHandout', videoId: mediaCourse }, { domain: 'cloud_records', entity: `videos:${JSON.stringify(mediaCourse)}` }), true);
  assert.equal(domains.matches({ kind: 'latestHandout', videoId: mediaCourse }, { domain: 'record_collection', entity: JSON.stringify(['frames', `parent:${JSON.stringify(mediaCourse)}`]) }), true);
  const framePlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT json_object('ts',json_extract(value,'$.ts'),'blob',json_extract(value,'$.blob'))
    FROM cloud_records INDEXED BY cloud_records_frame_second WHERE owner_id=? AND table_name='frames' AND value IS NOT NULL AND json_extract(value,'$.videoId')=?
    AND CAST(json_extract(value,'$.ts') AS INTEGER)=? ORDER BY json_extract(value,'$.id') DESC LIMIT 1`).all(owner, mediaCourse, 3);
  assert.ok(framePlan.some(row => row.detail.includes('cloud_records_frame_second')));
  assert.equal(framePlan.some(row => row.detail.includes('TEMP B-TREE')), false);
  evidence.handoutFramePlan = framePlan;
  const updateMediaDocument = value => store.db.prepare("UPDATE cloud_records SET value=? WHERE owner_id=? AND table_name='handouts' AND record_key=?")
    .run(JSON.stringify(value), owner, JSON.stringify(mediaDocument.id));
  updateMediaDocument({ ...mediaDocument, sectionsJson: JSON.stringify([{ blocks: Array.from({ length: 256 }, (_, ts) => ({ type: 'figure', ts })) }]) });
  assert.equal(reads.latestHandout(owner, mediaCourse).record.key, mediaDocument.id);
  updateMediaDocument({ ...mediaDocument, sectionsJson: JSON.stringify([{ blocks: Array.from({ length: 257 }, (_, ts) => ({ type: 'figure', ts })) }]) });
  assert.throws(() => reads.latestHandout(owner, mediaCourse), /handout_media_budget_exceeded/);
  updateMediaDocument(mediaDocument);
  store.db.prepare("UPDATE cloud_records SET value=json_set(value,'$.blob',json(?)) WHERE owner_id=? AND table_name='frames' AND record_key='7002'")
    .run(JSON.stringify({ $file: 'x'.repeat(PROJECTION_PAGE_BYTES) }), owner);
  assert.throws(() => reads.latestHandout(owner, mediaCourse), /handout_media_budget_exceeded/);
  evidence.checks.push('handout figures select indexed exact seconds only, deduplicate, isolate course/owner and omit captions/unreferenced frames; 256 references succeed, 257 or >512KiB metadata fail explicitly');
  assert.throws(() => reads.skillIndex(owner, { ...skillRequest, cursor: skillFirst.next }), /projection_cursor_expired/);
  assert.equal(domains.matches(skillRequest, { domain: 'record_collection', entity: JSON.stringify(['skillRefs', '*']) }), true);
  const referenceCountPlan = store.db.prepare(`EXPLAIN QUERY PLAN SELECT count(*) FROM cloud_records
    WHERE owner_id=? AND table_name='skillRefs' AND (${recordParentSql})=? AND value IS NOT NULL`).all(owner, 1);
  assert.ok(referenceCountPlan.some(row => /cloud_records_parent_key/.test(row.detail)), JSON.stringify(referenceCountPlan));
  evidence.skillReferenceCountQueryPlan = referenceCountPlan;
  assert.throws(() => reads.skillIndex(other, { ...skillRequest, cursor: skillFirst.next }), /projection_cursor_scope/);
  assert.throws(() => reads.page(owner, { kind: 'collectionPage', table: 'skills', cursor: skillFirst.next }), /projection_cursor_scope/);
  assert.equal(domains.matches(skillRequest, { domain: 'record_collection', entity: JSON.stringify(['skills', '*']) }), true);
  assert.equal(domains.matches(skillRequest, { domain: 'record_collection', entity: JSON.stringify(['cards', '*']) }), false);
  assert.equal(domains.matches(skillRequest, { domain: 'system_file_entries', entity: '/system/skills/fixture/SKILL.md' }), true);
  store.db.prepare("UPDATE cloud_records SET value=json_set(value,'$.enabled',0) WHERE owner_id=? AND table_name='skills' AND record_key='1'").run(owner);
  assert.throws(() => reads.skillIndex(owner, { ...skillRequest, cursor: skillFirst.next }), /projection_cursor_expired/);
  const skillPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT record_key FROM cloud_records WHERE owner_id=? AND table_name='skills' AND value IS NOT NULL AND record_key>? ORDER BY record_key LIMIT 51").all(owner, '1');
  assert.ok(!skillPlan.some(row => /SCAN |TEMP B-TREE/.test(row.detail)), JSON.stringify(skillPlan));
  evidence.skillIndexQueryPlan = skillPlan;
  evidence.checks.push('121 skill metadata records: 50-row pages, no body/future fields, aliases intact, no duplicates/tombstones/other-owner data; signed scope/version and indexed keyset; indexed reference counts and invalidation');
  const restartPage = reads.page(owner, request);
  store.close(); store = new DatabaseStore(dbPath, path.join(directory, 'system'));
  assert.equal(new RecordProjections(store).page(owner, { ...request, cursor: restartPage.next }).records.length, 50);
  evidence.checks.push('persistent epoch/signing identity/cursor across database reopen');
  evidence.passed = true;
  console.log(JSON.stringify(evidence, null, 2));
  console.log(`PASS record projections: ${directory}`);
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  store.close();
}
