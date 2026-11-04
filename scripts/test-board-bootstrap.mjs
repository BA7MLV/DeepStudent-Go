import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BoardFiles } from '../apps/api/src/board/files.ts';

const root = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/board-bootstrap-');
const store = new DatabaseStore(path.join(root, 'db.sqlite'), path.join(root, 'files'));
try {
  for (const owner of ['owner', 'rollback']) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const files = new BoardFiles(store);
  const initial = files.catalog('owner');
  assert.ok(initial.length >= 4);
  const original = fs.readdirSync;
  let bundledScans = 0;
  fs.readdirSync = (folder, ...args) => {
    if (String(folder).includes('/apps/api/board-plugins/')) bundledScans++;
    return original(folder, ...args);
  };
  try {
    for (let index = 0; index < 20; index++) assert.deepEqual(new BoardFiles(store).catalog('owner'), initial);
  } finally { fs.readdirSync = original; }
  assert.equal(bundledScans, 0, 'committed bootstrap is shared across BoardFiles instances, without repeated bundled upgrade scans');
  const manifest = path.join(root, 'files', crypto.createHash('sha256').update('owner').digest('hex'), 'system/board/plugins/todo/manifest.json');
  const content = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(manifest, '{invalid external change');
  assert.ok(files.catalog('owner').find(plugin => plugin.id === 'todo').error, 'bootstrap cache does not cache live manifests');
  fs.writeFileSync(manifest, content);
  assert.equal(files.catalog('owner').find(plugin => plugin.id === 'todo').error, undefined);
  assert.throws(() => store.db.transaction(() => { files.ensure('rollback'); throw new Error('rollback bootstrap'); })(), /rollback bootstrap/);
  assert.equal(store.systemFiles.entry('rollback', '/system/board/README.md'), undefined);
  assert.ok(files.catalog('rollback').every(plugin => !plugin.error), 'rolled-back initialization must not mark the account bootstrapped');
  console.log(`PASS: committed board bootstrap once, rollback-safe cache and live disk revocation. Evidence: ${root}`);
} finally { store.close(); }
