import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import { createPluginScopes } from '../apps/web/src/client/plugin-scopes.ts';

const ctx = new Context(), scopes = createPluginScopes(ctx);
const identity = { server: 'https://redacted.invalid', account: 'private-account', project: 'project', instance: 'same', placement: 'board', revision: 1 };
try {
  const leases = ['board', 'side', 'page'].map(placement => scopes.acquire({ ...identity, placement }));
  assert.deepEqual(scopes.diagnostics().scopes, { account: 1, project: 1, instance: 1, placement: 3 });
  assert.equal(scopes.diagnostics().retains, 3);
  let listening = 0, callbacks = 0;
  const stop = leases[0].own(() => { listening++; return () => listening--; });
  assert.equal(listening, 1);
  stop(); stop(); assert.equal(listening, 0);
  leases[0].own(() => { listening++; return () => listening--; });
  const old = leases[0], incarnation = old.incarnation;
  const late = Promise.resolve().then(() => { if (old.current()) callbacks++; });
  old.release(); old.release();
  const replacement = scopes.acquire(identity);
  await late;
  assert.equal(callbacks, 0);
  assert.throws(() => old.assertCurrent(), /scope_expired/);
  assert.notEqual(replacement.incarnation, incarnation);
  assert.equal(replacement.current(), true);
  for (const lease of [...leases, replacement]) lease.release();
  await scopes.settled(); assert.equal(listening, 0);
  for (let i = 0; i < 100; i++) {
    const lease = scopes.acquire(identity);
    lease.own(() => { listening++; return () => listening--; });
    lease.release(); lease.release();
    await scopes.settled();
  }
  assert.equal(listening, 0);
  assert.deepEqual(scopes.diagnostics().scopes, { account: 0, project: 0, instance: 0, placement: 0 });
  assert.equal(scopes.diagnostics().created, scopes.diagnostics().released);
  assert.equal(scopes.diagnostics().retains, 0);
  assert.equal(scopes.diagnostics().observations, 0);
  assert.equal(scopes.diagnostics().failures, 0);
  assert.ok(!JSON.stringify(scopes.diagnostics()).includes('private-account'));
  const account = scopes.acquire(identity);
  account.own(() => { listening++; return () => listening--; });
  scopes.invalidate();
  assert.equal(account.current(), false);
  assert.equal(scopes.diagnostics().retains, 0);
  await scopes.settled(); assert.equal(listening, 0);
  const next = scopes.acquire({ ...identity, account: 'other' });
  assert.notEqual(next.incarnation, account.incarnation);
  next.release(); account.release(); await scopes.settled();

  // Verify actual locked Cordis service withdrawal/re-provision, not an
  // emulation of dependency state in an application-owned lifecycle class.
  const dependency = ctx.isolate('plugin-test-dependency');
  let activations = 0, releases = 0;
  const consumer = dependency.inject(['plugin-test-dependency'], owner => {
    activations++;
    owner.effect(() => () => { releases++; });
  });
  assert.equal(activations, 0);
  const revoke = dependency.provide('plugin-test-dependency', {});
  await consumer;
  assert.equal(activations, 1);
  await revoke(); assert.equal(releases, 1);
  const revokeAgain = dependency.provide('plugin-test-dependency', {});
  await consumer;
  assert.equal(activations, 2);
  await revokeAgain(); assert.equal(releases, 2);
  await consumer.dispose();
  console.log('PASS real Cordis scope sharing/independent placements, incarnation/late callbacks, account invalidation, dependency withdrawal/restoration, 100 cycles, idempotent effects and redacted diagnostics');
} finally { scopes.invalidate(); await scopes.settled(); await ctx.fiber.dispose(); }
