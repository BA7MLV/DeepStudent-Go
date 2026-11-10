/** Real filesystem + SQLite evidence for paged resource directories.
 * Not browser or production-startup evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-pagination-'));
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { ProjectRepository } = await import('../apps/api/src/projects/repository.ts');
const { ResourceFiles } = await import('../apps/api/src/projects/resources.ts');
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system-files'));
const projects = new ProjectRepository(store, path.join(directory, 'projects'));
const resources = new ResourceFiles(projects, path.join(directory, 'files'));
const owner = 'owner-a', other = 'owner-b';
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, other, new Date().toISOString());

const project = projects.create(owner, 'big');
const projectDir = path.join(directory, 'projects', project.id);
fs.mkdirSync(projectDir, { recursive: true });
const names = Array.from({ length: 1200 }, (_, index) => `file-${String(index).padStart(5, '0')}.md`);
for (const name of names) fs.writeFileSync(path.join(projectDir, name), 'x');

const pageOne = resources.listPage(owner, project.id, '', false, undefined, 500);
assert.equal(pageOne.entries.length, 500);
assert.ok(pageOne.next, 'first page must expose a forward cursor');
assert.ok(pageOne.entries.every(entry => entry.kind === 'file' && entry.projectId === project.id));

const pageTwo = resources.listPage(owner, project.id, '', false, pageOne.next, 500);
assert.equal(pageTwo.entries.length, 500);
assert.ok(pageTwo.next);
assert.ok(pageTwo.entries.every(entry => entry.name > pageOne.next), 'cursor must be a strictly forward offset');
assert.ok(!pageTwo.entries.some(entry => pageOne.entries.some(previous => previous.name === entry.name)), 'pages must be disjoint');

const pageThree = resources.listPage(owner, project.id, '', false, pageTwo.next, 500);
assert.equal(pageThree.entries.length, 200);
assert.equal(pageThree.next, undefined, 'no cursor past the final page');
const collected = [...pageOne.entries, ...pageTwo.entries, ...pageThree.entries].map(entry => entry.name).sort();
assert.deepEqual(collected, [...names].sort(), 'paged union must equal the complete directory');

const pastEnd = resources.listPage(owner, project.id, '', false, 'zzz-not-present', 500);
assert.equal(pastEnd.entries.length, 0);
assert.equal(pastEnd.next, undefined);

// Owner isolation: a foreign account cannot list another owner's project.
assert.throws(() => resources.listPage(other, project.id, '', false, undefined, 500), /not_found|forbidden|project/);

// DB-mapped placements are bounded extras attached to the first page only.
store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)')
  .run(owner, 'videos', JSON.stringify('mapped-course'), JSON.stringify({ id: 'mapped-course', name: 'Mapped course', status: 'done', createdAt: 0 }));
store.db.prepare('INSERT INTO resource_files(owner_id,project_id,path,course_id,identity,revision) VALUES(?,?,?,?,?,?)')
  .run(owner, project.id, 'mapped-entry.md', 'mapped-course', 'identity-a', 'r1');
const withMapped = resources.listPage(owner, project.id, '', false, undefined, 500);
const mappedEntries = withMapped.entries.filter(entry => entry.courseId === 'mapped-course');
assert.equal(mappedEntries.length, 1, 'mapped placement appears exactly once');
assert.ok(!mappedEntries[0].missing === false || mappedEntries[0].missing === true);
const mappedLater = resources.listPage(owner, project.id, '', false, withMapped.next, 500);
assert.equal(mappedLater.entries.filter(entry => entry.courseId === 'mapped-course').length, 0, 'extras never repeat on later pages');

// The legacy unpaginated path keeps its 413; the paged path lists the same directory.
const huge = projects.create(owner, 'huge');
const hugeDir = path.join(directory, 'projects', huge.id);
fs.mkdirSync(hugeDir, { recursive: true });
for (let index = 0; index < 5001; index++) fs.writeFileSync(path.join(hugeDir, `h-${String(index).padStart(5, '0')}.bin`), 'x');
assert.throws(() => resources.list(owner, huge.id), /project_directory_too_large/);
let paged = 0, cursor, guard = 0;
do {
  const page = resources.listPage(owner, huge.id, '', false, cursor, 500);
  paged += page.entries.length;
  cursor = page.next;
  guard++;
} while (cursor !== undefined && guard < 50);
assert.equal(guard, 11);
assert.equal(paged, 5001, 'a directory the legacy path rejects is fully listable when paged');

fs.rmSync(directory, { recursive: true, force: true });
console.log('PASS: paged resource listings stay bounded, forward-only, owner-isolated and complete');
