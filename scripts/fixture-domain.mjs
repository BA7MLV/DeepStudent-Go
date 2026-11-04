import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Test-side real Host/codec invocation, never a production table-write shim. */
export async function fixtureDomain(app, cookie, method, request) {
  const response = await app.inject({ method: 'POST', url: `/api/clientRuntime/${method}`, headers: { cookie }, payload: {
    type: 'client-request', rpcId: crypto.randomUUID(), method: `clientRuntime/${method}`, payload: { args: { request } },
  } });
  assert.equal(response.statusCode, 200, response.body);
  return response.json().result;
}

export async function fixturePreference(app, cookie, key, value, expected = null) {
  const result = await fixtureDomain(app, cookie, 'setPreferences', { operationId: crypto.randomUUID(), changes: [{ key, value, expected }] });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

export async function fixtureBrowserDomain(requestContext, origin, method, request) {
  const response = await requestContext.post(`${origin}/api/clientRuntime/${method}`, { headers: { origin }, data: {
    type: 'client-request', rpcId: crypto.randomUUID(), method: `clientRuntime/${method}`, payload: { args: { request } },
  } });
  assert.equal(response.status(), 200, await response.text());
  const result = (await response.json()).result;
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

/** Only historical/derived test setup may bypass domains, in a disposable DB. */
export async function seedFixtureRecords(directory, owner, mutations, database = 'db.sqlite') {
  assert.equal(process.env.NODE_ENV, 'test');
  assert.equal(fs.realpathSync(directory), fs.realpathSync(process.env.DATA_DIR));
  const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(directory));
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'fixture DB must be inside the system temporary directory');
  assert.ok(!database.includes('/') && database.endsWith('.sqlite'));
  const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
  const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
  const store = new DatabaseStore(path.join(directory, database), path.join(directory, 'files/system-files'));
  try { return new CloudRecords(store).apply(owner, mutations); } finally { store.close(); }
}
