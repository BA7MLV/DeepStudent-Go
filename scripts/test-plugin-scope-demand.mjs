/** Isolated SQL/filesystem scope projection, not production browser acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { PluginFiles } from '../apps/api/src/plugins/files.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { assembleRuntimeDomains } from '../apps/api/src/realtime/runtime-domains.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-scope-');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system'));
const evidence = { checks: [] };
try {
  const owner = 'scope-owner', other = 'scope-other';
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
  const files = new PluginFiles(store, undefined, path.join(directory, 'files'));
  const put = (id, row, who = owner) => store.db.prepare("INSERT OR REPLACE INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,'videos',?,?)")
    .run(who, JSON.stringify(id), row === null ? null : JSON.stringify({ id, ...row }));
  store.transaction(() => { for (let i = 0; i < 10000; i++) put(`unrelated-${i}`, { name: `UNREQUESTED_${i}`, body: 'PRIVATE_BODY'.repeat(100) }); });
  put('unrelated-huge-name', { name: 'UNREQUESTED_'.repeat(100000) });
  put('bound', { name: 'Pinned course', body: 'PRIVATE_BODY'.repeat(100000) });
  put('current', { name: 'Current course' });
  put('deleted', null); put('gone-file', { name: 'Gone', fileDeleted: true });
  put('foreign', { name: 'FOREIGN_OWNER' }, other);
  const original = files.layout(owner), layout = JSON.parse(original.content);
  layout.instances.push({ id: 'bound-cards', pluginId: 'flashcards', scope: { kind: 'material', id: 'bound' } });
  files.save(owner, original.path, JSON.stringify(layout), original.content, original.revision);
  // Full row materialization is forbidden even for a bound course's huge body.
  const originalGet = CloudRecords.prototype.get;
  CloudRecords.prototype.get = function(owner, table, key) { assert.notEqual(table, 'videos', 'scope discovery must select metadata only'); return originalGet.call(this, owner, table, key); };
  try {
    const base = files.scopeCatalog(owner);
    assert.deepEqual(base.materials, [{ id: 'bound', name: 'Pinned course' }]);
    assert.deepEqual(base.materialProjects, {}); assert.deepEqual(base.projectFolders, []);
    assert.ok(!JSON.stringify(base).includes('UNREQUESTED_'));
    assert.deepEqual(files.scopeCatalog(owner, { materialId: 'current' }).materials.map(row => row.id).sort(), ['bound', 'current']);
    for (const id of ['deleted', 'gone-file', 'foreign', 'missing']) assert.ok(!files.scopeCatalog(owner, { materialId: id }).materials.some(row => row.id === id));
    put('current', { name: 'x'.repeat(512 * 1024) });
    assert.throws(() => files.scopeCatalog(owner, { materialId: 'current' }), /course_metadata_budget_exceeded/);
    assert.equal(files.scopeCatalog(owner).materials[0].name, 'Pinned course', 'unrequested oversized metadata cannot break base catalog');
    put('current', { name: 'Repaired' });
    assert.equal(files.scopeCatalog(owner, { materialId: 'current' }).materials.find(row => row.id === 'current').name, 'Repaired');
    const project = files.projects.create(owner, 'Mapped project');
    files.projects.files.write(project.id, 'lecture.md', '# mapped course', null);
    store.db.prepare('INSERT INTO resource_files(owner_id,course_id,project_id,path,identity,revision) VALUES(?,?,?,?,?,?)').run(owner, 'current', project.id, 'lecture.md', 'fixture', 'fixture');
    assert.equal(files.scopeCatalog(owner, { materialId: 'current' }).materialProjects.current, project.id);
    const open = files.projects.files.open;
    files.projects.files.open = () => { throw new Error('injected_filesystem_io_failure'); };
    assert.throws(() => files.scopeCatalog(owner, { materialId: 'current' }), /injected_filesystem_io_failure/, 'an unavailable read is not permission revocation or deletion');
    files.projects.files.open = open;
    files.projects.update(owner, project.id, { archived: true });
    assert.ok(!files.scopeCatalog(owner, { materialId: 'current' }).materials.some(row => row.id === 'current'));
    files.projects.update(owner, project.id, { archived: false });
    assert.equal(files.scopeCatalog(owner, { materialId: 'current' }).materialProjects.current, project.id);
    fs.unlinkSync(path.join(directory, 'files/projects', project.id, 'lecture.md'));
    assert.ok(!files.scopeCatalog(owner, { materialId: 'current' }).materials.some(row => row.id === 'current'));
  } finally { CloudRecords.prototype.get = originalGet; }
  const domains = assembleRuntimeDomains({ store, plugins: { files } });
  const change = id => ({ owner_id: owner, domain: 'cloud_records', entity: `videos:${JSON.stringify(id)}` });
  assert.equal(domains.matches({ kind: 'catalog' }, change('unrelated-1')), false);
  assert.equal(domains.matches({ kind: 'catalog' }, change('bound')), true);
  assert.equal(domains.matches({ kind: 'pluginScope', materialId: 'current' }, change('current')), true);
  assert.equal(domains.matches({ kind: 'pluginScope', materialId: 'current' }, change('unrelated-1')), false);
  assert.throws(() => files.scopeCatalog(owner, { materialId: '' }), /invalid_plugin_scope/);
  assert.throws(() => files.scopeCatalog(owner, { projectFolderId: NaN }), /invalid_plugin_scope/);
  evidence.checks.push('10k unrelated courses and oversized bodies/names are not enumerated or materialized; layout-bound and exact host metadata only, owner/tombstone/file-deleted isolation');
  evidence.checks.push('budget error is not deletion; repaired retry, mapped project archive/restore and missing file revoke live host context; exact material invalidation');
  const now = new Date().toISOString();
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO projects(id,owner_id,name,created_at,updated_at) VALUES(?,?,?,?,?)');
    for (let i = 0; i < 512; i++) insert.run(`budget-project-${i}`, owner, 'Budget project', now, now);
  });
  assert.throws(() => files.scopeCatalog(owner), /plugin_scope_budget_exceeded/, 'oversized project config fails visibly, never returns a silently incomplete scope');
  evidence.checks.push('small project configuration has a 512-entry guard, not an unbounded fallback');
  evidence.passed = true; console.log(`PASS plugin scope: ${directory}`, evidence.checks);
} finally { fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2)); store.close(); }
