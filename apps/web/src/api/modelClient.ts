/** Browser data contracts only. Provider protocol execution belongs to the API. */
export type { ChatMessage, ChatOptions, ContentPart, FinishReason, ModelUsage, ReasoningEffort, ThinkingLevel,
  ToolCall, ToolCallDelta, ToolDef, TranscriptionResult, TranscriptionSegment } from '@wangke/study-core/model/client';
import type { ChatMessage } from '@wangke/study-core/model/client';

export class ApiError extends Error {
  constructor(public status: number, message: string, public retryAfterMs?: number) { super(message); }
}

/** Pure display/input preparation; never serializes or executes a provider request. */
export function textOf(message: ChatMessage | null | undefined): string {
  if (!message || message.content == null) return '';
  if (typeof message.content === 'string') return message.content;
  return message.content.filter(part => part.type === 'text').map(part => part.text).join('');
}
