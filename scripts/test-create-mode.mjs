import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import 'fake-indexeddb/auto';
import { createServer } from 'vite';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { BotSkills } from '../apps/api/src/agent/skills.ts';
import { notebookTools } from '../apps/api/src/agent/notebook-tools.ts';
import { sessionSkills } from '../apps/api/runtime/skills.ts';
import { executeBoardTool, executePluginsTool } from '../apps/api/runtime/board.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { PluginFiles } from '../apps/api/src/plugins/files.ts';
import { SystemMaterials } from '../apps/api/src/storage/system-materials.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/create-mode-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system-files'));
const web = await createServer({ root: path.resolve('apps/web'), server: { middlewareMode: true, hmr: false }, appType: 'custom' });
const previousWindow = globalThis.window;
globalThis.window = Object.assign(new EventTarget(), { localStorage: { getItem: () => null, setItem() {}, removeItem() {} } });
let db;
try {
  const owner = crypto.randomUUID(), other = crypto.randomUUID(), at = new Date().toISOString();
  for (const id of [owner, other]) store.db.prepare('INSERT INTO users VALUES(?,?,?)').run(id, id, at);
  store.db.prepare("INSERT INTO threads(id,owner_id,mode,created_at,updated_at) VALUES('create-thread',?,'bot',?,?)").run(owner, at, at);
  const records = new CloudRecords(store), materials = new SystemMaterials(store), files = new PluginFiles(store);
  const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
  let deny = false;
  const context = { owner, store, records, task: { id: 'create-test' }, configuration: { taskPolicy: () => ({ read: 'allow', write: deny ? 'deny' : 'allow' }) }, checkActive() {}, pluginService: new PluginService(store) };
  store.skillRecords.sync(owner);
  const snapshot = store.skillRecords.snapshot(owner), skill = [...snapshot.skills.values()].find(s => s.name === '创造模式');
  assert.ok(skill?.enabled);
  const expected = fs.readFileSync('packages/study-core/assets/builtin/create-mode/SKILL.md', 'utf8');
  assert.equal(materials.read(owner, '/system/skills/create-mode/SKILL.md').content, expected);
  const bot = new BotSkills(store);
  assert.ok(bot.catalog(owner, 'create-thread').some(s => s.id === skill.id), 'new builtin not legacy-hidden');
  assert.equal(bot.load(owner, 'create-thread', skill.id).body, skill.body);
  const native = sessionSkills(context, {}, [skill.id]);
  assert.match(JSON.stringify(native.messages), /# 创造模式/);
  assert.ok(!sessionSkills(context, {}).prompt.includes('# 创造模式'), 'discovery is metadata only');
  for (const ref of ['tools-and-layout', 'runtime', 'design']) {
    const resource = `references/${ref}.md`, content = fs.readFileSync(`packages/study-core/assets/builtin/create-mode/${resource}`, 'utf8');
    assert.equal(materials.read(owner, `/system/skills/create-mode/${resource}`).content, content);
    assert.equal(bot.load(owner, 'create-thread', skill.id, resource).body, content);
    assert.equal(await native.wrap(() => { throw new Error('must be a skill read'); })('read', { path: `/skills/创造模式/references/${resource}` }), content);
  }
  const restrict = ids => store.db.prepare("UPDATE threads SET skill_ids=? WHERE id='create-thread'").run(ids === undefined ? null : JSON.stringify(ids));
  restrict([]); assert.deepEqual(bot.catalog(owner, 'create-thread'), []); assert.throws(() => bot.load(owner, 'create-thread', skill.id), /not_available/);
  assert.throws(() => sessionSkills(context, { skillIds: [] }, [skill.id]), /范围/);
  restrict([skill.id]); assert.equal(bot.catalog(owner, 'create-thread').length, 1);
  const update = enabled => { const before = records.get(owner, 'skills', skill.id); records.apply(owner, [{ id: crypto.randomUUID(), table: 'skills', key: skill.id, before, after: { ...before, enabled } }]); };
  update(0); assert.deepEqual(bot.catalog(owner, 'create-thread'), []); assert.throws(() => sessionSkills(context, {}, [skill.id]), /停用/); update(1);
  const otherSkill = store.skillRecords.sync(other).find(s => s.name === '创造模式'); assert.equal(otherSkill.enabled, 1);
  // Actual Bot structured edit and native board recipes from the references.
  const tools = new Map(notebookTools(store).map(t => [t.name, t]));
  const botContext = { owner, thread: 'create-thread', run: 'create-run', checkActive() {} };
  await tools.get('edit').execute({ path: '/system/plugins/bot-counter/views/main.html', create: true, revision: 0, content: '<h1>Bot 工具</h1>' }, botContext);
  const manifest = { apiVersion: 2, id: 'bot-counter', name: 'Bot 工具', version: '1.0.0', enabled: true, capabilities: ['state'], views: { main: { entry: 'views/main.html', surfaces: ['app.page', 'chat.sidepanel'] } } };
  await tools.get('edit').execute({ path: '/system/plugins/bot-counter/manifest.json', create: true, revision: 0, content: JSON.stringify(manifest) }, botContext);
  assert.ok(files.catalog(owner).find(p => p.id === 'bot-counter' && !p.error));
  assert.equal(JSON.parse(executeBoardTool(context, { action: 'read', path: '/system/plugins/bot-counter/views/main.html' })).content, '<h1>Bot 工具</h1>');
  executeBoardTool(context, { action: 'write', path: '/system/plugins/native-counter/views/main.html', content: '<h1>Native 工具</h1>', expected: '', revision: 0 });
  executeBoardTool(context, { action: 'write', path: '/system/plugins/native-counter/manifest.json', content: JSON.stringify({ ...manifest, id: 'native-counter' }), expected: '', revision: 0 });
  assert.ok(files.catalog(owner).find(p => p.id === 'native-counter' && !p.error));
  deny = true;
  assert.throws(() => executeBoardTool(context, { action: 'write', path: '/system/plugins/denied/views/main.html', content: 'bad', expected: '', revision: 0 }), /policy_denied/);
  await assert.rejects(executePluginsTool(context, { operation: 'configure', content: '{}', expected: '', revision: 0 }), /policy_denied/);
  assert.ok(!files.catalog(owner).find(p => p.id === 'denied'));
  assert.equal(records.get(owner, 'settings', 'singleton'), null, 'skill activation never creates settings/permissions');

  // Real browser-store code and actual resource readers, fresh disposable IndexedDB.
  ({ db } = await web.ssrLoadModule('/src/store/db.ts'));
  const { ensureBuiltinSkills, loadEnabledSkillMeta } = await web.ssrLoadModule('/src/skills/store.ts');
  const { activateSkills } = await web.ssrLoadModule('/src/skills/activation.ts');
  const { createResourceExecutor, skillPath } = await web.ssrLoadModule('/src/harness/resources.ts');
  await ensureBuiltinSkills(); const browserSkill = (await loadEnabledSkillMeta()).find(s => s.name === '创造模式'); assert.ok(browserSkill);
  const activated = await activateSkills([browserSkill.id], [browserSkill.id]); assert.match(activated.contents[0], /# 创造模式/);
  const read = createResourceExecutor({ allowedSkillIds: [browserSkill.id] });
  for (const ref of ['tools-and-layout', 'runtime', 'design']) assert.equal((await read('read', { path: `${skillPath('创造模式')}/references/references/${ref}.md` })).trim(), fs.readFileSync(`packages/study-core/assets/builtin/create-mode/references/${ref}.md`, 'utf8').trim());
  await assert.rejects(activateSkills([browserSkill.id], []), /范围/);
  await db.skills.update(browserSkill.id, { enabled: 0 });
  assert.ok(!(await loadEnabledSkillMeta()).find(s => s.id === browserSkill.id)); await assert.rejects(activateSkills([browserSkill.id]), /停用/);
  console.log('Create mode passed: identical Web/native/Bot skill and lazy refs, explicit activation, empty/custom scopes, disabled state, owner isolation, real Bot edit/native board package writes, deny remains deny, no permission grants.');
} finally { await db?.delete(); await web.close(); globalThis.window = previousWindow; store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
