/** Node execution consumes environment-neutral packages, never Web application sources.
 * 本文件只保留任务分派入口;工具循环、会话编排、检索执行器与资料生成已拆到同目录
 * node-*.ts。`executeNodeTask` 的导出名与签名保持不变,构建脚本与测试直接引用它。 */
import { generateText, type TextSegment } from '@wangke/study-core/generation/text';
import { rewriteBlock, type RewriteContext } from '@wangke/study-core/handout/rewrite';
import type { Block } from '@wangke/study-core/handout/ir';
import type { ChatOptions } from '@wangke/study-core/model/client';
import { chatOnce } from '@wangke/study-core/model/client';
import { taskRows, recordMutation, commitTask, newRecordId, type TaskContext } from '../src/cloud/execution.js';
import { ensureLearningResults, cardsRevision, learningCards, recordLearningReceipt } from '../src/plugins/learning-results.js';
import { serverBilibiliImport } from './bilibili-import.js';
import { executeContextCompression } from './context-compression.js';
import { persistHandout } from './handout-edit.js';
import { serverHandout, serverCover, serverTranscribe } from './media-tasks.js';
import { serverQuestionExtraction } from './question-extraction.js';
import { modelFetch, targetFor } from './node-common.js';
import { qa, chat } from './node-sessions.js';
import { artifactEdit, material, generatePluginPractice, studyHandout } from './node-generation.js';

export async function executeNodeTask(context: TaskContext): Promise<unknown> {
  context.checkActive();
  if (context.task.kind === 'bilibiliImport') return serverBilibiliImport(context);
  if (context.task.kind === 'chat' && context.task.input.action === 'compressContext') return executeContextCompression(context);
  if (context.task.kind === 'chat') return chat(context);
  if (context.task.kind === 'qa' && context.task.input.pluginExtraction === true) return serverQuestionExtraction(context);
  if (context.task.kind === 'qa') return qa(context);
  if (context.task.kind === 'artifactEdit') return artifactEdit(context);
  if (context.task.kind === 'material') return material(context);
  if (context.task.kind === 'handout' && context.task.input.botStudyText === true) return studyHandout(context);
  if (context.task.kind === 'handout') return serverHandout(context);
  if (context.task.kind === 'cover') return serverCover(context);
  if (context.task.kind === 'transcribe') return serverTranscribe(context);
  if (context.task.kind === 'modelOnce' && context.task.input.pluginPractice === true) return generatePluginPractice(context);
  if (context.task.kind === 'handoutEdit' && context.task.input.action === 'persist') return persistHandout(context);
  const target = targetFor(context);
  const fetcher = modelFetch(context);
  const input = context.task.input;
  if (context.task.kind === 'modelOnce') {
    const options = input.options as ChatOptions;
    if (!options || !Array.isArray(options.messages)) throw new Error('invalid_model_options');
    return chatOnce(target, { ...options, signal: context.signal }, fetcher);
  }
  if (context.task.kind === 'handoutEdit') {
    if (!input.original || typeof input.instruction !== 'string' || !input.ctx) throw new Error('invalid_rewrite_input');
    return rewriteBlock(target, input.original as Block, input.instruction, input.ctx as RewriteContext, context.signal, fetcher);
  }
  const kind = context.task.kind;
  if (kind !== 'cards' && kind !== 'comments' && kind !== 'danmaku') throw new Error('unsupported_node_task');
  const id = String(input.videoId);
  const video = context.records.get(context.owner, 'videos', id);
  if (!video) throw new Error('视频不存在');
  let segments = taskRows(context, 'segments', 'videoId', id) as TextSegment[];
  if (!segments.some(s => s.status === 1 && s.text)) {
    const blocks = taskRows(context, 'materialBlocks', 'materialId', id).sort((a, b) => (a.idx ?? a.index ?? 0) - (b.idx ?? b.index ?? 0));
    segments = blocks.map((b, i) => ({ idx: i, start: i, end: i + 1, text: String(b.text ?? b.content ?? ''), status: 1 }));
    // generateText's three-segment precondition is useful for incomplete video transcripts,
    // but a single fully indexed document block is valid source material.
    if (segments.length > 0 && segments.length < 3) {
      const text = segments.map(s => s.text).join('\n'), width = Math.ceil(text.length / 3);
      if (text.trim().length < 3) throw new Error('course_source_too_short');
      segments = [0,1,2].map(i => ({ idx: i, start: i, end: i + 1, text: text.slice(i * width, (i + 1) * width), status: 1 }));
    }
  }
  const generated = await generateText(kind, String(video.name), segments, target, p => context.report({ ...p }), context.signal, fetcher);
  context.checkActive();
  if (!context.records.get(context.owner, 'videos', id)) throw new Error('视频已删除');
  const createdAt = Date.now();
  if (kind === 'cards') {
    ensureLearningResults(context.store);
    const mutations = replaceRows(context, 'cards', 'videoId', id,
      (generated as Awaited<ReturnType<typeof generateText<'cards'>>>).map(card => ({ videoId: id, ...card, status: 0, createdAt })));
    context.store.transaction(() => {
      const linked = context.store.db.prepare('SELECT 1 FROM plugin_learning_tasks WHERE task_id=? AND owner_id=?').get(context.task.id, context.owner);
      if (linked && cardsRevision(learningCards(context.store, context.owner, id)) !== input.expectedCardsRevision) throw new Error('plugin_cards_replace_conflict');
      commitTask(context, mutations);
      if (linked) recordLearningReceipt(context.store, context.task.id, { kind: 'cards', materialId: id, cardIds: mutations.filter(m => m.after).map(m => m.key), count: generated.length });
    });
    return generated.length;
  }
  if (kind === 'danmaku') {
    commitTask(context, replaceRows(context, 'danmakus', 'videoId', id, generated.map(item => ({ videoId: id, ...item }))));
    return generated.length;
  }
  const threads = generated as Awaited<ReturnType<typeof generateText<'comments'>>>;
  const old = taskRows(context, 'comments', 'videoId', id);
  const mutations = old.map(row => recordMutation('comments', row.id, row, null));
  let posts = 0;
  for (const thread of threads) {
    const parentId = newRecordId();
    mutations.push(recordMutation('comments', parentId, null, { id: parentId, videoId: id, time: thread.time,
      author: thread.author, role: thread.role, text: thread.text, createdAt: createdAt + posts++ }));
    for (const reply of thread.replies) {
      const replyId = newRecordId();
      mutations.push(recordMutation('comments', replyId, null, { id: replyId, videoId: id, time: thread.time,
        author: reply.author, role: reply.role, text: reply.text, parentId, createdAt: createdAt + posts++ }));
    }
  }
  commitTask(context, mutations);
  return { threads: threads.length, posts };
}

function replaceRows(context: TaskContext, table: string, field: string, value: string, rows: Record<string, any>[]) {
  const old = taskRows(context, table, field, value);
  return [
    ...old.map(row => recordMutation(table, row.id, row, null)),
    ...rows.map(row => { const id = newRecordId(); return recordMutation(table, id, null, { ...row, id }); }),
  ];
}
