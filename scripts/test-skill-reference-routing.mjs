import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { sessionSkills } from '../apps/api/runtime/skills.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode/skill-reference-routing-'));
const store = new DatabaseStore(path.join(directory, 'db.sqlite'), path.join(directory, 'system-files'));
try {
  const owner = 'reference-routing';
  store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(owner, owner, new Date().toISOString());
  const context = { owner, store, records: new CloudRecords(store) };
  const skills = sessionSkills(context, {});
  const read = skills.wrap(async () => 'downstream');
  const name = encodeURIComponent('可视化讲解');
  const body = await read('read', { path: `/skills/${name}` });
  assert.ok(body.includes(`/skills/${name}/references/practice.md`));
  assert.ok(!body.includes('/references/references/'));
  const expected = fs.readFileSync(new URL('../packages/study-core/assets/builtin/interactive-explainer/references/practice.md', import.meta.url), 'utf8');
  assert.equal(await read('read', { path: `/skills/${name}/references/practice.md` }), expected);
  assert.equal(await read('read', { path: '/skills/交互式讲解/references/practice.md' }), expected);
  const diagrams = fs.readFileSync(new URL('../packages/study-core/assets/builtin/interactive-explainer/references/static-diagrams.md', import.meta.url), 'utf8');
  assert.equal(await read('read', { path: '/skills/讲解配图/references/static-diagrams.md' }), diagrams);
  assert.ok(body.includes(`/skills/${name}/references/static-diagrams.md`));
  assert.match(await read('read', { path: `/skills/${name}/references/missing.md` }), /^Error:/);
  assert.match(await read('read', { path: `/skills/${name}/references/..%2FSKILL.md` }), /^Error:/);
  const restricted = sessionSkills(context, { skillIds: [] }).wrap(async () => 'downstream');
  assert.match(await restricted('read', { path: `/skills/${name}/references/practice.md` }), /不在当前会话范围/);
  assert.equal(await read('read', { path: '/courses/current/material' }), 'downstream');
  console.log('PASS native skill body advertises canonical reference paths; bundled practice is readable by encoded/plain name and remains scope-bound.');
} finally {
  store.close();
  fs.rmSync(directory, { recursive: true, force: true });
}
