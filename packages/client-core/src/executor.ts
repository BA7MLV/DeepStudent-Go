import { Context } from '@deepseek-ai/cordis';
import { installConnection, type ConnectionInstallOptions } from '@deepseek-ai/dsh-client-connection/client';
import { apply as installGateway } from '@deepseek-ai/dsh-api-gateway/client';
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry';
import { TYPERT_REMOTE } from '@wangke/remote-artifacts';
import type { ExecutorCompletion, RuntimeJson, LearningProductCommand, ExecutorResourceCommand, ExecutorBlobAdmission } from '@wangke/contracts/client-runtime';
import type { ExecutorConversationReset, ExecutorInteractionDelivery, ExecutorInteractionsFrame, ExecutorAuthorizationFrame } from '@wangke/contracts/client-runtime';

/** A task capability cannot acquire an account Runtime or its models. */
export async function createExecutorRuntime(taskId: string, options: ConnectionInstallOptions) {
  const ctx = new Context();
  await ctx.plugin(TypertRegistry);
  installConnection(ctx, options);
  await ctx.plugin(installGateway);
  await ctx.remote.$mount(TYPERT_REMOTE);
  let disposed = false;
  const check = () => { if (disposed) throw new Error('executor_runtime_disposed'); };
  const unwrap = <T>(result: { ok: true; value: T } | { ok: false; error: { message: string; code: string; details?: unknown } }): T => {
    check();
    if (!result.ok) throw Object.assign(new Error(result.error.message), { code: result.error.code, detail: result.error.details });
    return result.value;
  };
  return {
    waitAuthorization: async (permissionId: string, signal?: AbortSignal) => {
      check();
      signal?.throwIfAborted();
      const source = ctx.remote.$stream<ExecutorAuthorizationFrame>({ name: `executor-authorization:${permissionId}`,
        open: signal => ctx.remote.executorRuntime.watchAuthorization(taskId, permissionId, signal), ended: () => new Error('executor_authorization_ended') });
      const aborted = () => { void source.dispose(); };
      signal?.addEventListener('abort', aborted, { once: true });
      if (signal?.aborted) aborted();
      try {
        for await (const item of source) {
          signal?.throwIfAborted();
          if (disposed || source.signal.aborted) throw new Error('executor_runtime_disposed');
          if (item.signal.aborted) continue;
          if (item.value.permissionId !== permissionId) throw new Error('executor_authorization_scope');
          item.accept();
          if (item.value.status !== 'pending') return item.value.status;
        }
        throw new Error('executor_authorization_ended');
      } finally { signal?.removeEventListener('abort', aborted); await source.dispose(); }
    },
    resetConversation: async (request: Omit<ExecutorConversationReset, 'taskId'>) => { check(); return unwrap(await ctx.remote.executorRuntime.resetConversation({ ...request, taskId })); },
    watchInteractions: () => { check(); return ctx.remote.executorRuntime.watchInteractions(taskId); },
    followInteractions: (apply: (frame: ExecutorInteractionsFrame, signal: AbortSignal) => Promise<void>, failed: (error: unknown) => void) => {
      check();
      const source = ctx.remote.$stream<ExecutorInteractionsFrame>({ name: 'executor-interactions',
        open: signal => ctx.remote.executorRuntime.watchInteractions(taskId, signal), ended: () => new Error('executor_interactions_ended') });
      const done = (async () => {
        let cursor = 0, baseline = false;
        try {
          for await (const item of source) {
            if (disposed || source.signal.aborted) break;
            if (item.signal.aborted) continue;
            const frame = item.value;
            if (frame.taskId !== taskId || !Number.isSafeInteger(frame.cursor) || frame.cursor < 0) throw new Error('executor_interaction_scope');
            if (frame.type === 'baseline') { cursor = 0; baseline = true; }
            if (!baseline || frame.cursor < cursor || frame.commands.some((command, i) => command.sequence <= (i ? frame.commands[i - 1].sequence : cursor) || command.sequence > frame.cursor)) throw new Error('executor_interaction_sequence');
            await apply(frame, item.signal);
            if (!item.signal.aborted) { cursor = frame.cursor; item.accept(); }
          }
        } catch (error) { if (!disposed && !source.signal.aborted) failed(error); }
        finally { await source.dispose(); }
      })();
      return { dispose: () => source.dispose(), done };
    },
    deliverInteraction: async (request: Omit<ExecutorInteractionDelivery, 'taskId'>) => { check(); return unwrap(await ctx.remote.executorRuntime.deliverInteraction({ ...request, taskId })); },
    admitBlob: async (request: Omit<ExecutorBlobAdmission, 'taskId'>) => { check(); return unwrap(await ctx.remote.executorRuntime.admitBlob({ ...request, taskId })); },
    resourceCommand: async (request: Omit<ExecutorResourceCommand, 'taskId'>) => {
      check(); return unwrap(await ctx.remote.executorRuntime.resourceCommand({ ...request, taskId }));
    },
    commitArtifacts: async (operationId: string, products: LearningProductCommand[]) => {
      for (const product of products) {
        if (product.kind === 'courseDerivation' && [product.expected, product.value].some(value => Object.keys(value).some(key => !['status', 'transcriptionPaused', 'unitCount', 'scanned', 'empty', 'coverState', 'dominantColor'].includes(key)))) throw new Error('invalid_learning_product');
      }
      check(); return unwrap(await ctx.remote.executorRuntime.commitArtifacts({ taskId, operationId, products }));
    },
    read: async () => { check(); return unwrap(await ctx.remote.executorRuntime.read(taskId)); },
    beginExecution: async () => { check(); return unwrap(await ctx.remote.executorRuntime.beginExecution(taskId)); },
    report: async (progress: { [key: string]: RuntimeJson }) => { check(); return unwrap(await ctx.remote.executorRuntime.report({ taskId, progress })); },
    complete: async (request: ExecutorCompletion) => {
      check(); if (request.taskId !== taskId) throw new Error('executor_task_changed');
      return unwrap(await ctx.remote.executorRuntime.complete(request));
    },
    receipt: async (operationId: string) => { check(); return unwrap(await ctx.remote.executorRuntime.receipt(taskId, operationId)); },
    dispose: async () => { if (disposed) return; disposed = true; await ctx.fiber.dispose(); },
  };
}
