import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { BoardFiles } from '../apps/api/src/board/files.ts';

const fixtures = path.resolve('scripts/fixtures/board-plugins');
const root = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/board-bootstrap-');
const store = new DatabaseStore(path.join(root, 'db.sqlite'), path.join(root, 'files'));
const accountRoot = owner => path.join(root, 'files', crypto.createHash('sha256').update(owner).digest('hex'), 'system');
try {
  for (const owner of ['empty', 'owner', 'rollback', 'legacy']) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());

  // Everything on the board is a user component: a new account gets docs and a template, no components.
  delete process.env.BOARD_SEED_DIR;
  const files = new BoardFiles(store);
  assert.deepEqual(files.catalog('empty'), [], 'new accounts start with an empty board');
  assert.ok(fs.existsSync(path.join(accountRoot('empty'), 'board/README.md')));
  assert.ok(fs.existsSync(path.join(accountRoot('empty'), 'board/template/manifest.json')));
  assert.ok(!fs.existsSync(path.join(accountRoot('empty'), 'board/plugins/todo')));

  // Operators/tests may preinstall packages from an explicit directory.
  process.env.BOARD_SEED_DIR = fixtures;
  const initial = files.catalog('owner');
  assert.deepEqual(initial.map(plugin => plugin.id).sort(), ['pomodoro', 'schedules', 'tasks', 'todo']);
  const original = fs.readdirSync;
  let bundledScans = 0;
  fs.readdirSync = (folder, ...args) => {
    if (String(folder).includes('/apps/api/board-plugins/') || String(folder).startsWith(fixtures)) bundledScans++;
    return original(folder, ...args);
  };
  try {
    for (let index = 0; index < 20; index++) assert.deepEqual(new BoardFiles(store).catalog('owner'), initial);
  } finally { fs.readdirSync = original; }
  assert.equal(bundledScans, 0, 'committed bootstrap is shared across BoardFiles instances, without repeated bundled upgrade scans');
  const manifest = path.join(accountRoot('owner'), 'board/plugins/todo/manifest.json');
  const content = fs.readFileSync(manifest, 'utf8');
  fs.writeFileSync(manifest, '{invalid external change');
  assert.ok(files.catalog('owner').find(plugin => plugin.id === 'todo').error, 'bootstrap cache does not cache live manifests');
  fs.writeFileSync(manifest, content);
  assert.equal(files.catalog('owner').find(plugin => plugin.id === 'todo').error, undefined);
  assert.throws(() => store.db.transaction(() => { files.ensure('rollback'); throw new Error('rollback bootstrap'); })(), /rollback bootstrap/);
  assert.equal(store.systemFiles.entry('rollback', '/system/board/README.md'), undefined);
  assert.ok(files.catalog('rollback').every(plugin => !plugin.error), 'rolled-back initialization must not mark the account bootstrapped');
  delete process.env.BOARD_SEED_DIR;

  // An account bootstrapped by an older release still has the four shipped samples.
  // Untouched copies are retired once; edited code or saved data stays user-owned.
  const legacy = path.join(accountRoot('legacy'), 'board');
  for (const id of ['todo', 'tasks', 'schedules', 'pomodoro']) fs.cpSync(path.join(fixtures, id), path.join(legacy, 'plugins', id), { recursive: true });
  fs.cpSync(path.resolve('apps/api/board-plugins/README.md'), path.join(legacy, 'README.md'));
  store.systemFiles.register('legacy', '/system/board/README.md');
  fs.writeFileSync(path.join(legacy, 'plugins/todo/state.json'), JSON.stringify({ items: [] }, null, 2) + '\n'); // re-serialized, still empty
  fs.writeFileSync(path.join(legacy, 'plugins/pomodoro/state.json'), '{"durationSeconds":1500,"remainingSeconds":900,"endsAt":null}'); // user data
  fs.writeFileSync(path.join(legacy, 'plugins/tasks/index.html'), '<p>My tasks</p>'); // user edit
  const reopened = new DatabaseStore(path.join(root, 'db.sqlite'), path.join(root, 'files'));
  try {
    const legacyFiles = new BoardFiles(reopened);
    assert.deepEqual(legacyFiles.catalog('legacy').map(plugin => plugin.id).sort(), ['pomodoro', 'tasks']);
    assert.ok(!fs.existsSync(path.join(legacy, 'plugins/todo')) && !fs.existsSync(path.join(legacy, 'plugins/schedules')), 'pristine samples are removed with their folders');
    assert.equal(fs.readFileSync(path.join(legacy, 'plugins/tasks/index.html'), 'utf8'), '<p>My tasks</p>');
    // Retirement runs once: a byte-identical package installed later on purpose stays.
    fs.cpSync(path.join(fixtures, 'todo'), path.join(legacy, 'plugins/todo'), { recursive: true });
    const later = new DatabaseStore(path.join(root, 'db.sqlite'), path.join(root, 'files'));
    try { assert.ok(new BoardFiles(later).catalog('legacy').some(plugin => plugin.id === 'todo')); } finally { later.close(); }
  } finally { reopened.close(); }
  console.log(`PASS: empty default board, explicit seed directory, committed bootstrap cache, rollback safety, one-time pristine sample retirement. Evidence: ${root}`);
} finally { store.close(); }
