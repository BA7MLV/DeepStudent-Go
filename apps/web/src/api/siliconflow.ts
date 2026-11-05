/** Browser server transports only. No provider client is loaded in this module. */
export type { ChatMessage, ChatOptions, ContentPart, FinishReason, ModelUsage, ReasoningEffort, ThinkingLevel,
  ToolCall, ToolCallDelta, ToolDef, TranscriptionResult, TranscriptionSegment } from './modelClient';
export { ApiError, textOf } from './modelClient';
export { listModelDetails, listModels, transcribe } from './server-model-input';
import type { ChatOptions, ChatMessage } from './modelClient';
import type { ModelTarget } from '../store/settings';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';

export async function chatOnce(target: ModelTarget, options: ChatOptions): Promise<ChatMessage> {
  if (!cloud.enabled || !cloud.userId) throw new Error('server_model_task_required');
  const lifetime = accountLifetime(cloud.userId);
  const { runCloudTask } = await import('../cloud/tasks');
  lifetime.assertCurrent();
  const { signal, onRequest, ...input } = options;
  const observationSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  const startedAt = Date.now(), id = crypto.randomUUID();
  let message: ChatMessage | undefined;
  try {
    message = await runCloudTask('modelOnce', id, { providerId: target.providerId, model: target.model, options: input }, undefined, observationSignal);
    lifetime.assertCurrent();
    return message!;
  } finally {
    if (lifetime.current()) await onRequest?.({ id, providerId: target.providerId, model: target.model, protocol: target.protocol,
      startedAt, endedAt: Date.now(), status: message ? 'completed' : observationSignal.aborted ? 'cancelled' : 'failed', usage: message?.usage });
  }
}
