import { cloud, withToolPermission } from './state';
import { flushCloud } from './sync';
import type { CloudTask } from '@wangke/contracts/cloud';
import { useCourseChat } from '../store/courseChat';
import { useJobStore } from '../store/jobs';
import { targetOfSlot, getSettings, useSettings } from '../store/settings';
import { terminateExtractor } from '../media/extractClient';
import { reportExecutor } from './executor-runtime';
import { followExecutorInteractions } from './executor-interactions';

declare global { interface Window { __runCloudTask: (task: CloudTask) => Promise<unknown> } }
window.__runCloudTask = async (task) => {
  cloud.taskId = task.id;
  await (await import('./executor-recovery')).quarantineExecutorOutbox((await import('../store/db')).db, task.id);
  const input = task.input as any;
  cloud.acceptedPlugins = Array.isArray(input._pluginProviders) ? input._pluginProviders.filter((id: unknown) => typeof id === 'string') : [];
  if (input.modelRef && getSettings().providers.some(p => p.id === input.modelRef.providerId) && typeof input.modelRef.model === 'string') {
    useSettings.setState({ llmModel: input.modelRef });
  }
  // Task payloads never supply network destinations or credentials.
  if (task.kind === 'qa') delete input.modelTarget;
  let progress: Record<string, unknown> = {};
  const controller = new AbortController();
  cloud.taskSignal = controller.signal;
  const stop = (reason?: unknown) => {
    controller.abort(reason);
    if (task.kind === 'chat') useCourseChat.getState().stop();
    if (task.kind === 'transcribe') terminateExtractor();
  };
  let reporting: Promise<void> | undefined;
  const report = () => {
    if (reporting) return reporting;
    reporting = reportExecutor(progress).then(() => {}).finally(() => { reporting = undefined; });
    return reporting;
  };
  const onProgress = (value: any) => { progress = value; };
  const timer = setInterval(() => { void report().catch(error => {
    if ([401, 403, 409].includes(error.status) || ['client/forbidden', 'client/unauthenticated'].includes(error.code) || error.detail?.code === 'worker_lease_expired') stop();
  }); }, 500);
  let interactions: Awaited<ReturnType<typeof followExecutorInteractions>> | undefined;
  const executionKey = `executor-execution:${task.id}`;
  const executionDatabase = (await import('../store/db')).db;
  const unsubscribe = useCourseChat.subscribe(s => {
    if (task.kind === 'chat') {
      const wait = (pending: typeof s.pendingAsk | typeof s.pendingPlan) => {
        const row = pending && s.messages.find(message => message.key === pending.messageKey);
        return row?.rowId != null ? { messageKey: `row:${row.rowId}` } : null;
      };
      progress = { view: { messages: s.messages, loading: s.loading, pendingAsk: wait(s.pendingAsk), pendingPlan: wait(s.pendingPlan), queued: s.queued } };
    }
  });
  const unsubscribeJobs = useJobStore.subscribe(s => { if (s.jobs[input.videoId]) progress = { ...s.jobs[input.videoId] }; });
  try {
    // A successor realm cannot replay the original send while an earlier
    // interaction callback awaits explicit server-side reconciliation.
    if (task.kind === 'chat') await (await import('./executor-runtime')).executorRuntime().then(runtime => runtime.read());
    // Sync after claiming while the heartbeat is already renewing the lease.
    await flushCloud();
    controller.signal.throwIfAborted();
    let result: unknown;
    if (task.kind === 'chat' || task.kind === 'qa') {
      await withToolPermission('read', { tool: 'prepare_task_context', kind: task.kind, resource: task.resource }, async () => {});
    }
    if (task.kind === 'qa' || task.kind === 'artifactEdit') {
      const prior = (await executionDatabase.table('_cloudMeta').get(executionKey))?.value;
      if (prior?.phase === 'result') return prior.result;
      if (prior) throw new Error('executor_execution_uncertain: 请在执行器恢复日志核对原任务/产物，不会重跑模型；确认后可从原会话另行发起');
      await executionDatabase.table('_cloudMeta').put({ id: executionKey, value: { taskId: task.id, operationId: `executor-execution-${task.id}`, phase: 'starting', input } });
      const admission = await (await import('./executor-runtime')).executorRuntime().then(runtime => runtime.beginExecution()) as { phase: string };
      if (admission.phase !== 'admitted') throw new Error('executor_execution_uncertain');
      await executionDatabase.table('_cloudMeta').put({ id: executionKey, value: { taskId: task.id, operationId: `executor-execution-${task.id}`, phase: 'started', input } });
    }
    switch (task.kind) {
      case 'chat':
        await useCourseChat.getState().bootstrap();
        await useCourseChat.getState().loadSession(input.sessionId);
        let recovered: (() => void) | undefined;
        let recoveryFailed: ((error: unknown) => void) | undefined;
        const recovery = input.action === 'resumeInteraction' ? new Promise<void>((resolve, reject) => { recovered = resolve; recoveryFailed = reject; }) : undefined;
        interactions = await followExecutorInteractions({
          ready: (command, signal) => new Promise<void>((resolve, reject) => {
            let off = () => {};
            let settled = false;
            const finish = (error?: unknown) => { if (settled) return; settled = true; off(); clearTimeout(timeout); signal.removeEventListener('abort', aborted); controller.signal.removeEventListener('abort', aborted); error ? reject(error) : resolve(); };
            const aborted = () => finish(new Error('executor_interaction_cancelled'));
            const check = () => {
              const state = useCourseChat.getState(), pending = command.action === 'answerAsk' ? state.pendingAsk : state.pendingPlan;
              const row = pending && state.messages.find(message => message.key === pending.messageKey);
              if (row?.rowId != null && command.target === `row:${row.rowId}`) { void report().then(() => finish(), finish); }
            };
            const timeout = setTimeout(() => finish(new Error('executor_interaction_baseline_timeout')), 30000);
            off = useCourseChat.subscribe(check);
            signal.addEventListener('abort', aborted, { once: true }); controller.signal.addEventListener('abort', aborted, { once: true });
            if (signal.aborted || controller.signal.aborted) aborted(); else check();
          }),
          apply: async command => {
            const store = useCourseChat.getState();
            if (command.action === 'answerAsk') await store.answerAsk(command.value as any);
            if (command.action === 'confirmPlan') await store.confirmPlan();
            if (command.action === 'cancelPlan') await store.cancelPlan();
          },
          applied: command => { if (input.interactionSequence === command.sequence) recovered?.(); },
          failed: error => { progress = { ...progress, commandError: String(error) }; recoveryFailed?.(error); stop(error); },
        });
        if (recovery) await recovery;
        else if (input.action === 'continue' || input.action === 'retry') {
          const message = useCourseChat.getState().messages.find(message => message.rowId === input.rowId);
          await useCourseChat.getState().retryMessage(message?.key ?? `executor-reset:${input.rowId}`);
        }
        else await useCourseChat.getState().send(input.text, input.mode, input.sessionId, input.resume, input.attachments ?? [], input.explicitSkillIds ?? []);
        result = null; break;
      case 'qa': result = await (await import('../harness/qaRunner')).runQa(input, {
        signal: controller.signal,
        onToolEnd: (name, result) => {
          const path = `/courses/${encodeURIComponent(input.videoId)}/questions.md`;
          if (input.pluginExtraction === true && name === 'edit' && (result.startsWith(`已创建 ${path}\n`) || result === `已创建 ${path}` || result.startsWith(`已修改 ${path}（`))) {
            onProgress({ ...progress, questionBankSaved: true });
          }
        },
        onTools: tools => onProgress({ ...progress, tools }),
        onDelta: text => onProgress({ ...progress, content: String(progress.content ?? '') + text }),
        onReasoning: text => onProgress({ ...progress, reasoning: String(progress.reasoning ?? '') + text }),
        onRoundStart: () => onProgress({ ...progress, content: '' }),
      }); break;
      case 'transcribe': result = await (await import('../pipelines/transcribe')).runTranscription(input.videoId, onProgress, { signal: controller.signal }); break;
      case 'handout': result = await (await import('../pipelines/handout')).runHandout(input.videoId, onProgress); break;
      case 'cards': result = await (await import('../pipelines/cards')).runCards(input.videoId, onProgress); break;
      case 'comments': result = await (await import('../pipelines/comments')).runComments(input.videoId, onProgress); break;
      case 'danmaku': result = await (await import('../pipelines/danmaku')).runDanmaku(input.videoId, onProgress); break;
      case 'material': result = await (await import('../pipelines/materialJob')).startMaterialJob(input.videoId, input.format); break;
      case 'cover': result = await (await import('../pipelines/cover')).ensureCover(input.videoId, input.options); break;
      case 'artifactEdit': result = await (await import('../pipelines/artifactEdit')).editArtifact({ ...input, signal: controller.signal }); break;
      case 'handoutEdit': result = await (await import('../pipelines/handoutEdit')).rewriteBlockWithLLM(input.original, input.instruction, input.ctx); break;
      case 'modelOnce': {
        const target = targetOfSlot(getSettings(), 'chat');
        const provider = getSettings().providers.find(p => p.id === input.providerId);
        if (!provider) throw new Error('模型服务不存在');
        result = await (await import('../api/siliconflow')).chatOnce({ ...target, ...provider, model: input.model }, input.options); break;
      }
      default: throw new Error('未知任务');
    }
    controller.signal.throwIfAborted();
    await flushCloud();
    if (reporting) await reporting;
    await report();
    if (task.kind === 'qa' || task.kind === 'artifactEdit') await executionDatabase.table('_cloudMeta').put({ id: executionKey, value: { taskId: task.id, operationId: `executor-execution-${task.id}`, phase: 'result', input, result: result ?? null } });
    return result ?? null;
  } catch (error) {
    // Persist failure status/checkpoints before completing and revoking the lease.
    if (!controller.signal.aborted) await flushCloud().catch(() => {});
    throw error;
  } finally {
    if (cloud.taskSignal === controller.signal) cloud.taskSignal = undefined;
    cloud.acceptedPlugins = [];
    clearInterval(timer); await interactions?.dispose(); unsubscribe(); unsubscribeJobs();
  }
};
