import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

// Execute the shipped template, not a second implementation of its state logic.
const html = fs.readFileSync('docs/plugins/templates/material-note/views/main.html', 'utf8');
const elements = Object.fromEntries(['note', 'save', 'status', 'material'].map(id => [id, { value: '', textContent: '', disabled: true }]));
const listeners = new Map();
let current = { materialId: 'a', revision: 'a:initial' }, data = { notes: { b: 'B 已有笔记' } }, holdWrite;
let getContext = async () => current;
const flush = () => new Promise(resolve => setImmediate(resolve));
const emit = (name, value) => { for (const callback of listeners.get(name) ?? []) callback(value); };
const boot = () => vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1], {
  document: { getElementById: id => elements[id] },
  plugin: {
    context: { get: () => getContext() },
    state: {
      read: async () => ({ data: structuredClone(data), content: JSON.stringify(data), revision: 1 }),
      write: async next => { if (holdWrite) await holdWrite; data = structuredClone(next); },
    },
    events: { subscribe: (name, callback) => { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(callback); return () => listeners.get(name).delete(callback); } },
  },
});
const type = text => { elements.note.value = text; elements.note.oninput(); };
boot(); await flush();
type('A 未提交草稿');
emit('contextChanged', { ...current, revision: 'a:resize', width: 360, theme: 'dark' });
await flush(); assert.equal(elements.note.value, 'A 未提交草稿', 'resize/theme events preserve dirty input');
await elements.save.onclick(); assert.equal(data.notes.a, 'A 未提交草稿');
type('A 保存期间改变尺寸');
let resizeRelease; holdWrite = new Promise(resolve => { resizeRelease = resolve; });
const resizingSave = elements.save.onclick(); await flush();
emit('contextChanged', { ...current, revision: 'a:resize-during-save', width: 420 });
resizeRelease(); await resizingSave; holdWrite = undefined;
assert.equal(elements.status.textContent, '已保存', 'visual context changes do not suppress a completed receipt');
assert.equal(data.notes.a, 'A 保存期间改变尺寸');
emit('dispose'); listeners.clear();
boot(); await flush(); assert.equal(elements.note.value, 'A 保存期间改变尺寸', 'remount reads the committed source');
type('A 迟到保存');
let release; holdWrite = new Promise(resolve => { release = resolve; });
const savingA = elements.save.onclick(); await flush();
current = { materialId: 'b', revision: 'b:initial' }; emit('contextChanged', current); await flush();
assert.equal(elements.note.value, 'B 已有笔记');
type('B 正在编辑'); release(); await savingA; holdWrite = undefined;
assert.equal(data.notes.a, 'A 迟到保存'); assert.equal(data.notes.b, 'B 已有笔记');
assert.equal(elements.note.value, 'B 正在编辑', 'late A save never replaces B input');
await elements.save.onclick(); assert.equal(data.notes.b, 'B 正在编辑');
emit('state.changed'); await flush(); assert.equal(elements.note.value, 'B 正在编辑');
emit('dispose');
listeners.clear();
let resolveInitial; getContext = () => new Promise(resolve => { resolveInitial = resolve; });
boot(); emit('contextChanged', { materialId: 'b', revision: 'b:latest' }); await flush();
resolveInitial({ materialId: 'a', revision: 'a:stale' }); await flush();
assert.equal(elements.note.value, 'B 正在编辑', 'late initial context read cannot override a newer context event');
emit('dispose');
console.log('Shipped material-note template passed: resize/theme draft preservation, remount persistence, delayed A save during B editing and stale initial context rejection.');
