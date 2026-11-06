/** Screenshot audit regressions: authenticated app + production component gallery.
 * Uses a disposable server/account. No real model requests or user data. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { chromium } from 'playwright';
import { createServer, transformWithEsbuild } from 'vite';
import { fixtureBrowserDomain } from './fixture-domain.mjs';

const temporary = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(temporary, { recursive: true });
const directory = fs.mkdtempSync(path.join(temporary, 'ui-audit-'));
Object.assign(process.env, { NODE_ENV: 'test', CLOUD_WORKER_DISABLED: '1', DATA_DIR: directory,
  FILES_DIR: path.join(directory, 'files'), BOOTSTRAP_SECRET_FILE: path.join(directory, 'secret') });
const { buildServer } = await import('../apps/api/src/server.ts');
const { DatabaseStore } = await import('../apps/api/src/storage/database.ts');
const { CloudRecords } = await import('../apps/api/src/cloud/records.ts');
const app = buildServer({ dbPath: path.join(directory, 'db.sqlite'), fetch: async () => { throw new Error('No model calls allowed'); } });
const gallery = `
import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {MemoryRouter} from 'react-router-dom';
import AppLocaleProvider from '/src/i18n/AppLocaleProvider.tsx';
import i18n from '/src/i18n/index.ts';
import {serverClient} from '/src/api/serverClient.ts';
import {startCloud} from '/src/cloud/sync.ts';
import {Markdown} from '/src/components/markdown/Markdown.tsx';
import {MarkdownPre, MarkdownCode} from '/src/components/mermaid/markdown.tsx';
import ContextUsageButton from '/src/components/ContextUsageButton.tsx';
import MessageComposer from '/src/components/MessageComposer.tsx';
import StudyAssistant from '/src/components/StudyAssistant.tsx';
import CommentsSection from '/src/components/CommentsSection.tsx';
import {ResourceFileIcon} from '/src/components/ResourceFileIcon.tsx';
import {SettingsSaveBar} from '/src/components/settings/SettingsActions.tsx';
import {PluginFrame} from '/src/board/PluginFrame.tsx';
import '/src/theme.css';
import '/src/md-table.css';
import '/src/transitions.css';
window.locale = language => i18n.changeLanguage(language);
function Gallery(){
 const [value,setValue]=useState(''),[open,setOpen]=useState(false),[dirty,setDirty]=useState(false);
 const plugin={id:'audit',revision:'r1',manifest:{name:'Audit frame',height:640}};
 const adapter={identity:'audit',htmlPath:'/audit-frame',context:{mode:'compact'},call:async()=>({})};
 return <main style={{padding:16,maxWidth:720,margin:'auto'}}>
 <Markdown content={'# Heading one\\n\\n## Heading two\\n\\n### Heading three\\n\\nBody text.\\n\\n| Name | Count |\\n| --- | ---: |\\n| Item | 12 |\\n\\n'+String.fromCharCode(96).repeat(3)+'js\\nconst answer = 42;\\n'+String.fromCharCode(96).repeat(3)} components={{pre:MarkdownPre,code:MarkdownCode}} />
 <ContextUsageButton tokens={0} windowTokens={128000} testId="audit-context" />
 <MessageComposer value={value} onChange={setValue} onSubmit={()=>{}} onFiles={()=>{}} onScope={()=>{}} onSettings={()=>{}} ariaLabel="Audit composer" />
 <button data-testid="audit-edit" onClick={()=>setDirty(true)}>Edit</button>
 <SettingsSaveBar dirty={dirty} saveLabel="Save draft" onSave={()=>setDirty(false)} saveTestId="audit-save" statusTestId="audit-status" />
  <PluginFrame plugin={plugin} adapter={adapter} />
  <div data-testid="audit-video-icon"><ResourceFileIcon entry={{projectId:'audit',path:'Video lesson',name:'Video lesson',courseId:'audit-video',kind:'file',revision:'r1'}} /></div>
  <div className="player-layout--assistant"><CommentsSection videoId="audit-video" playerRef={{current:null}} hasSubtitles={false} /></div>
 <StudyAssistant open={open} onOpenChange={setOpen} activeTab="chat" onTabChange={()=>{}} panelKeys={['chat']} panels={{chat:<p>Study panel</p>}} />
 </main>;
}
const session = await serverClient.session();
await startCloud(session.user.id);
createRoot(document.getElementById('root')).render(<AppLocaleProvider><MemoryRouter><Gallery /></MemoryRouter></AppLocaleProvider>);
`;
let web, browser, page, store;
const evidence = { assertions: [], errors: [] };
try {
  const api = await app.listen({ host: '127.0.0.1', port: 0 });
  web = await createServer({ root: path.resolve('apps/web'), configFile: path.resolve('apps/web/vite.config.ts'),
    cacheDir: path.join(directory, 'vite-cache'), plugins: [{
      name: 'audit-gallery',
      resolveId: id => id === '/__audit.jsx' ? '\0audit.jsx' : undefined,
      load: id => id === '\0audit.jsx' ? transformWithEsbuild(gallery, 'audit.jsx', { loader: 'jsx', jsx: 'transform' }) : undefined,
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__audit') return next();
        res.setHeader('content-type', 'text/html'); res.end('<div id="root"></div><script type="module" src="/__audit.jsx"></script>');
      }); },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false,
      proxy: { '/api': { target: api, ws: true, changeOrigin: false } } } });
  await web.listen(); const origin = web.resolvedUrls.local[0].replace(/\/$/, '');
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'zh-CN' });
  const password = 'audit-fixture-password-123';
  assert.equal((await context.request.post(`${origin}/api/v1/bootstrap/initialize`, { headers: {
    'x-bootstrap-secret': fs.readFileSync(process.env.BOOTSTRAP_SECRET_FILE, 'utf8').trim(),
  }, data: { adminPassword: password } })).status(), 201);
  const login = await context.request.post(`${origin}/api/v1/auth/password/login`, { data: { password } });
  assert.equal(login.status(), 200);
  const owner = (await login.json()).user.id;
  store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'files/system-files'));
  const records = new CloudRecords(store);
  page = await context.newPage(); page.on('pageerror', error => evidence.errors.push(error.message));
  await page.goto(origin);
  await page.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  const composer = page.getByRole('textbox', { name: '给 AI 助手发送消息', exact: true });
  assert.equal(await composer.getAttribute('placeholder'), '随便问点什么');
  assert.match(await composer.getAttribute('aria-description'), /Shift/);
  assert.match(await page.getByTestId('chat-context-usage').innerText(), /\d+%/);
  const empty = { id: 987654, videoId: '__library_assistant__', title: 'Empty opened conversation', createdAt: Date.now() };
  records.apply(owner, [{ id: crypto.randomUUID(), table: 'chatSessions', key: empty.id, before: null, after: empty }]);
  await page.waitForFunction(async () => (await import('/src/store/courseChat.ts')).useCourseChat.getState().sessions.some(s => s.id === 987654));
  await page.evaluate(async () => {
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    await useCourseChat.getState().loadSession(987654);
  });
  await page.getByTestId('chat-recent-987654').waitFor();
  assert.equal(await page.getByTestId('top-app-bar').getByText('Empty opened conversation', { exact: true }).count(), 0);
  evidence.assertions.push('desktop composer has keyboard hints; usage is a percentage; opened empty session is in Recent without a misleading welcome title');

  await page.evaluate(() => { location.hash = '/library'; });
  await page.getByTestId('resource-list').waitFor();
  assert.equal(await page.getByTestId('system-folder').count(), 0);
  assert.equal(await page.locator('.finder-tools > button[aria-label="回收站"]').count(), 0);
  await page.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '系统文件', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: '打开回收站', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  evidence.assertions.push('system files and trash are reachable from the menu, not promoted as resources or delete actions');

  await page.evaluate(() => { location.hash = '/settings/models'; });
  await page.getByTestId('cloud-models-save').waitFor();
  assert.equal(await page.getByTestId('cloud-models-save').isDisabled(), true);
  assert.equal(await page.getByTestId('cloud-models-dirty').innerText(), '暂无未保存修改');
  await page.evaluate(() => { location.hash = '/settings/usage'; });
  await page.getByTestId('usage-controls').waitFor();
  // React Aria keeps clipped native controls for browser autofill; only the
  // styled controls should be keyboard-accessible and shown to the user.
  assert.equal(await page.getByTestId('usage-controls').locator('input[type="date"]:not([tabindex="-1"]), select:not([tabindex="-1"])').count(), 0);
  assert.equal(await page.getByText('SQLite', { exact: false }).filter({ visible: true }).count(), 0);
  await page.locator('button[data-slot="select-trigger"][aria-label="来源"]').click();
  await page.getByRole('option', { name: '机器人', exact: true }).click();
  await page.screenshot({ path: path.join(directory, 'usage-desktop.png') });
  evidence.assertions.push('manual save state is explicit; usage uses styled date/select controls and keeps technical details collapsed');

  records.apply(owner, [{ id: crypto.randomUUID(), table: 'videos', key: 'audit-video', before: null, after: { id: 'audit-video', name: 'Video lesson', size: 0, mimeType: 'video/mp4', duration: 60, createdAt: Date.now(), status: 'new', kind: 'video' } }]);
  await fixtureBrowserDomain(context.request, origin, 'resourceCommand', { operationId: crypto.randomUUID(), operation: { kind: 'saveMarkdown', courseId: 'audit-material', name: '手机端资源菜单测试.md', text: '# Audit material', expected: '', createOnly: true } });
  await context.route('**/api/v1/audit-frame', route => route.fulfill({ json: { revision: 'r1', html: '<form><label>Task<textarea id="task"></textarea></label><label>Conversation<select><option>Example</option></select></label><label>Time<input type="datetime-local"></label><label>Repeat<select><option>Once</option></select></label><button type="submit">Create</button></form><p>Scheduled tasks</p>' } }));
  await page.goto(origin + '/__audit');
  await page.getByTestId('audit-context').waitFor();
  const typography = await page.locator('.x-markdown').evaluate(node => {
    const style = tag => getComputedStyle(node.querySelector(tag));
    return { body: parseFloat(style('p').fontSize), h1: parseFloat(style('h1').fontSize), h2: parseFloat(style('h2').fontSize), h3: parseFloat(style('h3').fontSize), weight: Number(style('h2').fontWeight), border: style('table').borderTopWidth, borderColor: style('table').borderTopColor, foreground: style('table').color };
  });
  assert.ok(typography.h1 > typography.h2 && typography.h2 > typography.h3 && typography.h3 > typography.body);
  assert.ok(typography.weight >= 600);
  assert.equal(typography.border, '1px'); assert.notEqual(typography.borderColor, typography.foreground);
  assert.equal(await page.locator('.code-block__source code').textContent(), 'const answer = 42;\n');
  assert.ok(await page.locator('.code-block__source').evaluate(node => parseFloat(getComputedStyle(node).paddingTop) < 8));
  assert.equal(await page.getByTestId('audit-context').innerText(), '0%');
  assert.equal(await page.getByTestId('audit-context').locator('svg.ctx-usage__ring').count(), 0);
  assert.equal(await page.getByTestId('audit-save').isDisabled(), true);
  await page.getByTestId('audit-edit').click(); assert.equal(await page.getByTestId('audit-save').isDisabled(), false);
  await page.getByTestId('audit-save').click(); assert.equal(await page.getByTestId('audit-save').isDisabled(), true);
  const iframe = page.frameLocator('iframe[title="Audit frame"]');
  await iframe.locator('.host-compact-form').waitFor();
  assert.equal(await iframe.locator('textarea').isVisible(), false);
  await iframe.locator('summary').click(); await iframe.locator('textarea').fill('Retained task draft');
  await iframe.locator('summary').click(); await iframe.locator('summary').click();
  assert.equal(await iframe.locator('textarea').inputValue(), 'Retained task draft');
  assert.equal(await iframe.locator('select').first().evaluate(node => getComputedStyle(node).appearance), 'none');
  await page.getByTestId('audit-video-icon').locator('.finder-video').waitFor();
  assert.equal(await page.getByTestId('audit-video-icon').innerText(), 'VIDEO');
  await page.getByTestId('comments-disabled-reason').waitFor();
  assert.equal(await page.getByTestId('comments-generate').isDisabled(), true);
  await page.getByTestId('comments-toggle').click();
  await page.waitForFunction(() => {
    const panel = document.querySelector('[data-testid="comments"] .t-acc-panel');
    return panel?.inert && panel.getBoundingClientRect().height < 1;
  });
  await page.getByTestId('comments-toggle').click();
  await page.getByTestId('comments-disabled-reason').waitFor();
  assert.ok(await page.getByTestId('comments').evaluate(node => parseFloat(getComputedStyle(node).marginBottom) >= 80));
  assert.equal(await page.getByTestId('study-assistant-toggle').innerText(), '学习助手');
  await page.evaluate(() => window.locale('en-US'));
  await page.getByRole('button', { name: 'Add attachment', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Upload images', exact: true }).waitFor();
  await page.getByRole('menuitem', { name: 'Tool scope', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.match(await page.getByRole('textbox', { name: 'Audit composer' }).getAttribute('aria-description'), /Shift/);
  assert.equal(await page.getByTestId('study-assistant-toggle').innerText(), 'Study tools');
  await page.screenshot({ path: path.join(directory, 'gallery-en-desktop.png'), fullPage: true });
  evidence.assertions.push('Markdown heading hierarchy, lighter table borders, compact code spacing, zero-percent indicator, dirty/save transitions, compact iframe form retains drafts, extensionless video icon, discussion disabled reason/disclosure, English attachment menu and assistant labels');

  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'zh-CN', storageState: await context.storageState() });
  const mobilePage = await mobile.newPage(); mobilePage.on('pageerror', error => evidence.errors.push(error.message));
  await mobilePage.goto(origin);
  await mobilePage.getByTestId('course-chat-page').waitFor({ timeout: 60000 });
  assert.match(await mobilePage.locator('textarea').first().getAttribute('placeholder'), /长按/);
  await mobilePage.evaluate(() => { location.hash = '/library'; });
  await mobilePage.getByTestId('resource-list').waitFor();
  const tile = mobilePage.getByTestId('resource-entry').filter({ hasText: '手机端资源菜单测试.md' });
  await tile.waitFor();
  assert.equal(await tile.locator('.resource-more').evaluate(node => getComputedStyle(node).position), 'absolute');
  const fileBox = await tile.locator('.resource-open').boundingBox(), moreBox = await tile.locator('.resource-more').boundingBox();
  assert.ok(moreBox.x + moreBox.width <= fileBox.x + fileBox.width + 1);
  await tile.locator('button.resource-more').click();
  await mobilePage.getByRole('menuitem', { name: '重命名', exact: true }).waitFor();
  await mobilePage.keyboard.press('Escape');
  await mobilePage.getByRole('button', { name: '切换显示方式', exact: true }).click();
  await mobilePage.locator('.resource-grid[data-view="list"]').waitFor();
  assert.equal(await tile.locator('.resource-more').evaluate(node => getComputedStyle(node).position), 'absolute');
  assert.equal(await mobilePage.locator('.resource-window').evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
  await mobilePage.screenshot({ path: path.join(directory, 'library-mobile.png') });
  evidence.assertions.push('touch composer has hold-to-speak hints; mobile resource menu opens in icon/list views without horizontal overflow');
  await mobile.close();
  assert.deepEqual(evidence.errors, []);
  console.log(`PASS UI audit regression checks: ${directory}`);
} catch (error) {
  if (page && !page.isClosed()) { await page.screenshot({ path: path.join(directory, 'failure.png'), fullPage: true }); fs.writeFileSync(path.join(directory, 'failure.html'), await page.content()); }
  console.error('UI audit evidence:', directory); throw error;
} finally {
  fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2));
  await browser?.close(); await web?.close(); store?.close(); await app.close();
}
