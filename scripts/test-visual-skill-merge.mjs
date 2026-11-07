import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { SystemMaterials } from '../apps/api/src/storage/system-materials.ts';
import { BotSkills } from '../apps/api/src/agent/skills.ts';
import { sessionSkills } from '../apps/api/runtime/skills.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/visual-merge-'));
const filename = path.join(directory, 'db.sqlite'), files = path.join(directory, 'files');
let store = new DatabaseStore(filename, files);
const at = new Date().toISOString();
const addOwner = owner => store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, at);
const seed = (owner, table, row) => store.db.prepare('INSERT INTO cloud_records(owner_id,table_name,record_key,value) VALUES(?,?,?,?)')
  .run(owner, table, JSON.stringify(row.id), JSON.stringify(row));
const oldSkill = (id, name, enabled = 1) => ({ id, name, description: '旧版可视化规范', body: `用户修改的 ${name} 正文`, builtin: 1, enabled, updatedAt: 1 });
try {
  const owner = 'old-records'; addOwner(owner);
  seed(owner, 'skills', oldSkill(71, '讲解配图'));
  seed(owner, 'skills', oldSkill(72, '交互式讲解', 0));
  seed(owner, 'skills', { ...oldSkill(73, '讲解配图'), builtin: 0 });
  seed(owner, 'skillRefs', { id: 74, skillId: 71, path: 'references/custom.md', body: '用户自定义的配图规范' });
  seed(owner, 'skillRefs', { id: 75, skillId: 72, path: 'references/explore.md', body: '用户修改的探索参考' });
  let records = new CloudRecords(store);
  let materials = new SystemMaterials(store);
  const physical = store.skillRecords.sync(owner);
  const visual = physical.find(s => s.name === '可视化讲解');
  assert.equal(visual.id, 72, 'the interactive package retains its existing ID');
  assert.equal(visual.enabled, 1, 'either enabled predecessor keeps the unified skill enabled');
  assert.ok(visual.legacyIds.includes(71));
  assert.equal(physical.filter(s => s.name === '交互式讲解').length, 0);
  assert.equal(physical.filter(s => s.name === '讲解配图').length, 1, 'same-name user copy is independent');
  assert.equal(records.get(owner, 'skills', 71), null, 'retired builtin no longer appears in settings');
  assert.equal(records.get(owner, 'skills', 73).body, '用户修改的 讲解配图 正文');
  assert.ok(records.get(owner, 'skills', 72).legacyIds.includes(71));
  const prefix = '/system/skills/interactive-explainer/';
  assert.match(materials.read(owner, `${prefix}references/legacy-diagramming/SKILL.md`).content, /用户修改的 讲解配图 正文/);
  assert.match(materials.read(owner, `${prefix}references/legacy-interactive-explainer/SKILL.md`).content, /用户修改的 交互式讲解 正文/);
  assert.equal(materials.read(owner, `${prefix}references/legacy-diagramming/references/custom.md`).content, '用户自定义的配图规范');
  assert.equal(materials.read(owner, `${prefix}references/explore.md`).content, '用户修改的探索参考');
  assert.match(materials.read(owner, `${prefix}references/static-diagrams.md`).content, /JSON schema/);
  assert.match(materials.read(owner, `${prefix}references/practice.md`).content, /重新练习/);
  const context = { owner, store, records };
  const activation = sessionSkills(context, { skillIds: [71] }, [71, 72]);
  assert.equal(activation.traces.length, 1, 'two old IDs activate one body');
  assert.match(activation.messages[0].content, /可视化讲解/);
  assert.ok(!activation.messages[0].content.includes('用户自定义的配图规范'), 'reference bodies remain lazy');
  const read = activation.wrap(async () => 'downstream');
  assert.match(await read('read', { path: '/skills/讲解配图' }), /可视化讲解/);
  assert.match(await read('read', { path: '/skills/交互式讲解/references/static-diagrams.md' }), /JSON schema/);
  assert.throws(() => sessionSkills(context, { skillIds: [] }, [71]), /不在当前技能范围/);
  for (const [thread, ids] of [['negative-one', [-1]], ['negative-two', [-2]], ['old-positive', [71]]]) {
    store.db.prepare("INSERT INTO threads(id,owner_id,mode,created_at,updated_at,skill_ids) VALUES(?,?,'bot',?,?,?)").run(thread, owner, at, at, JSON.stringify(ids));
    const bot = new BotSkills(store);
    assert.equal(bot.catalog(owner, thread)[0].name, '可视化讲解');
    assert.equal(bot.load(owner, thread, ids[0]).name, '可视化讲解');
  }
  const document = materials.read(owner, `${prefix}SKILL.md`);
  materials.save(owner, document.path, `${document.content}\n合并后的用户修改`, document.content, document.revision);
  store.close(); store = new DatabaseStore(filename, files);
  records = new CloudRecords(store); materials = new SystemMaterials(store);
  assert.match(materials.read(owner, `${prefix}SKILL.md`).content, /合并后的用户修改/);
  assert.equal(store.skillRecords.sync(owner).filter(s => s.name === '可视化讲解').length, 1);
  const cursor = Math.max(...records.list(owner, 0).map(r => r.revision));
  assert.deepEqual(records.list(owner, cursor), [], 'repeat sync does not churn records');
  console.log('PASS: old records merge once, preserve IDs/customizations/references, alias scopes and Bot IDs, lazy activation, restart and stable revisions.');

  for (const mode of ['physical', 'disabled', 'diagram-only']) {
    addOwner(mode);
    if (mode === 'physical') {
      for (const [slug, name] of [['diagramming', '讲解配图'], ['interactive-explainer', '交互式讲解']]) {
        const root = path.join(store.systemSkills.directory(mode), slug);
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, 'SKILL.md'), `---\nname: ${name}\ndescription: Physical installation\n---\n\nShell 自定义正文`);
      }
    } else {
      seed(mode, 'skills', oldSkill(81, '讲解配图', 0));
      if (mode === 'disabled') seed(mode, 'skills', oldSkill(82, '交互式讲解', 0));
    }
    const merged = store.skillRecords.sync(mode);
    assert.equal(merged.filter(s => s.name === '可视化讲解').length, 1);
    assert.equal(merged.filter(s => ['讲解配图', '交互式讲解'].includes(s.name)).length, 0);
    if (mode !== 'physical') {
      assert.equal(merged.find(s => s.name === '可视化讲解').enabled, 0);
      assert.throws(() => sessionSkills({ owner: mode, store, records }, {}, [81]), /已停用/);
    }
  }
  console.log('PASS: existing physical packages, both disabled and single-predecessor upgrades.');
} finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
