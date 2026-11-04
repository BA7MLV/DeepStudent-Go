import crypto from 'node:crypto';
import { parseQuestionBank } from '@wangke/study-core/quiz';
import { CloudRecords } from '../cloud/records.js';
import { newRecordId, recordMutation } from '../cloud/execution.js';
import { taskDto } from '../cloud/tasks.js';
import { readLearningMarkdown } from './learning-files.js';
import { recordLearningReceipt } from './learning-results.js';
import type { PluginActionContext, PluginService } from './service.js';

/** Server extraction reads owned source pixels and saves via resource CAS. */
export function registerPracticeExtraction(service: PluginService, resolveMaterial: (args: Record<string, any>, context: PluginActionContext) => string) {
  const { store } = service, records = new CloudRecords(store);
  service.register({ id: 'practice.extract', capability: 'learning', access: 'write', trustedOnly: true,
    schema: { type: 'object', properties: { materialId: { type: 'string', minLength: 1, maxLength: 256 }, clientNonce: { type: 'string', minLength: 1, maxLength: 100 } }, required: ['materialId', 'clientNonce'], additionalProperties: false },
    run: (a, c) => {
      const id = resolveMaterial(a, c), material = records.get(c.owner, 'videos', id)!;
      if (material.kind !== 'material') throw new Error('plugin_document_required');
      const request = JSON.stringify({ materialId: id });
      const nonce = `plugin:${crypto.createHash('sha256').update(JSON.stringify([c.plugin.id, c.instance.id, 'practice.extract', a.clientNonce])).digest('hex')}`;
      return store.transaction(() => {
        const previous = store.db.prepare('SELECT t.*,l.request FROM cloud_tasks t JOIN plugin_learning_tasks l ON l.task_id=t.id WHERE t.owner_id=? AND t.nonce=?').get(c.owner, nonce) as any;
        if (previous) { if (previous.request !== request) throw new Error('plugin_nonce_conflict'); return taskDto(previous); }
        if (store.db.prepare("SELECT 1 FROM plugin_learning_tasks l JOIN cloud_tasks t ON t.id=l.task_id WHERE l.owner_id=? AND l.material_id=? AND l.action_id='practice.extract' AND t.status IN ('queued','running','waiting_user')").get(c.owner, id)) throw new Error('plugin_generation_conflict');
        let bankRevision: string | null = null;
        const bankId = `__course_questions__${encodeURIComponent(id)}`;
        if (records.get(c.owner, 'videos', bankId)) bankRevision = readLearningMarkdown(store, service.learningOptions.filesDir, c.owner, bankId, service.learningOptions.resources).revision;
        const taskId = crypto.randomUUID(), sessionId = newRecordId(), now = new Date().toISOString();
        const text = '请按「原题题库」技能，逐页提取这份资料的原题，保留题号、题干、选项和原图引用，核对原文答案及解析，并用 edit 保存到 /courses/current/questions.md。已有题库就 read 最新版后继续，不覆盖用户修改。缺答案和无法辨读的题明确标注；预算不足先保存已完成部分并说明尚未覆盖范围，不要重新编题。保存后给我题库链接，说明实际覆盖范围，不要把任务执行结束说成全文已提取。';
        const input = { videoId: id, sessionId, videoName: material.name, materialFormat: material.materialFormat, materialKind: material.materialFormat === 'pdf' ? 'page' : 'para', text, pluginExtraction: true, bankRevision };
        records.apply(c.owner, [recordMutation('chatSessions', sessionId, null, { id: sessionId, videoId: id, title: '插件原题提取', createdAt: Date.now() })]);
        store.db.prepare("INSERT INTO cloud_tasks(id,owner_id,nonce,kind,resource,input,status,executor,created_at,updated_at) VALUES(?,?,?,'qa',?,?,'queued','node',?,?)").run(taskId, c.owner, nonce, `session:${sessionId}`, JSON.stringify(service.files.admitTask(c.owner, 'qa', input)), now, now);
        store.db.prepare('INSERT INTO plugin_learning_tasks(task_id,owner_id,plugin_id,instance_id,action_id,material_id,request) VALUES(?,?,?,?,?,?,?)').run(taskId, c.owner, c.plugin.id, c.instance.id, 'practice.extract', id, request);
        return taskDto(store.db.prepare('SELECT * FROM cloud_tasks WHERE id=?').get(taskId));
      });
    },
  });
}

/** Durable completion projection. Only an actual changed, valid Markdown bank
 * earns an artifact receipt; a model's prose or a completed run is not evidence. */
export function reconcilePracticeExtractions(service: PluginService) {
  const { store } = service;
  const rows = store.db.prepare(`SELECT l.*,t.input,t.status,t.progress FROM plugin_learning_tasks l JOIN cloud_tasks t ON t.id=l.task_id
    LEFT JOIN plugin_learning_receipts r ON r.task_id=l.task_id WHERE l.action_id='practice.extract' AND l.delivered_at IS NULL AND r.task_id IS NULL
    AND t.status IN ('completed','failed','cancelled','interrupted') LIMIT 50`).all() as any[];
  for (const row of rows) {
    try {
      if (JSON.parse(row.progress ?? '{}')?.questionBankSaved !== true) throw new Error('plugin_extraction_save_unconfirmed');
      const bankId = `__course_questions__${encodeURIComponent(row.material_id)}`;
      const file = readLearningMarkdown(store, service.learningOptions.filesDir, row.owner_id, bankId, service.learningOptions.resources);
      if (file.revision === JSON.parse(row.input).bankRevision) throw new Error('plugin_extraction_no_new_bank');
      const bank = parseQuestionBank(file.text);
      const ownsSource = (q: typeof bank.questions[number]): boolean => q.source?.courseId === row.material_id && (!q.parts || q.parts.every(ownsSource));
      if (!bank.questions.length || !bank.questions.every(ownsSource)) throw new Error('plugin_question_source_denied');
      recordLearningReceipt(store, row.task_id, { kind: 'question-bank', materialId: row.material_id, path: `/courses/${encodeURIComponent(row.material_id)}/questions.md`, revision: file.revision, count: bank.questions.length, coverage: '模型已保存部分；请查看原提取会话确认覆盖范围', taskStatus: row.status, sessionId: JSON.parse(row.input).sessionId });
    } catch (error) {
      store.db.prepare('UPDATE plugin_learning_tasks SET error=? WHERE task_id=?').run(error instanceof Error ? error.message : 'plugin_extraction_artifact_unavailable', row.task_id);
    }
  }
}
