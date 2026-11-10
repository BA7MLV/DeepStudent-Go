/** Filesystem notification acceptance on a real Host + WS transport. Isolated
 * fixture data: proves external file creation reaches a live projection, and
 * that a change visible without a revision bump is sent as a replacement
 * snapshot instead of being dropped. Not a browser/production-startup test. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { Context } from '@deepseek-ai/cordis';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { installConnection } from '@deepseek-ai/dsh-client-connection/client';
import { apply as installGateway } from '@deepseek-ai/dsh-api-gateway/client';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';
import { applyRuntimePatch } from '@wangke/contracts/runtime-projection';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/fs-notify-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const CALLS = Number(process.env.CALLS ?? 20);
const evidence = { calls: CALLS, seen: 0, missed: [], frames: 0, snapshots: 0, deltas: 0, wakeDelayMs: [] };
let app, ctx, control;
try {
  app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external_fetch_forbidden'); } });
  const base = await app.listen({ host: '127.0.0.1', port: 0 });
  const secret = fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim();
  await app.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': secret }, payload: { adminPassword: 'fs-notify-password-123' } });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'fs-notify-password-123' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  ctx = new Context();
  await ctx.plugin(TypertRegistry);
  installConnection(ctx, { interactions: 'answer', transport: {
    fetch: (url, init) => fetch(new URL(url, base), { ...init, headers: { ...init?.headers, cookie } }),
    streamBaseUrl: base,
    createWebSocket: url => new WebSocket(url, { headers: { cookie, origin: base } }),
  } });
  await ctx.plugin(installGateway);
  await ctx.remote.$mount(TYPERT_REMOTE);
  const created = await fetch(new URL('/api/v1/resources/folders', base), { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'fs-notify' }) });
  if (!created.ok) throw new Error(`create folder failed: ${created.status} ${await created.text()}`);
  const projectId = (await created.json()).id;
  const root = path.join(directory, 'files/projects', projectId);
  control = new AbortController();
  const stream = ctx.remote.clientRuntime.watch({ kind: 'resources', projectId, path: '', archived: true }, control.signal)[Symbol.asyncIterator]();
  let value;
  const apply = async next => {
    const item = await next;
    assert.ok(item && !item.done, 'projection stream ended early');
    if (item.value.type === 'snapshot') { evidence.snapshots++; value = item.value.value; }
    else { evidence.deltas++; value = applyRuntimePatch(value, item.value.changes); }
    return value;
  };
  await apply(stream.next());
  const names = new Set((value.entries ?? []).map(entry => entry.name));
  for (let index = 0; index < CALLS; index++) {
    const name = `external-${index}.txt`, started = Date.now();
    fs.writeFileSync(path.join(root, name), `outside ${index}`);
    while (!names.has(name)) {
      const next = await Promise.race([stream.next(), delay(5000).then(() => 'timeout')]);
      if (next === 'timeout') { evidence.missed.push(name); break; }
      await apply(next); evidence.frames++;
      for (const entry of value.entries ?? []) names.add(entry.name);
    }
    if (names.has(name)) { evidence.seen++; evidence.wakeDelayMs.push(Date.now() - started); }
    await delay(50);
  }
  // The projection must equal the authoritative directory, not merely contain
  // the names we were watching for.
  const unary = await ctx.remote.clientRuntime.read({ kind: 'resources', projectId, path: '', archived: true });
  assert.equal(unary.ok, true, JSON.stringify(unary.error));
  assert.deepEqual((value.entries ?? []).map(entry => entry.name).sort(), (unary.value.value.entries ?? []).map(entry => entry.name).sort());
  control.abort(); await stream.return?.();
  assert.deepEqual(evidence.missed, []);
  assert.equal(evidence.seen, CALLS);
  evidence.passed = true;
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(`PASS filesystem notifications ${evidence.seen}/${CALLS} (${evidence.deltas} deltas, ${evidence.snapshots} replacements): ${directory}`);
} catch (error) {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ ...evidence, error: String(error) }, null, 2));
  throw error;
} finally { control?.abort(); await ctx?.fiber.dispose().catch(() => {}); await app?.close(); }
