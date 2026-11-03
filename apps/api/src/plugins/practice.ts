import crypto from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { canUpdateQuizPick, parseQuestionBank, quizPickAnswer, quizPickResult, validateQuiz, type QuizData, type QuizPick } from '@wangke/study-core/quiz';
import { canGradeQuizQuestion } from '@wangke/study-core/quiz';
import { CloudRecords } from '../cloud/records.js';
import { newRecordId, recordMutation } from '../cloud/execution.js';
import { taskDto } from '../cloud/tasks.js';
import type { PluginActionContext, PluginService } from './service.js';
import { readLearningMarkdown } from './learning-files.js';
import { deliverNotebookAttempt } from './learning-notebook.js';
import { parseWrongbook } from '@wangke/study-core/wrongbook';

const material = { type: 'string', minLength: 1, maxLength: 256 };
const integer = { type: 'integer', minimum: 0 };
const object = (properties: Record<string, unknown>, required = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
export function practiceRowResolver(service: PluginService, resolveMaterial: (args: Record<string, any>, c: PluginActionContext) => string) {
  const { store } = service, records = new CloudRecords(store);
  return (c: PluginActionContext, rowId: number) => {
    const link = store.db.prepare('SELECT material_id FROM plugin_practice_snapshots WHERE row_id=? AND owner_id=? AND plugin_id=? AND instance_id=?').get(rowId, c.owner, c.plugin.id, c.instance.id) as { material_id: string } | undefined;
    if (!link) throw new Error('plugin_practice_not_found');
    resolveMaterial({ materialId: link.material_id }, c);
    const row = records.get(c.owner, 'chats', rowId);
    if (!row?.quiz || !validateQuiz(row.quiz.data, 20).ok) throw new Error('plugin_practice_not_found');
    return row;
  };
}
export function registerPracticeActions(service: PluginService, resolveMaterial: (args: Record<string, any>, c: PluginActionContext) => string) {
  const { store } = service, records = new CloudRecords(store), resolveRow = practiceRowResolver(service, resolveMaterial);
  service.register({ id: 'practice.list', capability: 'learning', access: 'read', schema: object({ materialId: material }, []), run: (a, c) => {
    const id = resolveMaterial(a, c);
    const refs = store.db.prepare(`SELECT p.row_id FROM plugin_practice_snapshots p JOIN cloud_records r ON r.owner_id=p.owner_id AND r.table_name='chats' AND r.record_key=CAST(p.row_id AS TEXT)
      WHERE p.owner_id=? AND p.plugin_id=? AND p.instance_id=? AND p.material_id=? AND r.value IS NOT NULL ORDER BY json_extract(r.value,'$.createdAt') DESC LIMIT 50`).all(c.owner, c.plugin.id, c.instance.id, id) as { row_id: number }[];
    return { practices: refs.map(ref => records.get(c.owner, 'chats', ref.row_id)).filter(r => r?.quiz).map(r => ({ id: r!.id, content: r!.content, createdAt: r!.createdAt, questions: r!.quiz.data.questions.length, answered: r!.quiz.picks.filter((p: QuizPick) => typeof p !== 'number' || p >= 0).length, bank: r!.quiz.data.bank ?? null })) };
  } });
  service.register({ id: 'practice.get', capability: 'learning', access: 'read', trustedOnly: true, schema: object({ rowId: integer }), run: (a, c) => {
    const row = resolveRow(c, a.rowId);
    const submissions = store.db.prepare('SELECT question_index,delivered_at,error FROM plugin_practice_submissions WHERE row_id=? AND owner_id=?').all(a.rowId, c.owner);
    return { row, submissions };
  } });
  service.register({ id: 'practice.present', capability: 'learning', access: 'write', trustedOnly: true, schema: object({ materialId: material, offset: integer, limit: { type: 'integer', minimum: 1, maximum: 20 }, clientNonce: { type: 'string', minLength: 1, maxLength: 100 } }, ['materialId', 'clientNonce']), run: (a, c) => {
    const id = resolveMaterial(a, c), bankId = `__course_questions__${encodeURIComponent(id)}`;
    const operation = crypto.createHash('sha256').update(JSON.stringify([c.owner, c.plugin.id, c.instance.id, 'present', a.clientNonce])).digest('hex');
    // This is an operation receipt, never a second copy of a question bank.
    const previous = store.db.prepare('SELECT row_id,question_index FROM plugin_practice_submissions WHERE id=? AND owner_id=?').get(`present:${operation}`, c.owner) as { row_id: number; question_index: number } | undefined;
    if (previous) {
      const row = resolveRow(c, previous.row_id);
      if (row.quiz.data.bank?.offset !== (a.offset ?? 0) || row.videoId !== id || row.quiz.requestedLimit !== (a.limit ?? 10)) throw new Error('plugin_nonce_conflict');
      return { rowId: row.id };
    }
    let file: ReturnType<typeof readLearningMarkdown> | undefined;
    let bankPath = `/courses/${encodeURIComponent(id)}/questions.md`;
    const source = records.get(c.owner, 'videos', id);
    if (source?.kind === 'material' && source.materialFormat === 'md') {
      try {
        const original = readLearningMarkdown(store, service.learningOptions.filesDir, c.owner, id, service.learningOptions.resources);
        // An imported Markdown bank remains authoritative at /material. Invalid
        // quiz blocks must fail validation, not silently select a different bank.
        if (/^```quiz[ \t]*\r?$/m.test(original.text)) { file = original; bankPath = `/courses/${encodeURIComponent(id)}/material`; }
      } catch (error) {
        if (!(error instanceof Error) || error.message !== 'plugin_material_file_not_found') throw error;
      }
    }
    file ??= readLearningMarkdown(store, service.learningOptions.filesDir, c.owner, bankId, service.learningOptions.resources);
    const parsed = parseQuestionBank(file.text);
    const offset = a.offset ?? 0, limit = a.limit ?? 10;
    const questions = parsed.questions.slice(offset, offset + limit);
    const sourceMatches = (q: QuizData['questions'][number]): boolean => q.source?.courseId === id && (!q.parts || q.parts.every(sourceMatches));
    if (questions.some(q => !sourceMatches(q))) throw new Error('plugin_question_source_denied');
    if (!questions.length) throw new Error('plugin_question_bank_empty');
    const data: QuizData = { questions, bank: { path: bankPath, offset, total: parsed.questions.length } };
    const sessionId = newRecordId(), rowId = newRecordId(), now = Date.now();
    store.transaction(() => {
      records.apply(c.owner, [recordMutation('chatSessions', sessionId, null, { id: sessionId, videoId: id, title: '插件原题练习', createdAt: now }), recordMutation('chats', rowId, null, { id: rowId, sessionId, videoId: id, role: 'assistant', content: '原题练习 · 来源于资料题库 Markdown', createdAt: now, quiz: { data, picks: questions.map(() => -1), bankRevision: file.revision, requestedLimit: limit } })]);
      store.db.prepare('INSERT INTO plugin_practice_snapshots(row_id,owner_id,plugin_id,instance_id,material_id) VALUES(?,?,?,?,?)').run(rowId, c.owner, c.plugin.id, c.instance.id, id);
      store.db.prepare('INSERT INTO plugin_practice_submissions(id,owner_id,row_id,question_index,delivered_at) VALUES(?,?,?,-1,?)').run(`present:${operation}`, c.owner, rowId, new Date().toISOString());
    });
    return { rowId };
  } });
  service.register({ id: 'practice.generate', capability: 'learning', access: 'write', trustedOnly: true, schema: object({ materialId: material, count: { type: 'integer', minimum: 1, maximum: 20 }, clientNonce: { type: 'string', minLength: 1, maxLength: 100 } }, ['materialId', 'clientNonce']), run: (a, c) => {
    const id = resolveMaterial(a, c), count = a.count ?? 5;
    const nonce = `plugin:${crypto.createHash('sha256').update(JSON.stringify([c.plugin.id, c.instance.id, 'practice.generate', a.clientNonce])).digest('hex')}`;
    const request = JSON.stringify({ materialId: id, count });
    return store.transaction(() => {
      const previous = store.db.prepare('SELECT t.*,l.request FROM cloud_tasks t JOIN plugin_learning_tasks l ON l.task_id=t.id WHERE t.owner_id=? AND t.nonce=?').get(c.owner, nonce) as any;
      if (previous) { if (previous.request !== request) throw new Error('plugin_nonce_conflict'); return taskDto(previous); }
      const taskId = crypto.randomUUID(), now = new Date().toISOString();
      store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,created_at,updated_at) VALUES(?,?,?,'modelOnce',?,?,'queued',?,?)").run(taskId, c.owner, nonce, `course:${id}`, JSON.stringify(service.files.admitTask(c.owner, 'modelOnce', { videoId: id, pluginPractice: true, count })), now, now);
      store.db.prepare('INSERT INTO plugin_learning_tasks(task_id,owner_id,plugin_id,instance_id,action_id,material_id,request) VALUES(?,?,?,?,?,?,?)').run(taskId, c.owner, c.plugin.id, c.instance.id, 'practice.generate', id, request);
      return taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(taskId));
    });
  } });
  service.register({ id: 'practice.submit', capability: 'learning', access: 'write', trustedOnly: true, schema: object({ rowId: integer, questionIndex: integer, pick: { anyOf: [{ type: 'integer', minimum: 0 }, object({ answer: {}, selfGrade: { type: 'boolean' } }, ['answer'])] }, durationSeconds: { type: 'number', minimum: 0, maximum: 86400 } }), run: (a, c) => store.transaction(() => {
    const row = resolveRow(c, a.rowId), question = row.quiz.data.questions[a.questionIndex];
    if (!question) throw new Error('invalid_plugin_question');
    const old = row.quiz.picks[a.questionIndex];
    if (isDeepStrictEqual(old, a.pick)) return { saved: true };
    if (!canUpdateQuizPick(question, old, a.pick)) throw new Error('plugin_submission_conflict');
    const picks = [...row.quiz.picks]; picks[a.questionIndex] = a.pick;
    const result = quizPickResult(question, a.pick), at = new Date().toISOString();
    const attemptId = `plugin:${crypto.createHash('sha256').update(JSON.stringify([c.owner, row.id, a.questionIndex])).digest('hex')}`;
    const attempts = { ...row.quiz.attempts, ...(result === undefined ? {} : { [a.questionIndex]: { id: attemptId, at, answer: quizPickAnswer(a.pick), correct: result, durationSeconds: a.durationSeconds, rating: result ? 3 : 1, ...(!canGradeQuizQuestion(question) ? { grading: 'self' } : {}) } }) };
    records.apply(c.owner, [recordMutation('chats', row.id, row, { ...row, quiz: { ...row.quiz, picks, attempts } })]);
    if (result !== undefined) store.db.prepare('INSERT OR IGNORE INTO plugin_practice_submissions(id,owner_id,row_id,question_index) VALUES(?,?,?,?)').run(attemptId, c.owner, row.id, a.questionIndex);
    return { saved: true };
  }) });
}
export function registerReviewPresentation(service: PluginService, resolveMaterial: (args: Record<string, any>, c: PluginActionContext) => string) {
  const { store } = service, records = new CloudRecords(store), resolveRow = practiceRowResolver(service, resolveMaterial);
  service.register({ id: 'review.present', capability: 'learning', access: 'write', trustedOnly: true, schema: object({ materialId: material, questionId: { type: 'string', minLength: 1, maxLength: 256 }, clientNonce: { type: 'string', minLength: 1, maxLength: 100 } }), run: (a, c) => {
    const id = resolveMaterial(a, c), operation = `review:${crypto.createHash('sha256').update(JSON.stringify([c.owner, c.plugin.id, c.instance.id, a.clientNonce])).digest('hex')}`;
    const previous = store.db.prepare('SELECT row_id FROM plugin_practice_submissions WHERE id=? AND owner_id=?').get(operation, c.owner) as { row_id: number } | undefined;
    if (previous) {
      const row = resolveRow(c, previous.row_id);
      if (row.videoId !== id || row.quiz.reviewQuestionId !== a.questionId) throw new Error('plugin_nonce_conflict');
      return { rowId: row.id };
    }
    const notebook = readLearningMarkdown(store, service.learningOptions.filesDir, c.owner, 'wrongbook.md', service.learningOptions.resources);
    const question = parseWrongbook(notebook.text).find(q => q.id === a.questionId && q.source.courseId === id);
    if (!question) throw new Error('plugin_review_question_not_found');
    const rowId = newRecordId(), sessionId = newRecordId(), now = Date.now();
    store.transaction(() => {
      records.apply(c.owner, [recordMutation('chatSessions', sessionId, null, { id: sessionId, videoId: id, title: '错题复习', createdAt: now }), recordMutation('chats', rowId, null, { id: rowId, sessionId, videoId: id, role: 'assistant', content: '原错题本复习快照', createdAt: now, quiz: { data: { questions: [question.question] }, picks: [-1], reviewQuestionId: question.id, notebookRevision: notebook.revision } })]);
      store.db.prepare('INSERT INTO plugin_practice_snapshots(row_id,owner_id,plugin_id,instance_id,material_id) VALUES(?,?,?,?,?)').run(rowId, c.owner, c.plugin.id, c.instance.id, id);
      store.db.prepare('INSERT INTO plugin_practice_submissions(id,owner_id,row_id,question_index,delivered_at) VALUES(?,?,?,-1,?)').run(operation, c.owner, rowId, new Date().toISOString());
    });
    return { rowId };
  } });
}
export function startNotebookDelivery(service: PluginService) {
  const { store } = service, records = new CloudRecords(store);
  let stopped = false, running: Promise<void> | undefined;
  const reconcile = async () => {
      const pending = store.db.prepare('SELECT * FROM plugin_practice_submissions WHERE delivered_at IS NULL LIMIT 50').all() as any[];
      for (const p of pending) {
        if (stopped) break;
        try {
          const row = records.get(p.owner_id, 'chats', p.row_id), q = row?.quiz?.data?.questions?.[p.question_index], attempt = row?.quiz?.attempts?.[p.question_index];
          if (!q || !attempt || attempt.id !== p.id) throw new Error('plugin_submission_source_missing');
          await deliverNotebookAttempt(service, p.owner_id, q, q.source ?? { courseId: row!.videoId }, attempt, row!.quiz.reviewQuestionId);
          store.db.prepare('UPDATE plugin_practice_submissions SET delivered_at=?,error=NULL WHERE id=?').run(new Date().toISOString(), p.id);
        } catch { store.db.prepare("UPDATE plugin_practice_submissions SET error='notebook_delivery_failed' WHERE id=?").run(p.id); }
      }
  };
  const run = () => {
    if (stopped || running) return;
    running = reconcile().catch(() => console.error('plugin_notebook_delivery_unavailable')).finally(() => { running = undefined; });
  };
  const timer = setInterval(run, 1000); timer.unref(); run();
  // Awaited by the API shutdown boundary before SQLite is closed.
  return async () => { stopped = true; clearInterval(timer); await running; };
}
