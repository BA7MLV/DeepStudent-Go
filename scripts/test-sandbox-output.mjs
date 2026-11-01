import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { OutputPreview, outputLimitBytes, previewBytes } from '../infra/sandbox/output.mjs';
import { removeContainer } from '../infra/sandbox/cleanup.mjs';
import { executeSandbox, SandboxFailure } from '../apps/api/src/agent/sandbox.ts';
import { BotArtifacts } from '../apps/api/src/agent/artifacts.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { ToolRegistry } from '../apps/api/src/agent/tools/registry.ts';
import { BotRunner } from '../apps/api/src/agent/runner.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotApplicationService } from '../apps/api/src/agent/service.ts';
import { StudyTools } from '../apps/api/src/agent/study.ts';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
test('head/tail previews are bounded without losing small UTF-8 output', () => {
  for (const text of ['小结果🧪', 'x'.repeat(8192), '开头\n' + '中间'.repeat(100000) + '\n末尾']) {
    const preview = new OutputPreview(), bytes = Buffer.from(text);
    for (let i = 0; i < bytes.length; i += 113) preview.push(bytes.subarray(i, i + 113));
    const result = preview.result();
    assert.equal(result.bytes, bytes.length);
    assert.equal(result.truncated, bytes.length > previewBytes);
    if (!result.truncated) assert.equal(result.text, text);
    else { assert.ok(Buffer.byteLength(result.text) < previewBytes + 200); assert.match(result.text, /开头/); assert.match(result.text, /末尾/); }
  }
});

test('cleanup retries removal-in-progress, confirms absence and rejects real failures', async () => {
  let attempts = 0;
  await removeContainer('fixture', { run: async () => { if (++attempts < 3) throw { stderr: 'removal of container fixture is already in progress' }; throw { stderr: 'No such container: fixture' }; }, sleep: async () => {} });
  assert.equal(attempts, 3);
  await assert.rejects(removeContainer('fixture', { run: async () => { throw { stderr: 'Cannot connect to Docker daemon' }; } }), error => /Cannot connect/.test(error.stderr));
  let time = 0;
  await assert.rejects(removeContainer('fixture', { run: async () => { throw { stderr: 'removal of container fixture is already in progress' }; }, sleep: async ms => { time += ms; }, now: () => time, timeoutMs: 500 }), /sandbox_cleanup_pending/);
});

// Exercise the actual HTTP broker and API transport without requiring Docker.
// Only the Docker executable is replaced; it runs real child processes/pipes.
async function fixture(operation) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-output-'));
  const bin = path.join(root, 'bin'), projects = path.join(root, 'projects');
  fs.mkdirSync(bin); fs.mkdirSync(projects);
  const docker = path.join(bin, 'docker');
  fs.writeFileSync(docker, `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const args = process.argv.slice(2), root = process.env.FAKE_DOCKER_DIR;
if (args[0] === 'run') {
  const name = args[args.indexOf('--name') + 1], command = args.at(-1);
  const child = spawn('bash', ['-lc', command], { stdio: 'inherit', detached: true });
  fs.writeFileSync(path.join(root, name + '.pid'), String(child.pid));
  child.on('close', code => { process.exit(code ?? 137); });
} else if (args[0] === 'rm') {
  const filename = path.join(root, args.at(-1) + '.pid');
  if (fs.existsSync(path.join(root, 'fail-cleanup'))) { console.error('Cannot connect to Docker daemon'); process.exit(1); }
  if (!fs.existsSync(filename)) { console.error('No such container'); process.exit(1); }
  try { process.kill(-Number(fs.readFileSync(filename, 'utf8')), 'SIGKILL'); } catch {}
  fs.unlinkSync(filename);
  if (fs.existsSync(path.join(root, 'removal-race'))) { console.error('removal of container fixture is already in progress'); process.exit(1); }
} else { console.error('Unexpected fake Docker invocation'); process.exit(1); }
`, { mode: 0o700 });
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port; await new Promise(resolve => reservation.close(resolve));
  const token = crypto.randomBytes(32).toString('hex');
  const broker = spawn(process.execPath, ['infra/sandbox/broker.mjs'], { env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, FAKE_DOCKER_DIR: root, SANDBOX_TOKEN: token, PORT: String(port), HOST: '127.0.0.1', SANDBOX_PROJECTS_DIR: projects, SANDBOX_PROJECTS_HOST_DIR: projects }, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = ''; broker.stderr.on('data', data => { logs += data; }); broker.stdout.resume();
  const url = `http://127.0.0.1:${port}`, before = { url: process.env.SANDBOX_URL, token: process.env.SANDBOX_TOKEN };
  const owner = crypto.randomUUID(), threadId = crypto.randomUUID();
  try {
    let ready = false;
    for (let n = 0; n < 100; n++) {
      if (broker.exitCode !== null) throw new Error(logs);
      try { ready = (await fetch(url + '/health')).ok; } catch {}
      if (ready) break; await sleep(20);
    }
    assert.ok(ready, logs);
    process.env.SANDBOX_URL = url; process.env.SANDBOX_TOKEN = token;
    const request = command => ({ owner, threadId, executionId: crypto.randomUUID(), command, timeoutSeconds: 10 });
    const call = (command, sink) => executeSandbox(request(command), AbortSignal.timeout(20000), sink);
    await operation({ root, url, token, owner, threadId, request, call });
  } finally {
    for (const name of fs.readdirSync(root).filter(name => name.endsWith('.pid'))) {
      try { process.kill(-Number(fs.readFileSync(path.join(root, name), 'utf8')), 'SIGKILL'); } catch {}
    }
    broker.kill('SIGTERM');
    await new Promise(resolve => { if (broker.exitCode !== null) resolve(); else broker.once('exit', resolve); });
    for (const [key, value] of [['SANDBOX_URL', before.url], ['SANDBOX_TOKEN', before.token]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('217 KB output succeeds, streams intact, preserves stderr and bounds previews', () => fixture(async ({ call, root }) => {
  fs.writeFileSync(path.join(root, 'removal-race'), '');
  let stdout = '', stderr = '';
  const result = await call("printf 'BEGIN'; head -c 217526 /dev/zero | tr '\\0' x; printf 'END'; printf 'diagnostic' >&2", async (kind, chunk) => { if (kind === 'stdout') stdout += Buffer.from(chunk); else stderr += Buffer.from(chunk); });
  assert.equal(result.exitCode, 0); assert.equal(result.output.complete, true);
  assert.equal(stdout, 'BEGIN' + 'x'.repeat(217526) + 'END'); assert.equal(stderr, 'diagnostic');
  assert.equal(result.output.stdoutBytes, Buffer.byteLength(stdout)); assert.equal(result.output.stdoutTruncated, true);
  assert.ok(result.stdout.length < 9000); assert.match(result.stdout, /BEGIN/); assert.match(result.stdout, /END/);
}));

test('legacy JSON clients get marked previews rather than killed commands', () => fixture(async ({ url, token, request }) => {
  const response = await fetch(url + '/execute', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(request("head -c 217526 /dev/zero | tr '\\0' x")) });
  assert.equal(response.status, 200);
  const result = await response.json(); assert.equal(result.exitCode, 0); assert.equal(result.output.stdoutTruncated, true); assert.equal(result.output.complete, true);
}));

test('slow consumers apply backpressure to both streams without loss', () => fixture(async ({ call }) => {
  let bytes = 0;
  const result = await call("head -c 1048576 /dev/zero; head -c 1048576 /dev/zero >&2", async (_kind, chunk) => { bytes += chunk.length; await sleep(2); });
  assert.equal(bytes, 2 * 1048576); assert.equal(result.exitCode, 0); assert.ok(result.stderr.length < 9000);
}));

test('hard output budget terminates flood explicitly and removes the execution', () => fixture(async ({ call, root }) => {
  let bytes = 0;
  const result = await call('yes flood', async (_kind, chunk) => { bytes += chunk.length; });
  assert.equal(result.terminationReason, 'output_limit_exceeded'); assert.equal(result.output.complete, false);
  assert.equal(bytes, outputLimitBytes); assert.notEqual(result.exitCode, 0);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.pid')).length, 0);
  assert.equal((await call('printf recovered')).stdout, 'recovered');
}));

test('cleanup failure keeps scope locked, preserves its error and recovers after confirmed removal', () => fixture(async ({ call, root, url, token }) => {
  fs.writeFileSync(path.join(root, 'fail-cleanup'), '');
  await assert.rejects(call('printf complete'), error => error instanceof SandboxFailure && error.code === 'sandbox_cleanup_pending');
  await assert.rejects(call('printf must-not-run'), error => error.code === 'sandbox_busy');
  fs.unlinkSync(path.join(root, 'fail-cleanup'));
  const name = fs.readdirSync(root).find(name => name.endsWith('.pid'));
  const executionId = name.slice('wangke-exec-'.length, -4);
  const response = await fetch(url + '/cancel', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ executionId }) });
  assert.equal(response.status, 200);
  assert.equal((await call('printf recovered')).stdout, 'recovered');
}));

test('client disconnect cancels the container and releases scope only after cleanup', () => fixture(async ({ call, root, url, token, request }) => {
  const controller = new AbortController();
  const response = await fetch(url + '/execute', { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/x-ndjson' }, body: JSON.stringify(request('printf started; sleep 60')), signal: controller.signal });
  const reader = response.body.getReader();
  assert.ok((await reader.read()).value.length);
  controller.abort(); await reader.cancel().catch(() => {});
  for (let n = 0; n < 100 && fs.readdirSync(root).some(name => name.endsWith('.pid')); n++) await sleep(20);
  assert.equal(fs.readdirSync(root).filter(name => name.endsWith('.pid')).length, 0);
  // The fixture pid disappears before Docker CLI and the broker's terminal
  // handler settle; don't assume that releasing the scope takes a fixed time.
  let result;
  for (let n = 0; n < 100; n++) {
    try { result = await call('printf after-disconnect'); break; }
    catch (error) { if (error.code !== 'sandbox_busy') throw error; await sleep(20); }
  }
  assert.equal(result?.stdout, 'after-disconnect');
}));

test('API file artifacts preserve split Unicode, bounded paging, owner isolation and restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shell-artifacts-')), filename = path.join(root, 'db.sqlite');
  let store = new DatabaseStore(filename);
  const owner = crypto.randomUUID(), other = crypto.randomUUID(), thread = crypto.randomUUID(), run = crypto.randomUUID(), step = crypto.randomUUID(), at = new Date().toISOString();
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
  store.db.prepare("INSERT INTO threads(id,mode,owner_id,created_at,updated_at) VALUES(?,'bot',?,?,?)").run(thread, owner, at, at);
  store.db.prepare("INSERT INTO runs(id,thread_id,mode,status,created_at) VALUES(?,?,'bot','running',?)").run(run, thread, at);
  store.db.prepare("INSERT INTO run_steps(id,run_id,tool,arguments,status,created_at) VALUES(?,?,'shell','{}','running',?)").run(step, run, at);
  try {
    const text = '中文🧪𠮷\\"\n'.repeat(25000), raw = Buffer.from(text);
    const output = { stdoutBytes: raw.length, stderrBytes: 0, stdoutTruncated: true, stderrTruncated: false, complete: true, limitBytes: outputLimitBytes };
    const result = await new BotArtifacts(store).captureShell(owner, run, step, async sink => {
      for (let offset = 0; offset < raw.length; offset += 4093) await sink('stdout', raw.subarray(offset, offset + 4093));
      return { stdout: 'preview', stderr: '', exitCode: 0, output };
    });
    const id = result.artifacts.stdout.artifactId;
    assert.ok(store.db.prepare('SELECT length(content) n FROM bot_artifacts WHERE id=?').get(id).n <= 1500, 'SQLite contains preview, not full output');
    assert.throws(() => new BotArtifacts(store).read(other, id), /artifact_not_found/);
    assert.throws(() => new BotArtifacts(store).read(owner, id, 3), /invalid_result_offset/, 'cannot start inside an astral character');
    store.close(); store = new DatabaseStore(filename);
    let reconstructed = '', offset = 0, pages = 0;
    do {
      const page = new BotArtifacts(store).read(owner, id, offset, 12000, 2048);
      assert.ok(page.budget.estimatedTokens <= 2048); assert.equal(page.totalChars, text.length);
      reconstructed += page.text; offset = page.nextOffset;
      assert.ok(++pages < 1000);
    } while (offset !== null);
    assert.equal(reconstructed, text);
    const inline = new BotArtifacts(store).put(owner, run, step, 'existing inline artifact');
    assert.equal(new BotArtifacts(store).read(owner, inline.artifactId).text, 'existing inline artifact');
    // Storage exhaustion degrades to the bounded preview, not command failure.
    const used = store.db.prepare('SELECT SUM(size_bytes) bytes FROM bot_artifacts WHERE owner_id=?').get(owner).bytes;
    store.db.prepare('INSERT INTO bot_artifacts(id,owner_id,run_id,content,size_bytes,created_at) VALUES(?,?,?,\'quota fixture\',?,?)').run('quota-fixture', owner, run, 50 * 1024 * 1024 - used, at);
    const degraded = await new BotArtifacts(store).captureShell(owner, run, step, async sink => { await sink('stdout', raw); return { stdout: 'preview', stderr: '', exitCode: 0, output }; });
    assert.equal(degraded.exitCode, 0); assert.equal(degraded.outputStorageError, 'artifact_quota_exceeded'); assert.equal(degraded.artifacts, undefined);
    store.db.prepare("DELETE FROM bot_artifacts WHERE id='quota-fixture'").run();
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    const pending = Array.from({ length: 3 }, () => new BotArtifacts(store).captureShell(owner, run, step, async () => { await gate; return { stdout: '', stderr: '', exitCode: 0 }; }));
    try {
      assert.throws(() => new BotArtifacts(store).put(owner, run, step, 'x'.repeat(2 * 1024 * 1024)), /artifact_quota_exceeded/, 'inline writes honor concurrent shell reservations');
      const concurrent = await new BotArtifacts(store).captureShell(owner, run, step, async sink => { await sink('stdout', Buffer.alloc(2 * 1024 * 1024)); return { stdout: 'preview', stderr: '', exitCode: 0 }; });
      assert.equal(concurrent.outputStorageError, 'artifact_quota_exceeded', 'concurrent captures cannot each spend the same owner quota');
    } finally { release(); await Promise.all(pending); }
    store.db.prepare('UPDATE bot_artifact_files SET expires_at=? WHERE artifact_id=?').run(new Date(Date.now() - 1).toISOString(), id);
    assert.throws(() => new BotArtifacts(store).read(owner, id), /artifact_expired/);
    new BotArtifacts(store).cleanup();
    assert.equal(fs.existsSync(path.join(store.artifactFilesDir, id + '.utf16')), false);
    fs.rmdirSync(store.artifactFilesDir); fs.writeFileSync(store.artifactFilesDir, 'not a writable directory');
    const unavailable = await new BotArtifacts(store).captureShell(owner, run, step, async sink => { await sink('stdout', raw); return { stdout: 'preview', stderr: '', exitCode: 0, output }; });
    assert.equal(unavailable.exitCode, 0); assert.equal(unavailable.outputStorageError, 'artifact_storage_unavailable');
    fs.unlinkSync(store.artifactFilesDir); fs.mkdirSync(store.artifactFilesDir);
    // Thread deletion first removes artifacts (as the HTTP route does); their
    // file metadata cascades, and GC reclaims the now-orphaned file.
    store.db.prepare('DELETE FROM bot_artifacts WHERE run_id=?').run(run);
    store.db.prepare('DELETE FROM threads WHERE id=?').run(thread);
    new BotArtifacts(store).cleanup(Date.now() + 3600001);
    assert.equal(fs.readdirSync(store.artifactFilesDir).length, 0);
  } finally { store.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('real Bot runner delivers large shell previews and readable full artifacts without failing the run', () => fixture(async ({ root, owner }) => {
  const store = new DatabaseStore(path.join(root, 'runner.sqlite'));
  let runner;
  try {
    const at = new Date().toISOString();
    store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(owner, owner, at);
    const config = new CloudConfiguration(store, path.join(root, 'config')), defaults = config.get(owner, true);
    config.save(owner, { ...defaults, providers: [{ id: 'fake', name: 'Fake', baseUrl: 'https://model.invalid/v1', protocol: 'openai-chat', apiKey: 'fake', serves: ['chat'] }], llmModel: { providerId: 'fake', model: 'fake' }, policy: { ...defaults.policy, shell: 'allow', read: 'allow', write: 'allow' } });
    const service = new BotApplicationService(store, { enqueue() {}, cancel() {} });
    const thread = service.create(owner, 'bot', 'Output test');
    const message = service.send(owner, thread.id, { clientNonce: 'output-test', content: 'Inspect all files' });
    const run = store.db.prepare('SELECT id FROM runs WHERE trigger_message_id=?').get(message.id).id;
    let requests = 0, modelResult;
    const study = new StudyTools(store, config, path.join(root, 'files'));
    runner = new BotRunner(store, { configuration: config, study, fetch: async (_url, init) => {
      if (++requests === 1) return Response.json({ choices: [{ message: { tool_calls: [{ id: 'provider-shell', type: 'function', function: { name: 'shell', arguments: JSON.stringify({ command: "head -c 217526 /dev/zero | tr '\\0' x" }) } }] } }], usage: { prompt_tokens: 20, completion_tokens: 20 } });
      modelResult = JSON.parse(JSON.parse(init.body).messages.findLast(m => m.role === 'tool').content);
      return Response.json({ choices: [{ message: { content: 'Inspection finished.' } }], usage: { prompt_tokens: 20, completion_tokens: 20 } });
    } });
    runner.start();
    for (let n = 0; n < 500 && !['completed', 'failed'].includes(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status); n++) await sleep(10);
    assert.equal(store.db.prepare('SELECT status FROM runs WHERE id=?').get(run).status, 'completed');
    assert.equal(modelResult.exitCode, 0); assert.equal(modelResult.output.complete, true);
    const artifactId = modelResult.artifacts.stdout.artifactId;
    assert.equal(new BotArtifacts(store).read(owner, artifactId).totalChars, 217526);
    assert.equal(store.db.prepare('SELECT count(*) n FROM bot_artifact_files').get().n, 1);
  } finally { await runner?.close(); store.close(); }
}));

test('transport rejects truncated protocol and preserves broker error classes through tool dispatch', async () => {
  const before = { fetch: globalThis.fetch, url: process.env.SANDBOX_URL, token: process.env.SANDBOX_TOKEN };
  try {
    process.env.SANDBOX_URL = 'http://fixture.invalid'; process.env.SANDBOX_TOKEN = 'fixture';
    for (const code of ['sandbox_busy', 'sandbox_cleanup_pending', 'sandbox_start_failed']) {
      globalThis.fetch = async () => Response.json({ error: code }, { status: 503 });
      const registry = new ToolRegistry();
      registry.register({ type: 'function', function: { name: 'shell', parameters: { type: 'object', properties: {}, additionalProperties: false } } }, 'uncertain');
      const outcome = await registry.execute('shell', {}, { signal: new AbortController().signal, checkActive() {} }, () => executeSandbox({ command: 'true' }, new AbortController().signal));
      assert.equal(outcome.error.code, code);
    }
    for (const body of ['{"type":"stdout","data":"eA=="}\n', '{"type":"result"}\n', 'not-json\n', 'null\n', '[]\n']) {
      globalThis.fetch = async () => new Response(body, { headers: { 'content-type': 'application/x-ndjson' } });
      await assert.rejects(executeSandbox({ command: 'true' }, new AbortController().signal), /sandbox_protocol_error/);
    }
  } finally {
    globalThis.fetch = before.fetch;
    for (const [key, value] of [['SANDBOX_URL', before.url], ['SANDBOX_TOKEN', before.token]]) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});
