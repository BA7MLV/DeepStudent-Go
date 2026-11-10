/** Real API/SQLite and browser stores; only the server model HTTP is scripted.
 * Source-module regression, not production rendering/performance acceptance. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/artifact-demand-');
Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
delete process.env.CLOUD_WORKER_DISABLED;
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const { CloudConfiguration } = await import('../apps/api/src/cloud/config.ts');
let hold = false, calls = 0;
const pending = new Set();
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async (url, init) => {
  assert.equal(new URL(String(url)).origin, 'https://model.invalid', 'no external model calls');
  calls++;
  const body = JSON.parse(init.body), patch = body.messages[0].content.includes('"edits"');
  if (hold) await new Promise(resolve => {
    const done = () => { pending.delete(done); resolve(); };
    pending.add(done);
    init.signal?.addEventListener('abort', done, { once: true });
    if (init.signal?.aborted) done();
  });
  const content = JSON.stringify(patch ? { edits: [{ search: 'original', replace: 'edited' }] } : { source: '<div>rewritten</div>' });
  return Response.json({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
} });
let web, browser, store;
const evidence = { checks: [], errors: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  const fixture = `
import { startCloud } from '/src/cloud/sync.ts';
import { db } from '/src/store/db.ts';
import { markCloudApply } from '/src/cloud/cache.ts';
import { artifactDraftKey, updateArtifactDraft, generateArtifactDraft, useArtifactDrafts } from '/src/store/artifactDrafts.ts';
import { persistArtifactEdit } from '/src/store/artifactEdit.ts';
import { invalidateAccountLifetime } from '/src/client/account-lifecycle.ts';
import { reviewCard, saveHandoutReading } from '/src/client/learning.ts';
await startCloud(window.owner);
const target = {rowId:81,kind:'html',location:'fence',source:'<div>original</div>'};
const key = artifactDraftKey(target);
window.probe = {
 start(mode='patch') { updateArtifactDraft(key,{instruction:'edit this block',context:'',next:undefined}); window.work=generateArtifactDraft(target,mode); },
 draft: () => useArtifactDrafts.getState().drafts[key],
 apply: next => persistArtifactEdit({...target,next}),
 stale: () => db.transaction('rw',db.chats,async()=>{markCloudApply();await db.chats.put({id:81,sessionId:900001,videoId:'course',role:'assistant',content:'stale IDB answer',createdAt:2});}),
 invalidate: invalidateAccountLifetime,
 reviewCard, saveHandoutReading,
 evictLearning: () => db.transaction('rw',db.cards,db.handouts,async()=>{markCloudApply();await db.cards.delete(881);await db.handouts.delete(882);}),
};
document.body.dataset.ready='yes';`;
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(directory, 'vite-cache'), plugins: [{
    name: 'artifact-demand-fixture', resolveId: id => id === '/__artifact-entry.js' ? '\0artifact-demand' : undefined,
    load: id => id === '\0artifact-demand' ? fixture : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__artifact') return next(); res.setHeader('content-type', 'text/html'); res.end('<script type="module" src="/__artifact-entry.js"></script>'); }); },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext();
  await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: 'artifact-demand-password-123' } });
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password: 'artifact-demand-password-123' } });
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store), config = new CloudConfiguration(store, directory);
  config.save(owner, { ...config.get(owner), providers: [{ id: 'fixture', name: 'Scripted server', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'free-only', serves: ['chat'], catalogId: '' }], llmModel: { providerId: 'fixture', model: 'fixture' } });
  const put = (table, key, value) => records.apply(owner, [{ id: crypto.randomUUID(), table, key, before: records.get(owner, table, key), after: value,
    baseRevision: store.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key))?.revision }]);
  const original = { id: 81, sessionId: 900001, videoId: 'course', role: 'assistant', content: 'before\n```html\n<div>original</div>\n```\nafter', createdAt: 2 };
  put('chatSessions', 900001, { id: 900001, videoId: 'course', title: 'Artifact fixture', createdAt: 1 }); put('chats', 81, original);
  await context.addInitScript(owner => { window.owner = owner; }, owner);
  const page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(origin + '/__artifact'); await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  const until = async predicate => { const end = Date.now() + 30000; while (Date.now() < end) { store.db.prepare("UPDATE cloud_permissions SET status='approved' WHERE owner_id=? AND status='pending'").run(owner); if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 25)); } throw new Error('artifact_fixture_timeout'); };
  await page.evaluate(() => probe.stale());
  await page.evaluate(() => probe.start());
  await until(() => page.evaluate(() => probe.draft()?.status === 'ready'));
  assert.equal(await page.evaluate(() => probe.draft().next), '<div>edited</div>');
  assert.deepEqual(records.get(owner, 'chats', 81), original, 'generation never applies automatically');
  evidence.checks.push('generation reads exact server source despite stale IDB; scripted patch result requires explicit apply');
  // A newer, unrelated field must be preserved by the exact expected read on apply.
  put('chats', 81, { ...original, reasoning: 'remote-preserved' });
  await page.evaluate(() => probe.stale());
  await page.evaluate(() => probe.apply('<div>edited</div>'));
  assert.equal(records.get(owner, 'chats', 81).reasoning, 'remote-preserved');
  assert.equal(records.get(owner, 'chats', 81).content, original.content.replace('original', 'edited'));
  await assert.rejects(page.evaluate(() => probe.apply('<div>not-applied</div>')), /变化|唯一|匹配|找到/);
  evidence.checks.push('explicit apply uses current server expected/CAS, preserves unrelated fields, rejects stale target');
  put('chats', 81, original);
  await page.evaluate(() => probe.start('rewrite'));
  await until(() => page.evaluate(() => probe.draft()?.status === 'ready'));
  assert.equal(await page.evaluate(() => probe.draft().next), '<div>rewritten</div>');
  evidence.checks.push('scripted rewrite uses the real server task and validation');
  for (const action of ['unrelated', 'changed', 'deleted', 'account']) {
    put('chats', 81, original); hold = true; const before = calls;
    await page.evaluate(() => probe.start()); await until(() => calls > before);
    if (action === 'unrelated') {
      // The store is deliberately offscreen throughout this test. A route/session
      // change does not dispose it; an unrelated record event must not cancel it.
      await page.evaluate(() => history.pushState(null, '', '/__artifact?session=other'));
      put('chats', 82, { ...original, id: 82, sessionId: 900002 });
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => probe.draft().status), 'generating');
      hold = false; for (const done of [...pending]) done();
      await until(() => page.evaluate(() => probe.draft().status === 'ready'));
      evidence.checks.push('offscreen generation survives navigation and unrelated record updates');
    } else {
      if (action === 'changed') put('chats', 81, { ...original, content: original.content.replace('original', 'remote') });
      if (action === 'deleted') put('chats', 81, null);
      if (action === 'account') await page.evaluate(() => probe.invalidate());
      await until(() => page.evaluate(() => probe.draft().status === 'idle' && !!probe.draft().error));
      assert.equal(await page.evaluate(() => probe.draft().next), undefined);
      hold = false; for (const done of [...pending]) done();
      await page.evaluate(() => window.work);
      assert.equal(await page.evaluate(() => probe.draft().next), undefined, 'late reply cannot restore invalidated output');
      evidence.checks.push(`${action} invalidates the pending draft without applying a late result`);
    }
  }
  put('chats', 81, original);
  await page.goto(origin + '/__artifact');
  await page.locator('body[data-ready="yes"]').waitFor({ timeout: 60000 });
  put('videos', 'course', { id: 'course', name: 'Learning exact-key fixture', createdAt: 1 });
  put('cards', 881, { id: 881, videoId: 'course', q: 'question', a: 'answer', time: 0, status: 0, createdAt: 1 });
  put('handouts', 882, { id: 882, videoId: 'course', title: 'Reading fixture', createdAt: 1, outlineJson: '[]' });
  await page.evaluate(() => probe.evictLearning());
  await page.evaluate(() => probe.reviewCard(881, 1, 0));
  await page.evaluate(() => probe.saveHandoutReading(882, { anchor: 'h1', offset: 12 }));
  assert.equal(records.get(owner, 'cards', 881).status, 1);
  assert.deepEqual(records.get(owner, 'handouts', 882).readPos, { anchor: 'h1', offset: 12 });
  evidence.checks.push('card review and handout reading hydrate exact keys when the local projection is absent; commands reach the server');
  let raced = false;
  await page.route('**/api/clientRuntime/editLearning', async route => {
    if (!raced) {
      raced = true;
      put('chats', 81, { ...original, content: original.content.replace('original', 'concurrent') });
    }
    await route.continue();
  });
  await assert.rejects(page.evaluate(() => probe.apply('<div>cas-loser</div>')), /conflict|Domain request failed/);
  assert.equal(raced, true, 'race happens after point read but before server mutation');
  assert.equal(records.get(owner, 'chats', 81).content, original.content.replace('original', 'concurrent'));
  const retained = await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    return db.table('_learningCommands').toArray();
  });
  assert.ok(retained.some(command => command.state === 'conflict' && command.request.edits.some(edit => edit.value?.content?.includes('cas-loser'))), 'losing CAS keeps the full intended draft in the durable journal');
  evidence.checks.push('concurrent edit after exact read rejects apply via server CAS and preserves losing draft in the conflict journal');
  assert.deepEqual(evidence.errors, []);
  evidence.modelCalls = calls; evidence.passed = true;
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log('PASS artifact demand regression:', directory, evidence);
} catch (error) {
  fs.writeFileSync(path.join(directory, 'failure.json'), JSON.stringify({ error: String(error), ...evidence }, null, 2));
  console.error('Artifact evidence:', directory); throw error;
} finally {
  for (const done of [...pending]) done();
  await browser?.close(); await web?.close(); await app.close(); store?.close();
}
