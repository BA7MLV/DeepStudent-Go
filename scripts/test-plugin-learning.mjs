import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { DatabaseStore } from '../apps/api/src/storage/database.ts';
import { CloudRecords } from '../apps/api/src/cloud/records.ts';
import { CloudConfiguration } from '../apps/api/src/cloud/config.ts';
import { CloudTaskRunner } from '../apps/api/src/cloud/tasks.ts';
import { PluginService } from '../apps/api/src/plugins/service.ts';
import { reconcileLearningResults } from '../apps/api/src/plugins/learning-results.ts';
import { receiveFile } from '../apps/api/src/cloud/files.ts';
import { EMPTY_WRONGBOOK, applyAttempt, writeQuestion, parseWrongbook } from '../packages/study-core/src/study/wrongbook.ts';
import { readLearningMarkdown } from '../apps/api/src/plugins/learning-files.ts';
import { ProjectRepository } from '../apps/api/src/projects/repository.ts';
import { ResourceFiles } from '../apps/api/src/projects/resources.ts';
import { ClientRuntimeDomain } from '../apps/api/src/realtime/domain.ts';
import { pluginTool } from '../apps/api/src/plugins/tool.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-learning-'));
const dbPath = path.join(directory, 'db.sqlite'), systemRoot = path.join(directory, 'system');
const filesDir = path.join(directory, 'files'); fs.mkdirSync(filesDir);
let store = new DatabaseStore(dbPath, systemRoot), service = new PluginService(store, undefined, undefined, { filesDir });
const owner = crypto.randomUUID(), other = crypto.randomUUID();
for (const id of [owner, other]) store.db.prepare('INSERT INTO users(id,name,created_at) VALUES(?,?,?)').run(id, id, new Date().toISOString());
let records = new CloudRecords(store);
const put = (table, key, value, user = owner) => records.apply(user, [{ id: crypto.randomUUID(), table, key, before: records.get(user, table, key), after: value }]);
const configuration = new CloudConfiguration(store, path.join(directory, 'config'));
configuration.save(owner, { ...configuration.get(owner), providers: [{ id: 'fixture', name: 'fixture', protocol: 'openai-chat', apiKey: 'fixture', baseUrl: 'https://fixture.example/v1', catalogId: '', serves: ['chat'] }], llmModel: { providerId: 'fixture', model: 'fixture-model' } });
let duringGeneration = () => {};
const runner = new CloudTaskRunner(store, { configuration, records, filesDir: path.join(directory, 'files'), fetch: async () => {
  duringGeneration(); duringGeneration = () => {};
  return Response.json({ choices: [{ message: { role: 'assistant', content: '[{"time":"00:10","q":"什么是闭环？","a":"实际产物持久保存。"}]' } }] });
} });
const invoke = (instance, method, args = {}, user = owner, plugin = 'flashcards') => service.invoke(user, plugin, instance, 1, method, args);
async function ended(id) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const row = store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(id);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(row.status)) return row;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('task_timeout');
}
try {
  put('videos', 'a', { id: 'a', name: '资料 A', kind: 'material' });
  put('videos', 'b', { id: 'b', name: '资料 B' });
  put('materialBlocks', 1, { id: 1, materialId: 'a', idx: 0, text: '这是已解析的资料，足够生成三段输入和真实卡片。' });
  put('cards', 11, { id: 11, videoId: 'b', q: 'B', a: '不允许访问', status: 0 });
  const current = service.files.layout(owner), layout = JSON.parse(current.content);
  layout.instances.push({ id: 'cards-a', pluginId: 'flashcards', scope: { kind: 'material', id: 'a' } }, { id: 'cards-account', pluginId: 'flashcards', scope: { kind: 'account' } });
  service.files.save(owner, current.path, JSON.stringify(layout), current.content, current.revision);
  assert.equal(invoke('cards-a', 'learning.materials').materials.length, 1);
  assert.throws(() => invoke('cards-a', 'cards.list', { materialId: 'b' }), /denied/);
  assert.throws(() => invoke('cards-a', 'cards.list', {}, other), /not_found/);
  assert.throws(() => invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'x', owner }), /invalid_plugin_arguments/);
  const started = invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'first' });
  assert.equal(invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'first' }).id, started.id);
  assert.throws(() => invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'first', replaceRevision: 'a'.repeat(64) }), /nonce_conflict/);
  assert.throws(() => invoke('cards-account', 'cards.generate', { materialId: 'a', clientNonce: 'other-instance' }), /generation_conflict/);
  runner.start('http://127.0.0.1:1');
  assert.equal((await ended(started.id)).status, 'completed');
  const cards = invoke('cards-a', 'cards.list'); assert.equal(cards.cards.length, 1);
  assert.equal(cards.cards[0].q, '什么是闭环？');
  // Crash window: artifacts committed, no UI is mounted, delivery has not run.
  store.db.prepare('UPDATE plugin_learning_tasks SET delivered_at=NULL,result=NULL WHERE task_id=?').run(started.id);
  await service.close(); await runner.close(); store.close();
  store = new DatabaseStore(dbPath, systemRoot); records = new CloudRecords(store); service = new PluginService(store, undefined, undefined, { filesDir });
  const result = invoke('cards-a', 'learning.results').tasks[0];
  assert.deepEqual(result.artifacts.cardIds, cards.cards.map(c => c.id));
  assert.ok(result.deliveredAt); assert.equal(result.origin.contextRef.materialId, 'a');
  reconcileLearningResults(store); reconcileLearningResults(store);
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM plugin_learning_receipts WHERE task_id=?').get(started.id).n, 1);
  assert.equal(invoke('cards-account', 'learning.results', { materialId: 'a' }).tasks.length, 0, 'task projections are instance scoped');
  invoke('cards-a', 'cards.update', { materialId: 'a', id: cards.cards[0].id, expected: 0, status: 1 });
  assert.equal(records.get(owner, 'cards', cards.cards[0].id).status, 1, 'the existing domain record is updated');
  assert.throws(() => invoke('cards-a', 'cards.update', { materialId: 'a', id: 11, expected: 0, status: 1 }), /denied/);
  assert.throws(() => invoke('cards-a', 'cards.update', { materialId: 'a', id: cards.cards[0].id, expected: 0, status: 2 }), /sync_conflict/);
  assert.throws(() => invoke('cards-a', 'cards.update', { materialId: 'a', id: cards.cards[0].id, status: 2 }), /invalid_plugin_arguments/);
  // The panel, plugin and Bot must agree about the user's original baseline.
  const domain = new ClientRuntimeDomain(store, service);
  try {
    const cardId = cards.cards[0].id;
    const edit = { operationId: crypto.randomUUID(), edits: [{ kind: 'reviewCard', courseId: 'a', cardId, expected: 0, status: 2, mutationId: crypto.randomUUID() }] };
    await assert.rejects(domain.editLearning(owner, edit), error => error.code === 'client/record-conflict');
    edit.edits[0].expected = 1;
    const receipt = await domain.editLearning(owner, edit);
    const bot = pluginTool(service);
    const args = { operation: 'invoke', pluginId: 'flashcards', instanceId: 'cards-a', revision: 1, actionId: 'update', args: { materialId: 'a', id: cardId, expected: 1, status: 1 } };
    await assert.rejects(bot.execute(args, { owner, checkActive() {} }), /sync_conflict/);
    args.args.expected = 2;
    await bot.execute(args, { owner, checkActive() {} });
    assert.equal(records.get(owner, 'cards', cardId).status, 1);
    assert.deepEqual(await domain.editLearning(owner, edit), receipt, 'lost panel reply uses original receipt');
    assert.equal(records.get(owner, 'cards', cardId).status, 1, 'receipt replay must not undo a later Bot review');
    await assert.rejects(domain.editLearning(other, { ...edit, operationId: crypto.randomUUID() }), /Domain request failed/);
    await assert.rejects(domain.editLearning(owner, { ...edit, operationId: crypto.randomUUID(), edits: [{ ...edit.edits[0], courseId: 'b' }] }), /Domain request failed/);
    const command = { pluginId: 'flashcards', instanceId: 'cards-a', revision: 1, method: 'cards.update', args: { materialId: 'a', id: cardId, expected: 1, status: 2 }, operationId: crypto.randomUUID() };
    const pluginReceipt = await domain.command(owner, command);
    await bot.execute(args, { owner, checkActive() {} });
    assert.deepEqual(await domain.command(owner, command), pluginReceipt, 'lost plugin reply uses original receipt');
    assert.equal(records.get(owner, 'cards', cardId).status, 1);
  } finally { domain.close(); }
  assert.throws(() => invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'overwrite' }), /replace_conflict/);
  assert.throws(() => invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'stale', replaceRevision: cards.revision }), /replace_conflict/);
  const reviewed = invoke('cards-a', 'cards.list');
  const regeneration = invoke('cards-a', 'cards.generate', { materialId: 'a', clientNonce: 'confirmed', replaceRevision: reviewed.revision });
  // Simulate a card reviewed on another surface while the model is working.
  const nextRunner = new CloudTaskRunner(store, { configuration: new CloudConfiguration(store, path.join(directory, 'config')), records, fetch: async () => {
    put('cards', reviewed.cards[0].id, { ...reviewed.cards[0], status: 2 });
    return Response.json({ choices: [{ message: { content: '[{"time":"00:10","q":"new","a":"new"}]' } }] });
  } });
  nextRunner.start('http://127.0.0.1:1');
  try {
    const failed = await ended(regeneration.id); assert.equal(failed.status, 'failed'); assert.equal(failed.error, 'plugin_cards_replace_conflict');
    assert.equal(invoke('cards-a', 'cards.list').cards[0].q, reviewed.cards[0].q);
    assert.equal(invoke('cards-a', 'cards.list').cards[0].status, 2, 'concurrent reviews survive rejected regeneration');
  } finally { await nextRunner.close(); }
  const question = { stem: '原错题本中的真实题目', options: ['甲', '乙', '丙', '丁'], answer: 0, explanation: '原答案', answerSource: 'original' };
  const attempt = { id: 'attempt-real', at: new Date(Date.now() - 86400000).toISOString(), answer: 1, correct: false, durationSeconds: 8, rating: 1 };
  const entry = applyAttempt(undefined, 'original-question', question, { courseId: 'a', name: '资料 A' }, attempt);
  const unrelated = applyAttempt(undefined, 'other-question', question, { courseId: 'b' }, { ...attempt, id: 'other' });
  const markdown = writeQuestion(writeQuestion(EMPTY_WRONGBOOK, entry), unrelated), bytes = Buffer.from(markdown);
  const file = await receiveFile(store, filesDir, owner, Readable.from([bytes]), 'wrongbook.md', 'text/markdown', bytes.length, bytes.length);
  put('videos', 'wrongbook.md', { id: 'wrongbook.md', name: 'wrongbook.md', kind: 'material', materialFormat: 'md' });
  put('files', 'wrongbook.md', { id: 'wrongbook.md', blob: { $file: file.id } });
  const reviewLayout = service.files.layout(owner), withReview = JSON.parse(reviewLayout.content);
  withReview.instances.push({ id: 'review-a', pluginId: 'review', scope: { kind: 'material', id: 'a' } });
  service.files.save(owner, reviewLayout.path, JSON.stringify(withReview), reviewLayout.content, reviewLayout.revision);
  const review = invoke('review-a', 'review.list', {}, owner, 'review');
  assert.equal(review.due, 1); assert.equal(review.questions.length, 1); assert.equal(review.questions[0].attempts, 1);
  assert.equal(review.cards.total, 1); assert.equal(review.notebookMaterialId, 'wrongbook.md');
  assert.equal(review.questions[0].answer, undefined, 'list projections do not expose answer keys');
  assert.throws(() => invoke('review-a', 'review.list', { materialId: 'b' }, owner, 'review'), /denied/);
  assert.equal(records.get(owner, 'files', 'wrongbook.md').blob.$file, file.id, 'reading the review does not fork the notebook');
  const bankId = '__course_questions__a';
  const bankQuestion = { ...question, stem: '原题练习快照', source: { courseId: 'a', page: 3 } };
  const bankText = `# 实际题库\n\n\`\`\`quiz\n${JSON.stringify({ questions: [bankQuestion] })}\n\`\`\`\n`;
  const bankBytes = Buffer.from(bankText), bankFile = await receiveFile(store, filesDir, owner, Readable.from([bankBytes]), 'questions.md', 'text/markdown', bankBytes.length, bankBytes.length);
  put('videos', bankId, { id: bankId, name: '原题题库.md', kind: 'material', materialFormat: 'md' });
  put('files', bankId, { id: bankId, blob: { $file: bankFile.id } });
  const practiceLayout = service.files.layout(owner), withPractice = JSON.parse(practiceLayout.content);
  withPractice.instances.push({ id: 'practice-a', pluginId: 'practice', scope: { kind: 'material', id: 'a' } });
  service.files.save(owner, practiceLayout.path, JSON.stringify(withPractice), practiceLayout.content, practiceLayout.revision);
  const practice = (method, args = {}) => invoke('practice-a', method, args, owner, 'practice');
  const original = practice('practice.present', { materialId: 'a', clientNonce: 'original' });
  assert.equal(practice('practice.present', { materialId: 'a', clientNonce: 'original' }).rowId, original.rowId);
  assert.throws(() => practice('practice.present', { materialId: 'a', clientNonce: 'original', limit: 1 }), /nonce_conflict/);
  const snapshot = practice('practice.get', { rowId: original.rowId }).row;
  assert.equal(snapshot.quiz.data.bank.path, '/courses/a/questions.md'); assert.equal(snapshot.quiz.data.questions[0].answerSource, 'original');
  assert.equal(snapshot.quiz.data.questions[0].source.page, 3);
  assert.equal(practice('practice.list').practices.length, 1);
  assert.throws(() => practice('practice.get', { rowId: original.rowId + 1 }), /not_found/);
  const submitArgs = { rowId: original.rowId, questionIndex: 0, pick: 1, durationSeconds: 7 };
  practice('practice.submit', submitArgs); practice('practice.submit', submitArgs);
  assert.throws(() => practice('practice.submit', { ...submitArgs, pick: 0 }), /submission_conflict/);
  assert.throws(() => practice('practice.submit', { ...submitArgs, pick: { answer: 1, selfGrade: true } }), /submission_conflict/);
  const changedBank = Buffer.from(bankText.replace('原题练习快照', '后来修改的题干'));
  const changedBankFile = await receiveFile(store, filesDir, owner, Readable.from([changedBank]), 'questions.md', 'text/markdown', changedBank.length, changedBank.length);
  put('files', bankId, { id: bankId, blob: { $file: changedBankFile.id } });
  assert.equal(practice('practice.get', { rowId: original.rowId }).row.quiz.data.questions[0].stem, '原题练习快照', 'historical snapshot is not regraded from an edited bank');
  // Persisted submission delivery runs without a mounted view, and replay is idempotent.
   const waitForDelivery = async (rowId = original.rowId, questionIndex = 0) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
       const pending = store.db.prepare('SELECT * FROM plugin_practice_submissions WHERE row_id=? AND question_index=?').get(rowId, questionIndex);
       if (pending?.delivered_at) return pending;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('notebook_delivery_timeout');
  };
  const delivered = await waitForDelivery();
  const notebookAfter = parseWrongbook(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md').text);
  const practiceEntry = notebookAfter.find(q => q.question.stem === bankQuestion.stem);
  assert.equal(practiceEntry.attempts.length, 1); assert.equal(practiceEntry.source.courseId, 'a');
  await service.close();
  store.db.prepare('UPDATE plugin_practice_submissions SET delivered_at=NULL WHERE id=?').run(delivered.id);
  service = new PluginService(store, undefined, undefined, { filesDir });
  await waitForDelivery();
   assert.equal(parseWrongbook(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md').text).find(q => q.id === practiceEntry.id).attempts.length, 1, 'restart replay never duplicates an attempt');
   const reviewAction = (method, args) => invoke('review-a', method, args, owner, 'review');
   assert.throws(() => reviewAction('review.present', { materialId: 'a', questionId: unrelated.id, clientNonce: 'foreign' }), /not_found/);
   const reviewArgs = { materialId: 'a', questionId: practiceEntry.id, clientNonce: 'review-once' };
   const reviewSession = reviewAction('review.present', reviewArgs);
   assert.equal(reviewAction('review.present', reviewArgs).rowId, reviewSession.rowId);
   assert.throws(() => reviewAction('review.present', { ...reviewArgs, questionId: entry.id }), /nonce_conflict/);
   assert.throws(() => practice('practice.get', { rowId: reviewSession.rowId }), /not_found/, 'a different plugin cannot read a review snapshot');
   const reviewPick = { rowId: reviewSession.rowId, questionIndex: 0, pick: 0, durationSeconds: 4 };
   reviewAction('practice.submit', reviewPick); reviewAction('practice.submit', reviewPick);
   await waitForDelivery(reviewSession.rowId);
   const reviewedEntry = parseWrongbook(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md').text).find(q => q.id === practiceEntry.id);
   assert.equal(reviewedEntry.attempts.length, 2, 'review appends once to the original question identity');
   assert.equal(reviewedEntry.attempts[1].correct, true);
   assert.equal(reviewedEntry.attempts[0].id, practiceEntry.attempts[0].id);
   assert.equal(parseWrongbook(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md').text).find(q => q.id === unrelated.id).attempts.length, 1, 'another material is unchanged');
   const subjective = { type: 'freeform', stem: '解释 $x^2$ 的含义', options: [], answer: 'x 与自身相乘', explanation: '参照原文自评', answerSource: 'original', source: { courseId: 'a' }, presentation: { html: '<textarea aria-label="作答"></textarea>' } };
   const missing = { ...subjective, stem: '缺少答案的开放题', answer: -1, answerSource: 'missing' };
   const multi = { ...bankQuestion, type: 'multiple', stem: '多选原题', answer: [0, 2] };
   const mixedBytes = Buffer.from(`\`\`\`quiz\n${JSON.stringify({ questions: [subjective, missing, multi] })}\n\`\`\`\n`);
   const mixedFile = await receiveFile(store, filesDir, owner, Readable.from([mixedBytes]), 'questions.md', 'text/markdown', mixedBytes.length, mixedBytes.length);
   put('files', bankId, { id: bankId, blob: { $file: mixedFile.id } });
   const mixed = practice('practice.present', { materialId: 'a', clientNonce: 'mixed' });
   const subjectivePick = { rowId: mixed.rowId, questionIndex: 0, pick: { answer: '我的推导' }, durationSeconds: 9 };
   assert.throws(() => practice('practice.submit', { ...subjectivePick, pick: { answer: '我的推导', selfGrade: true } }), /submission_conflict/, 'self-check is only allowed after an initial answer');
   practice('practice.submit', subjectivePick);
   assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM plugin_practice_submissions WHERE row_id=? AND question_index>=0').get(mixed.rowId).n, 0, 'an ungraded response is not incorrect');
   const selfCheck = { ...subjectivePick, pick: { answer: '我的推导', selfGrade: false } };
   practice('practice.submit', selfCheck); practice('practice.submit', selfCheck);
   assert.throws(() => practice('practice.submit', { ...selfCheck, pick: { answer: '改写答案', selfGrade: false } }), /submission_conflict/);
   assert.throws(() => practice('practice.submit', { ...selfCheck, pick: { answer: '我的推导', selfGrade: true } }), /submission_conflict/);
   await waitForDelivery(mixed.rowId);
   assert.equal(practice('practice.get', { rowId: mixed.rowId }).row.quiz.attempts[0].grading, 'self');
   practice('practice.submit', { rowId: mixed.rowId, questionIndex: 1, pick: { answer: '没有核验依据' }, durationSeconds: 2 });
   assert.throws(() => practice('practice.submit', { rowId: mixed.rowId, questionIndex: 1, pick: { answer: '没有核验依据', selfGrade: true }, durationSeconds: 2 }), /submission_conflict/);
   practice('practice.submit', { rowId: mixed.rowId, questionIndex: 2, pick: { answer: [2, 0] }, durationSeconds: 3 });
   await waitForDelivery(mixed.rowId, 2);
   assert.equal(practice('practice.get', { rowId: mixed.rowId }).row.quiz.attempts[2].correct, true, 'multiple-choice order does not affect grading');
  const aiTask = practice('practice.generate', { materialId: 'a', clientNonce: 'ai', count: 1 });
  const aiRunner = new CloudTaskRunner(store, { configuration: new CloudConfiguration(store, path.join(directory, 'config')), records, fetch: async () => Response.json({ choices: [{ message: { content: JSON.stringify({ questions: [{ ...bankQuestion, answerSource: 'verified' }] }) } }] }) });
  aiRunner.start('http://127.0.0.1:1');
  try {
    const generatedTask = await ended(aiTask.id); assert.equal(generatedTask.status, 'completed', generatedTask.error);
    const receipt = JSON.parse(store.db.prepare('SELECT artifacts FROM plugin_learning_receipts WHERE task_id=?').get(aiTask.id).artifacts);
    const generated = practice('practice.get', { rowId: receipt.rowId }).row;
    assert.equal(generated.quiz.data.questions[0].answerSource, 'ai', 'the model cannot promote its answers to verified');
    practice('practice.submit', { rowId: receipt.rowId, questionIndex: 0, pick: { answer: 1 }, durationSeconds: 3 });
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM plugin_practice_submissions WHERE row_id=?').get(receipt.rowId).n, 0, 'unverified AI answers do not enter FSRS or wrongbook');
   } finally { await aiRunner.close(); }
    // Imported Markdown banks are used at /material, not shadowed by a generated
    // questions.md. Their immutable snapshots retain the original file revision.
    put('videos', 'a', { ...records.get(owner, 'videos', 'a'), materialFormat: 'md' });
    put('files', 'a', { id: 'a', blob: { $file: bankFile.id } });
    const imported = practice('practice.present', { materialId: 'a', clientNonce: 'imported-md' });
    const importedSnapshot = practice('practice.get', { rowId: imported.rowId }).row;
    assert.equal(importedSnapshot.quiz.data.bank.path, '/courses/a/material');
    assert.equal(importedSnapshot.quiz.data.questions[0].stem, bankQuestion.stem);
    const invalidBytes = Buffer.from('```quiz\n{broken}\n```\n');
    const invalidFile = await receiveFile(store, filesDir, owner, Readable.from([invalidBytes]), 'invalid.md', 'text/markdown', invalidBytes.length, invalidBytes.length);
    put('files', 'a', { id: 'a', blob: { $file: invalidFile.id } });
    assert.throws(() => practice('practice.present', { materialId: 'a', clientNonce: 'invalid-import' }), /JSON/, 'invalid original is not hidden by a different bank');
    assert.equal(practice('practice.get', { rowId: imported.rowId }).row.quiz.data.questions[0].stem, bankQuestion.stem);
    put('files', 'a', { id: 'a', blob: { $file: bankFile.id } });
    // After Resource Library migration the project file, not an old uploaded blob,
   // is authoritative. A missing adapter is visible and recoverable after restart.
   await service.close();
    const projects = new ProjectRepository(store, path.join(filesDir, 'projects'));
   const resources = new ResourceFiles(projects, filesDir);
   resources.migrate(owner);
   const mappedNotebook = resources.placement(owner, 'wrongbook.md'); assert.ok(mappedNotebook);
   const mappedBefore = projects.files.read(mappedNotebook.project_id, mappedNotebook.path).text;
   service = new PluginService(store, undefined, undefined, { filesDir, resources });
   const mappedSession = reviewAction('review.present', { materialId: 'a', questionId: practiceEntry.id, clientNonce: 'mapped-review' });
   await service.close();
   service = new PluginService(store, undefined, undefined, { filesDir });
   reviewAction('practice.submit', { rowId: mappedSession.rowId, questionIndex: 0, pick: 1, durationSeconds: 5 });
   const failureDeadline = Date.now() + 10000;
   while (!store.db.prepare('SELECT error FROM plugin_practice_submissions WHERE row_id=? AND question_index=0').get(mappedSession.rowId)?.error) {
     if (Date.now() > failureDeadline) throw new Error('expected_delivery_failure_timeout');
     await new Promise(resolve => setTimeout(resolve, 25));
   }
   assert.equal(projects.files.read(mappedNotebook.project_id, mappedNotebook.path).text, mappedBefore);
   await service.close();
   service = new PluginService(store, undefined, undefined, { filesDir, resources });
   const mappedDelivery = await waitForDelivery(mappedSession.rowId);
   assert.equal(mappedDelivery.error, null);
   const mappedAfter = projects.files.read(mappedNotebook.project_id, mappedNotebook.path).text;
   assert.equal(parseWrongbook(mappedAfter).find(q => q.id === practiceEntry.id).attempts.length, 3);
   assert.equal(records.get(owner, 'files', 'wrongbook.md'), null, 'mapped delivery never creates a competing blob edit');
   assert.equal(readLearningMarkdown(store, filesDir, owner, 'wrongbook.md', resources).text, mappedAfter);
   await service.close();
   store.db.prepare('UPDATE plugin_practice_submissions SET delivered_at=NULL WHERE id=?').run(mappedDelivery.id);
   service = new PluginService(store, undefined, undefined, { filesDir, resources });
   await waitForDelivery(mappedSession.rowId);
   assert.equal(projects.files.read(mappedNotebook.project_id, mappedNotebook.path).text, mappedAfter, 'mapped replay is also idempotent');
  const before = service.files.layout(owner), disabled = JSON.parse(before.content); disabled.disabledBuiltins = ['flashcards'];
  service.files.save(owner, before.path, JSON.stringify(disabled), before.content, before.revision);
  assert.throws(() => invoke('cards-a', 'cards.list'), /unavailable/);
   console.log('Learning plugins passed: native cards/practice executors, source/schema/owner isolation, nonce binding, replacement CAS, historical snapshots, review identity and replay, subjective self-check, multiple-choice grading, AI/missing answer exclusion, durable receipts and restart delivery without page watches.');
} finally { await service.close(); await runner.close(); store.close(); fs.rmSync(directory, { recursive: true, force: true }); }
