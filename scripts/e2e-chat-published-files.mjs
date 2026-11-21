/** Real browser, API, broker and fixed Python reader. Only Docker launch and the model are fixtures. */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode', 'chat-published-'));
const bin = path.join(root, 'bin'), volumes = path.join(root, 'volumes'), filesDir = path.join(root, 'files');
for (const dir of [bin, volumes, filesDir]) fs.mkdirSync(dir);
const hardLimit = 512 * 1024 * 1024;
const token = crypto.randomBytes(32).toString('hex');
const base = net.createServer();
await new Promise(resolve => base.listen(0, '127.0.0.1', resolve));
const port = base.address().port;
await new Promise(resolve => base.close(resolve));
const brokerUrl = `http://127.0.0.1:${port}`;
const orphan = crypto.randomUUID();
for (const name of [`chat-export-${orphan}.bin`, `.upload-chat-export-${orphan}.tmp`]) fs.writeFileSync(path.join(filesDir, name), 'interrupted');
fs.writeFileSync(path.join(bin, 'docker'), `#!${process.execPath}\n` + String.raw`
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const args = process.argv.slice(2), root = process.env.CHAT_PUBLISH_FIXTURE;
if (args[0] === 'image') { console.log('sha256:fixture'); process.exit(0); }
if (args[0] === 'rm') {
  const pid = path.join(root, args.at(-1) + '.pid');
  if (!fs.existsSync(pid)) { console.error('No such container'); process.exit(1); }
  try { process.kill(Number(fs.readFileSync(pid, 'utf8')), 'SIGKILL'); } catch {}
  process.exit(0);
}
const name = args[args.indexOf('--name') + 1];
const mount = args.find(arg => arg.startsWith('type=volume,source='));
if (!mount?.endsWith('target=/workspace,readonly') || args[args.indexOf('--network') + 1] !== 'none' || !args.includes('--log-driver=none') || args.some(arg => arg.includes('target=/system'))) process.exit(3);
const workspace = path.join(root, 'volumes', mount.split(',')[1].slice('source='.length));
const reader = args.indexOf('python3');
if (reader < 0) process.exit(3);
const parts = args.slice(reader + 1);
parts[2] = parts[2].replace("'/workspace'", JSON.stringify(workspace));
const child = spawn('python3', parts, { stdio: 'inherit' });
const pid = path.join(root, name + '.pid');
fs.writeFileSync(pid, String(child.pid));
child.on('close', code => {
  const finish = () => { fs.rmSync(pid, { force: true }); process.exit(code === 0 && parts[3] === 'failed.bin' ? 3 : code ?? 137); };
  if (code === 0 && parts[3] === 'held.bin') {
    fs.writeFileSync(path.join(root, 'held-read'), '');
    const timer = setInterval(() => { if (fs.existsSync(path.join(root, 'release-held'))) { clearInterval(timer); finish(); } }, 10);
    return;
  }
  finish();
});
`, { mode: 0o700 });

Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: root, FILES_DIR: filesDir, MAX_FILE_BYTES: String(hardLimit),
  BOOTSTRAP_SECRET_FILE: path.join(root, 'secret'), SANDBOX_URL: brokerUrl, SANDBOX_TOKEN: token });
delete process.env.CLOUD_WORKER_DISABLED;
const broker = spawn(process.execPath, ['infra/sandbox/broker.mjs'], { env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', PATH: `${bin}${path.delimiter}${process.env.PATH}`, CHAT_PUBLISH_FIXTURE: root }, stdio: ['ignore', 'pipe', 'pipe'] });
let brokerErrors = '';
broker.stdout.resume(); broker.stderr.on('data', chunk => { brokerErrors += String(chunk); });
const dbPath = path.join(root, 'db.sqlite');
const { buildServer } = await import('../apps/api/src/server.ts');
const { chatShellWorkspace } = await import('../apps/api/runtime/chat-shell.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const fileName = "成品 (512 MiB)'样例.bin";
const receipts = new Map();
const app = buildServer({ dbPath, fetch: async (_, init) => {
  const body = JSON.parse(init.body);
  const lastUser = body.messages.findLastIndex(message => message.role === 'user');
  const text = body.messages[lastUser]?.content;
  if (typeof text !== 'string' || !text.startsWith('publish:')) return model({ content: '测试会话' });
  const receipt = body.messages.slice(lastUser + 1).find(message => message.role === 'tool' && message.name === 'chat_publish_file');
  if (receipt) {
    receipts.set(text, receipt.content);
    assert.ok(receipt.content.length < 2000);
    return model({ content: receipt.content.includes('"published":true') ? '附件已交付。' : '文件未发布。' });
  }
  assert.ok(body.tools.some(tool => tool.function.name === 'chat_publish_file'));
  const target = text === 'publish:limit' ? fileName : text.slice('publish:'.length);
  return model({ content: '', tool_calls: [{ id: crypto.randomUUID(), type: 'function', function: { name: 'chat_publish_file', arguments: JSON.stringify({ path: target }) } }] }, 'tool_calls');
} });
function model(fields, finish_reason = 'stop') { return Response.json({ choices: [{ message: { role: 'assistant', ...fields }, finish_reason }] }); }
async function until(check, message) {
  for (let i = 0; i < 400; i++) { if (await check()) return; await delay(25); }
  throw new Error(message);
}
async function sha256(filename) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
let web, browser, page, store;
try {
  await until(async () => { try { return (await fetch(brokerUrl + '/health')).ok; } catch { return false; } }, 'broker unavailable');
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'), cacheDir: path.join(root, 'vite-cache'),
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false, proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen();
  const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ locale: 'zh-CN' });
  const password = crypto.randomBytes(24).toString('hex');
  assert.equal((await context.request.post(origin + '/api/v1/bootstrap/initialize', { headers: { 'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim() }, data: { adminPassword: password } })).status(), 201);
  const login = await context.request.post(origin + '/api/v1/auth/password/login', { data: { password } });
  const owner = (await login.json()).user.id;
  async function policy(read, write) {
    const config = await (await context.request.get(origin + '/api/v1/cloud/config')).json();
    const response = await context.request.put(origin + '/api/v1/cloud/config', { data: { ...config,
      providers: [{ id: 'fixture', name: 'Model', protocol: 'openai-chat', baseUrl: 'https://model.invalid/v1', apiKey: 'fixture', serves: ['chat'], catalogId: '' }],
      llmModel: { providerId: 'fixture', model: 'gpt-4.1' }, policy: { ...config.policy, read, write, maxSteps: 8 } } });
    assert.equal(response.status(), 200);
  }
  await policy('allow', 'ask');
  store = new DatabaseStore(dbPath, path.join(filesDir, 'system-files'));
  page = await context.newPage(); page.setDefaultTimeout(45000);
  await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
  await page.route('https://model.invalid/**', route => route.abort());
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 90000 });
  const send = async target => {
    const input = page.getByRole('textbox', { name: '给 AI 助手发送消息' });
    await input.fill(`publish:${target}`); await input.press('Enter');
  };
  await send('limit');
  const approval = page.getByTestId('chat-publish-approval');
  await approval.waitFor();
  const sessionId = await page.evaluate(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().activeId);
  assert.ok(Number.isSafeInteger(sessionId) && sessionId > 0);
  const threadId = chatShellWorkspace(owner, sessionId), workspace = path.join(volumes, `wangke-workspace-${threadId}`);
  fs.mkdirSync(workspace);
  const source = path.join(workspace, fileName);
  const fd = fs.openSync(source, 'wx'); fs.ftruncateSync(fd, hardLimit);
  fs.writeSync(fd, Buffer.from('tail!'), 0, 5, hardLimit - 5); fs.closeSync(fd);
  fs.closeSync(fs.openSync(path.join(workspace, 'oversize.bin'), 'wx')); fs.truncateSync(path.join(workspace, 'oversize.bin'), hardLimit + 1);
  for (const file of ['failed.bin', 'held.bin']) fs.writeFileSync(path.join(workspace, file), 'complete bytes');
  fs.symlinkSync(path.join(workspace, 'failed.bin'), path.join(workspace, 'link.bin'));
  const fileCount = () => store.db.prepare("SELECT count(*) AS count FROM files WHERE storage_name GLOB 'chat-export-*.bin'").get().count;
  const stopped = () => page.getByTestId('chat-stop').waitFor({ state: 'detached' });
  const downloadLink = () => page.getByRole('link', { name: `下载附件 ${fileName}`, exact: true });
  assert.match(await approval.innerText(), /512 MiB/); assert.equal(fileCount(), 0);
  await approval.getByTestId('chat-shell-approve').click();
  await downloadLink().waitFor(); await stopped();
  assert.equal(fileCount(), 1); assert.equal(JSON.parse(receipts.get('publish:limit')).sizeBytes, hardLimit);
  assert.equal(fs.existsSync(path.join(filesDir, `chat-export-${orphan}.bin`)), false);
  const fileUrl = new URL(await downloadLink().getAttribute('href'), origin).href;
  const partial = await context.request.get(fileUrl, { headers: { range: `bytes=${hardLimit - 5}-` } });
  assert.equal(partial.status(), 206); assert.equal(await partial.text(), 'tail!');
  const resumed = await context.request.get(fileUrl, { headers: { range: 'bytes=-5', 'if-range': partial.headers().etag } });
  assert.equal(resumed.status(), 206); assert.equal(await resumed.text(), 'tail!');
  const publicAttempt = await fetch(fileUrl, { headers: { range: 'bytes=0-4', 'if-none-match': partial.headers().etag } });
  assert.equal(publicAttempt.status, 401); await publicAttempt.body.cancel();
  const fileId = fileUrl.split('/').at(-1);
  const other = crypto.randomUUID();
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(other, 'Other', new Date().toISOString());
  store.db.prepare('UPDATE files SET owner_id=? WHERE id=?').run(other, fileId);
  assert.equal((await context.request.get(fileUrl, { headers: { range: 'bytes=0-4' } })).status(), 404);
  store.db.prepare('UPDATE files SET owner_id=? WHERE id=?').run(owner, fileId);
  assert.equal((await context.request.delete(fileUrl)).status(), 409);
  const originalHash = await sha256(source);
  fs.writeFileSync(source, 'modified in workspace');
  await page.reload(); await downloadLink().waitFor();
  let fetchedByPage = false;
  page.on('request', request => { if (request.url() === fileUrl && ['fetch', 'xhr'].includes(request.resourceType())) fetchedByPage = true; });
  const [download] = await Promise.all([page.waitForEvent('download'), downloadLink().click()]);
  assert.equal(download.suggestedFilename(), fileName);
  const downloadedPath = await download.path();
  assert.equal(fs.statSync(downloadedPath).size, hardLimit);
  assert.equal(await sha256(downloadedPath), originalHash);
  assert.equal(fetchedByPage, false);

  await policy('allow', 'allow');
  await send('limit');
  await stopped();
  await until(() => fileCount() === 2, 'modified file not published as a new version');
  await page.getByRole('link', { name: `下载附件 ${fileName}`, exact: true }).nth(1).waitFor();
  const newUrl = new URL(await downloadLink().nth(1).getAttribute('href'), origin).href;
  assert.notEqual(newUrl, fileUrl);
  const replaced = await context.request.get(newUrl, { headers: { range: 'bytes=0-4', 'if-range': partial.headers().etag } });
  assert.equal(replaced.status(), 200); assert.equal(await replaced.text(), 'modified in workspace');
  for (const [name, error] of [['oversize.bin', /workspace_file_too_large_or_empty/], ['link.bin', /workspace_file_unavailable/], ['failed.bin', /terminated|fetch failed|workspace_file_unavailable/]]) {
    await send(name); await until(() => receipts.has(`publish:${name}`), `missing broker error for ${name}`); await stopped();
    assert.match(receipts.get(`publish:${name}`), error); assert.equal(fileCount(), 2);
  }
  await send('held.bin');
  await until(() => fs.existsSync(path.join(root, 'held-read')), 'fixture did not finish sending bytes');
  assert.equal(fileCount(), 2, 'all bytes without broker completion are not a published file');
  assert.equal(await page.getByRole('link', { name: '下载附件 held.bin', exact: true }).count(), 0);
  await page.getByTestId('chat-stop').click(); await stopped();
  fs.writeFileSync(path.join(root, 'release-held'), '');
  await until(() => fs.readdirSync(filesDir).every(name => !name.startsWith('.upload-chat-export-')), 'failed/cancelled export left temporary bytes');
  assert.equal(fileCount(), 2);
  assert.equal(await page.getByRole('link', { name: '下载附件 held.bin', exact: true }).count(), 0);
  await policy('allow', 'deny');
  await send('failed.bin'); await until(() => receipts.get('publish:failed.bin')?.includes('chat_publish_permission_denied'), 'explicit write deny ignored'); await stopped();
  assert.equal(fileCount(), 2);
  console.log('PASS Chat published files: 512 MiB native download with exact bytes, 512 MiB + 1 rejection, approval, authorized resume, owner checks, immutable history, symlink rejection, failed/cancelled transfer and staging cleanup.');
} catch (error) {
  if (page) await page.screenshot({ path: path.join(root, 'failure.png'), fullPage: true }).catch(() => {});
  if (brokerErrors) console.error(brokerErrors);
  console.error(`Test evidence: ${root}`);
  throw error;
} finally {
  await browser?.close(); await web?.close(); store?.close(); await app.close();
  if (broker.exitCode === null && broker.signalCode === null) { const closed = once(broker, 'exit'); broker.kill(); await closed; }
}
fs.rmSync(root, { recursive: true, force: true });
