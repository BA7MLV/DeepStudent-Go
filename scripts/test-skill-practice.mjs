import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { validateWidgetArgs } from '../packages/study-core/src/harness/widget.ts';
import { SERVER_WIDGET_RULE, WIDGET_PRACTICE_RULE } from '../packages/study-core/src/harness/widgetTool.ts';
import { RUNTIME_CAPABILITY_RULE } from '../packages/study-core/src/harness/prompts.ts';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { SystemMaterials } from '../apps/api/src/storage/system-materials.ts';

const skillPath = '../packages/study-core/assets/builtin/interactive-explainer/';
const skill = fs.readFileSync(new URL(`${skillPath}SKILL.md`, import.meta.url), 'utf8');
const practice = fs.readFileSync(new URL(`${skillPath}references/practice.md`, import.meta.url), 'utf8');
const html = practice.match(/```html\n([\s\S]*?)\n```/)[1];
const checked = validateWidgetArgs({ format: 'html', code: html });
assert.ok(checked.ok, JSON.stringify(checked));
assert.equal(checked.args.code, html);
assert.match(skill, /references\/practice\.md/);
for (const rule of [SERVER_WIDGET_RULE, RUNTIME_CAPABILITY_RULE]) assert.ok(rule.includes(WIDGET_PRACTICE_RULE));
for (const boundary of ['AI 参考', '重新练习', 'setWidgetState', 'ask_user', 'answerFeedback']) {
  assert.ok(WIDGET_PRACTICE_RULE.includes(boundary), boundary);
  assert.ok(practice.includes(boundary), boundary);
}
// Fresh accounts can actually read the bundled skill reference through the
// existing system-material API; no new migration or persistent domain required.
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/skill-practice-unit-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system-files'));
try {
  const owner = 'skill-practice-owner';
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const materials = new SystemMaterials(store);
  materials.list(owner, '/system/skills');
  assert.equal(materials.read(owner, '/system/skills/interactive-explainer/references/practice.md').content, practice);
  assert.match(materials.read(owner, '/system/skills/interactive-explainer/SKILL.md').content, /可视化练习/);
  console.log('PASS: executable practice HTML accepted by show_widget; shared server/browser prompt boundaries; actual bundled skill/reference installation and read path.');
} finally { store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
