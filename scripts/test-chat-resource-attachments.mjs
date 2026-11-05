import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';

const directory = fs.mkdtempSync(path.join(process.env.TMPDIR, 'opencode/chat-resources-'));
const filename = path.join(directory, 'db.sqlite'), files = path.join(directory, 'files');
fs.mkdirSync(files);
let store = new DatabaseStore(filename);
try {
  const owner = crypto.randomUUID(), other = crypto.randomUUID();
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, new Date().toISOString());
  let projects = new ProjectRepository(store, path.join(directory, 'projects'));
  let resources = new ResourceFiles(projects, files);
  const records = new CloudRecords(store);
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value }]);
  const upload = (who, text) => receiveFile(store, files, who, Readable.from([text]), '原题.txt', 'text/plain', 1000);
  const first = await upload(owner, 'first'), second = await upload(owner, 'second'), foreign = await upload(other, 'private');
  await upload(owner, 'unused draft');
  for (const id of [1, 2]) put('chatSessions', id, { id, videoId: '__library_assistant__', title: '同名会话', createdAt: 1 });
  put('chats', 1, { id: 1, sessionId: 1, role: 'user', content: 'files', attachments: [{ serverId: first.id }, { serverId: second.id }, { serverId: foreign.id }], createdAt: 1 });
  put('chats', 2, { id: 2, sessionId: 2, role: 'user', content: 'shared file', attachments: [{ serverId: first.id }], createdAt: 2 });
  const listing = resources.list(owner);
  assert.deepEqual(listing.entries.map(row => row.name), ['聊天附件']);
  const archive = listing.entries[0].projectId;
  const folders = resources.list(owner, archive).entries;
  assert.deepEqual(folders.map(row => row.name), ['同名会话', '同名会话 (2)']);
  const entries = resources.list(owner, archive, folders[0].path).entries;
  assert.deepEqual(entries.map(row => row.name), ['原题 (2).txt', '原题.txt']);
  assert.deepEqual(entries.map(row => projects.files.read(archive, row.path).text).sort(), ['first', 'second']);
  assert.equal(resources.list(owner, archive, folders[1].path).entries.length, 1);
  assert.equal(resources.list(other).entries.length, 0, 'uncommitted upload stays outside library');
  // Accepted requests are archived even when model execution failed before a
  // user/assistant checkpoint could be committed.
  const failedUpload = await upload(owner, 'failed task attachment');
  put('chatSessions', 3, { id: 3, videoId: '__library_assistant__', title: '失败仍保留', createdAt: 3 });
  store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,kind,resource,status,input,executor,nonce,created_at,updated_at) VALUES('failed-chat',?,'chat','session:3','failed',?,'node','failed-chat',?,?)")
    .run(owner, JSON.stringify({ sessionId: 3, text: 'failed', attachments: [{ serverId: failedUpload.id }] }), new Date().toISOString(), new Date().toISOString());
  resources.list(owner);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM chat_resource_attachments').get().n, 4);
  assert.equal(resources.list(owner, archive, '失败仍保留').entries.length, 1);
  const target = entries[0];
  projects.files.remove(archive, target.path, target.revision);
  resources.list(owner);
  assert.equal(resources.list(owner, archive, folders[0].path).entries.length, 1, 'deleted copy never resurrects');
  store.close(); store = new DatabaseStore(filename);
  projects = new ProjectRepository(store, path.join(directory, 'projects')); resources = new ResourceFiles(projects, files);
  assert.equal(resources.list(owner, archive, folders[0].path).entries.length, 1, 'restart preserves receipts');
  resources.trash(owner, archive);
  assert.equal(resources.list(owner).entries.length, 0, 'trashed attachment group is not recreated');
  resources.restoreTrash(owner, archive);
  assert.equal(resources.list(owner, archive, folders[0].path).entries.length, 1);
  resources.trash(owner, archive); resources.deleteTrash(owner, archive);
  assert.equal(resources.list(owner).entries.length, 0, 'permanently deleted group is not rebuilt from history');
  console.log('PASS chat attachments: per-session folders, same-name files, account isolation, drafts, idempotency, deletion and restart');
} finally { store.close(); }
