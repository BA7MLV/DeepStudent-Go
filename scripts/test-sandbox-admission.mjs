import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import test from 'node:test';

const pause = () => new Promise(resolve => setTimeout(resolve, 10));
test('quota checks reserve scope, execution ID and global capacity before awaiting Docker', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-admission-'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path');
const args = process.argv.slice(2), root = process.env.FAKE_DOCKER_DIR;
if (args[0] === 'image') console.log('sha256:fixture');
else if (args.includes('du')) {
  const mount = args[args.indexOf('--mount') + 1];
  fs.appendFileSync(path.join(root, 'quota-starts'), mount + '\\n');
  const timer = setInterval(() => {
    if (fs.existsSync(path.join(root, 'release-quota'))) {
      clearInterval(timer);
      if (fs.existsSync(path.join(root, 'fail-quota'))) process.exit(1);
      console.log(fs.existsSync(path.join(root, 'over-quota')) ? '999999999999 /ws' : '0 /ws');
    }
  }, 10);
} else if (args[0] === 'run') console.log('executed');
else if (args[0] === 'rm') { console.error('No such container'); process.exitCode = 1; }
else process.exitCode = 1;
`, { mode: 0o700 });
  const token = crypto.randomBytes(32).toString('hex');
  const broker = spawn(process.execPath, ['infra/sandbox/broker.mjs'], {
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_DIR: root,
      SANDBOX_TOKEN: token, PORT: '0', HOST: '127.0.0.1', SANDBOX_PROJECTS_DIR: root, SANDBOX_PROJECTS_HOST_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '', errors = '';
  broker.stdout.on('data', data => { output += data; });
  broker.stderr.on('data', data => { errors += data; });
  const pending = [];
  let base;
  try {
    for (let n = 0; n < 500 && !output.includes('sandbox.listening'); n++) {
      assert.equal(broker.exitCode, null, errors);
      await pause();
    }
    const listening = output.split('\n').map(line => { try { return JSON.parse(line); } catch { return {}; } }).find(row => row.event === 'sandbox.listening');
    assert.ok(listening, output + errors);
    base = `http://127.0.0.1:${listening.port}`;
    const request = () => ({ owner: crypto.randomUUID(), threadId: crypto.randomUUID(), executionId: crypto.randomUUID(), command: 'true' });
    const post = (body, endpoint = '/execute') => fetch(base + endpoint, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const first = request();
    pending.push(post(first));
    const quotaStarts = () => fs.existsSync(path.join(root, 'quota-starts')) ? fs.readFileSync(path.join(root, 'quota-starts'), 'utf8').trim().split('\n').length : 0;
    for (let n = 0; n < 500 && quotaStarts() < 1; n++) await pause();
    assert.equal(quotaStarts(), 1);
    const sameScope = post({ ...request(), threadId: first.threadId });
    const sameExecution = post({ ...request(), executionId: first.executionId });
    pending.push(sameScope, sameExecution);
    const prompt = async promise => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('admission waited for quota instead of rejecting busy work')), 2000);
      })]); } finally { clearTimeout(timer); }
    };
    for (const response of await Promise.all([prompt(sameScope), prompt(sameExecution)])) {
      assert.equal(response.status, 409);
      assert.equal((await response.json()).error, 'sandbox_busy');
    }
    for (let n = 1; n < 8; n++) pending.push(post(request()));
    for (let n = 0; n < 500 && quotaStarts() < 8; n++) await pause();
    assert.equal(quotaStarts(), 8);
    const overflow = post(request()); pending.push(overflow);
    assert.equal((await prompt(overflow)).status, 409);
    const cancellation = post({ executionId: first.executionId }, '/cancel'); pending.push(cancellation);
    await pause();
    fs.writeFileSync(path.join(root, 'release-quota'), '');
    assert.equal((await pending[0]).status, 409, 'cancel during quota must prevent execution');
    assert.equal((await cancellation).status, 200);
    await Promise.all(pending);
    const recovered = await post(request());
    assert.equal(recovered.status, 200, 'completed quota reservations must be released');
    const retry = request();
    fs.writeFileSync(path.join(root, 'fail-quota'), '');
    assert.equal((await post(retry)).status, 503);
    fs.unlinkSync(path.join(root, 'fail-quota'));
    fs.writeFileSync(path.join(root, 'over-quota'), '');
    const overQuota = await post(retry);
    assert.equal(overQuota.status, 409);
    assert.equal((await overQuota.json()).error, 'sandbox_workspace_quota_exceeded');
    fs.unlinkSync(path.join(root, 'over-quota'));
    assert.equal((await post(retry)).status, 200, 'quota errors and rejection must release both scope and execution ID');
  } finally {
    fs.writeFileSync(path.join(root, 'release-quota'), '');
    await Promise.allSettled(pending);
    if (broker.exitCode === null) { const exited = once(broker, 'exit'); broker.kill('SIGTERM'); await exited; }
    fs.rmSync(root, { recursive: true, force: true });
  }
});
