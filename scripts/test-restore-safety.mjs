import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('restore refuses filesystem-root aliases before processing the archive', () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'restore-safety-')));
  try {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    // Guard the reproduction itself: no restore mutations are allowed, even on
    // the vulnerable script. The fake archive listing stops it before extraction.
    for (const command of ['mkdir', 'rm', 'cp', 'chmod', 'chown', 'docker']) {
      fs.writeFileSync(path.join(bin, command), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    }
    fs.writeFileSync(path.join(bin, 'tar'), '#!/bin/sh\necho archive_was_inspected >&2\necho unapproved-fixture-path\n', { mode: 0o700 });
    const archive = path.join(root, 'backup.tar.gz');
    fs.writeFileSync(archive, 'fixture');
    const alias = path.join(root, 'root-link');
    fs.symlinkSync('/', alias);
    const traversal = `${root}/${'../'.repeat(root.split('/').filter(Boolean).length)}`;
    for (const target of ['/', '/./', alias, traversal]) {
      const result = spawnSync('bash', ['scripts/restore.sh', '--data-dir', target, archive], {
        encoding: 'utf8', env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` }, timeout: 5000,
      });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /refusing unsafe data directory/, target);
      assert.doesNotMatch(result.stderr, /archive_was_inspected/);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
