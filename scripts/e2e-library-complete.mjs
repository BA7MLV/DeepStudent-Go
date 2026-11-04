// Full current legacy schema, explicit external-byte mapping and no projection loss.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';
import { LIBRARY_IMPORT_FIELDS } from '../packages/contracts/src/library-import.ts';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/library-complete-');
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory, FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const api = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('external requests forbidden'); } });
let vite, browser, store;
try {
  const backend = await api.listen({ host: '127.0.0.1', port: 0 });
  assert.equal((await api.inject({ method: 'POST', url: '/api/v1/bootstrap/initialize', headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, payload: { adminPassword: 'library-complete-password' } })).statusCode, 201);
  const login = await api.inject({ method: 'POST', url: '/api/v1/auth/password/login', payload: { password: 'library-complete-password' } });
  const cookie = login.headers['set-cookie'].split(';')[0], owner = login.json().user.id;
  process.env.WANGKE_API_PROXY = backend;
  vite = await createServer({ root: new URL('../apps/web', import.meta.url).pathname, cacheDir: path.join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0 }, plugins: [{ name: 'complete-import-login', configureServer(server) { server.middlewares.use('/__login', (_req, res) => { res.setHeader('set-cookie', cookie + '; Path=/; SameSite=Lax'); res.writeHead(302, { location: '/#/settings/data' }); res.end(); }); } }] });
  await vite.listen(); browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ locale: 'zh-CN', acceptDownloads: true });
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.goto(`http://127.0.0.1:${vite.httpServer.address().port}/__login`);
  await page.getByTestId('cloud-sync-card').waitFor({ timeout: 60000 });
  const fixture = await page.evaluate(async () => {
    const { default: Dexie } = await import('/node_modules/.vite/deps/dexie.js');
    const blob = new Blob(['original attachment bytes'], { type: 'text/plain' });
    const rows = {
      courses: [{ id: 'external-md', name: 'Original / source.md', size: 21, mimeType: 'text/markdown', duration: 0, createdAt: 1, status: 'transcribed', transcriptionPaused: true, biliSource: { bvid: 'BV-test', aid: 1, cid: 2, page: 1 }, lastPosition: 9, finished: 1, fileDeleted: undefined, pinned: 1, skillOverride: { pin: [9001], drop: [] }, folderId: 901, kind: 'material', materialFormat: 'md', unitCount: 3, lastUnit: 2, scanned: 1, empty: 1, htmlView: 'blocks', dominantColor: '#123456', coverState: 'done' }],
      folders: [{ id: 900, name: 'Original root', createdAt: 1, color: 'purple' }, { id: 901, name: 'Nested', createdAt: 2, parentId: 900, color: 'green' }],
      files: [{ id: 'attachment-original', blob }],
      segments: [{ id: 902, videoId: 'external-md', idx: 0, start: 0, end: 1, text: 'Original transcript', status: 1, cues: [{ start: 0, end: 1, text: 'cue' }] }],
      tracks: [{ id: 903, videoId: 'external-md', lang: 'zh', lanDoc: '中文', primary: 1, cues: [{ start: 0, end: 1, text: 'cue' }] }],
      blocks: [{ id: 904, materialId: 'external-md', idx: 0, unit: 1, unitLabel: '§1', text: 'Original index', kind: 'body' }],
      frames: [{ id: 905, videoId: 'external-md', ts: 0, blob, kind: 'slide', caption: 'Original frame' }],
      covers: [{ videoId: 'external-md', blob, w: 10, h: 10, ts: 1, source: 'user', createdAt: 1 }],
      handouts: [{ id: 906, videoId: 'external-md', createdAt: 1, title: 'Original handout', blob, outlineJson: '{"original":true}', sectionsJson: '[{"original":true}]', usedSkills: ['original'], readPos: { anchor: 'sum', offset: 12 } }],
      cards: [{ id: 907, videoId: 'external-md', q: 'q', a: 'a', time: 0, status: 1, createdAt: 1 }],
      comments: [{ id: 908, videoId: 'external-md', time: 0, author: 'A', role: 'ask', text: 'Parent', createdAt: 1 }, { id: 909, videoId: 'external-md', time: 0, author: 'B', role: 'answer', text: 'Reply', parentId: 908, createdAt: 2 }],
      danmakus: [{ id: 910, videoId: 'external-md', time: 0, text: 'Original' }],
      sessions: [{ id: 911, videoId: 'external-md', title: 'Original session', createdAt: 1, contextCourseIds: ['external-md'], projectFolderId: 901, skillIds: [9001], pinnedSkillIds: [9001], mcpServerIds: ['historical-inert-mcp'], pinned: true, archived: true, promptCacheKey: 'original-cache-key', contextCheckpoint: { fromId: 912, source: 'original', prefixHash: 'original-hash' }, contextOmissions: [[912, 'original']] }],
      messages: [{ id: 912, taskId: 'original-task', videoId: 'external-md', sessionId: 911, role: 'assistant', content: 'Original content', createdAt: 1, modelTrace: { nested: { retained: true } }, modelRequests: [{ original: true }], explicitSkillIds: [9001], images: [{ ts: 1, thumb: 'data:image/png;base64,AA==', label: 'original', kind: 'page-selection' }], attachments: [{ id: 'attachment-original', name: 'original.txt', storage: 'local' }], reasoning: 'original reasoning', reasoningMs: 23, tools: [{ id: 'original-tool', name: 'original', status: 'done', reasoningOffset: 1, result: 'original', ms: 3 }], responseSegments: [{ original: true }], quiz: { original: [1, false] }, ask: { question: 'original', picked: 'keep' }, folderPlan: { original: true, applied: 0 }, resume: { toolName: 'ask_user', toolCallId: 'original-tool', midTurn: [{ role: 'tool', content: 'do not replay', tool_call_id: 'original-tool' }] }, interrupted: true, interruptReason: 'original', widget: { html: '<script>inert</script>' }, widgets: [{ original: true }], legacyHtmlWorks: [{ source: 'original', payload: { original: true } }], widgetState: { widgetId: 'original', value: { privateContent: 'original' } }, widgetStates: { original: { privateContent: 'original' } } }],
      skills: [{ id: 9001, name: 'Original skill', description: 'original', body: 'original', enabled: 0, builtin: 0, updatedAt: 1, mcpRequired: ['historical-inert-mcp'] }],
      references: [{ id: 913, skillId: 9001, path: 'references/original.md', body: 'original' }],
      annotations: [{ id: 'original-ink', materialId: 'external-md', surface: 'page:1', tool: 'highlight', color: '#123456', width: 2, height: 3, points: [{ x: 1, y: 2, pressure: 0.5 }], createdAt: 1, renderer: 'freehand-v1', nib: 'pressure', opacity: 0.4, smoothing: 0.5, input: 'pen', anchor: { start: 0, end: 8, exact: 'original', prefix: '', suffix: '', unit: 1, endUnit: 2, unitLabel: '§1', source: 'md' }, rects: [{ x: 1, y: 2, w: 3, h: 4 }] }],
      studyDays: [{ date: '2026-11-01', seconds: 123, updatedAt: 1 }],
    };
    const tables = { courses: 'videos', folders: 'folders', files: 'files', segments: 'segments', tracks: 'subtitleTracks', blocks: 'materialBlocks', frames: 'frames', covers: 'covers', handouts: 'handouts', cards: 'cards', comments: 'comments', danmakus: 'danmakus', sessions: 'chatSessions', messages: 'chats', skills: 'skills', references: 'skillRefs', annotations: 'materialInk', studyDays: 'studyDays' };
    const reference = { id: 'external-md', resourceProjectId: 'foreign-project', resourcePath: 'foreign/old.md', resourceRevision: 'foreign-revision', mimeType: 'text/markdown', size: 21 };
    const legacy = new Dexie('wangke');
    legacy.version(1).stores({ ...Object.fromEntries(Object.entries(tables).map(([name, table]) => [table, name === 'covers' ? 'videoId' : name === 'studyDays' ? 'date' : 'id'])), courseFiles: 'id', preferences: 'id', _cloudOutbox: 'id' });
    await legacy.open();
    await legacy.transaction('rw', legacy.tables, async () => {
      for (const [name, table] of Object.entries(tables)) await legacy.table(table).bulkPut(rows[name]);
      await legacy.table('courseFiles').put(reference);
      await legacy.table('preferences').put({ id: 'captionScale', value: 1.75 });
      await legacy.table('_cloudOutbox').put({ id: 'never-replay', operationId: 'original-identity', blob });
    }); legacy.close();
    localStorage.setItem('wangke-settings', JSON.stringify({ state: { studyIdleMinutes: 13, apiKey: 'inert-never-upload' } }));
    return { rows: JSON.parse(JSON.stringify(rows)), tables, reference };
  });
  // Every declared top-level field appears at least once, including legacy-only metadata.
  for (const [name, fields] of Object.entries(LIBRARY_IMPORT_FIELDS)) for (const field of fields.split(' ')) assert.ok(fixture.rows[name].some(row => field in row) || name === 'courses' && field === 'fileDeleted', `${name}.${field}`);
  const importUI = async () => { await page.getByTestId('cloud-sync-card').getByRole('button', { name: '导入', exact: true }).click(); await page.getByTestId('confirm-dialog-confirm').click(); };
  let uploads = 0; page.on('request', req => { if (req.method() === 'POST' && req.url().includes('/api/v1/files')) uploads++; });
  await importUI(); await page.getByText(/旧库包含外部文件引用/).waitFor(); assert.equal(uploads, 0);
  const staleMapping = await page.evaluate(async reference => {
    try { await (await import('/src/cloud/migrate.ts')).mapLibraryFile('external-md', { ...reference, resourceRevision: 'stale-source' }, new Blob(['wrong mapping'])); return false; }
    catch (error) { return error.message; }
  }, fixture.reference);
  assert.equal(staleMapping, 'library_file_mapping_changed'); assert.equal(uploads, 0, 'stale source CAS rejected without external effect');
  await page.getByRole('button', { name: '核对导入文件', exact: true }).click();
  await page.getByLabel('映射文件 external-md').setInputFiles({ name: 'original.md', mimeType: 'text/markdown', buffer: Buffer.from('# Explicit bytes\n\nPersistent original content') });
  await page.getByText(/bytes · SHA256/).waitFor();
  await page.reload(); await page.getByTestId('cloud-sync-card').waitFor();
  await page.getByRole('button', { name: '核对导入文件', exact: true }).click(); await page.getByText(/bytes · SHA256/).waitFor();
  await importUI(); await page.getByText('导入完成', { exact: true }).waitFor({ timeout: 60000 });
  assert.equal(uploads, 2, 'one attachment content and one explicitly mapped file, deduped');
  store = new DatabaseStore(path.join(directory, 'db.sqlite'));
  const actual = (table, key) => JSON.parse(store.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key)).value);
  for (const [name, table] of Object.entries(fixture.tables)) for (const row of fixture.rows[name]) {
    const result = actual(table, row.id ?? row.videoId ?? row.date);
    for (const [key, value] of Object.entries(row)) {
      if (key === 'blob') { assert.ok(result.blob.$file); continue; }
      assert.deepEqual(result[key], value, `${table}/${row.id ?? row.videoId}/${key}: complete field preserved`);
    }
  }
  assert.equal(actual('preferences', 'captionScale').value, 1.75); assert.equal(actual('preferences', 'studyIdleMinutes').value, 13);
  const mapping = actual('courseFiles', 'external-md'); assert.notEqual(mapping.resourceProjectId, fixture.reference.resourceProjectId);
  const doc = await api.inject({ method: 'GET', url: '/api/v1/resources/courses/external-md', headers: { cookie } });
  assert.equal(doc.statusCode, 200); assert.equal(doc.body, '# Explicit bytes\n\nPersistent original content');
  assert.equal(actual('videos', 'external-md').name, 'Original / source.md', 'lazy migration cannot normalize away original title');
  assert.equal(actual('videos', 'external-md').size, 21, 'source metadata is preserved independently of the explicitly mapped byte stat');
  const receipt = store.db.prepare("SELECT result FROM client_commands WHERE owner_id=? AND json_extract(result,'$.librarySource') IS NOT NULL").get(owner);
  assert.deepEqual(JSON.parse(receipt.result).fileMappings[0].sourceReference, fixture.reference);
  const original = await page.evaluate(async () => { const { default: Dexie } = await import('/node_modules/.vite/deps/dexie.js'); const db = new Dexie('wangke'); await db.open(); try { return { reference: await db.table('courseFiles').get('external-md'), outbox: (await db.table('_cloudOutbox').get('never-replay')).operationId }; } finally { db.close(); } });
  assert.deepEqual(original, { reference: fixture.reference, outbox: 'original-identity' });
  await page.screenshot({ path: path.join(directory, 'complete.png') });
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify({ pass: true, fields: LIBRARY_IMPORT_FIELDS, uploads, mapping, receipt: JSON.parse(receipt.result), original, checks: ['all declared schema fields', 'nested history/checkpoints/widgets/attachments/annotations', 'explicit external file mapping', 'mapping reload', 'server-owned persistent bytes', 'original IDB/outbox immutable', 'preferences', 'server mapping audit'] }, null, 2));
  console.log(`PASS complete legacy schema and explicit file mapping (${directory})`);
} finally { await browser?.close(); await vite?.close(); store?.close(); await api.close(); }
