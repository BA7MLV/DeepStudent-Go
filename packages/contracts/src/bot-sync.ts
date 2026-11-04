import type { MessageDto, ThreadDto } from './index.js';

export interface BotThreadPage { threads: ThreadDto[]; nextCursor: string | null }

export interface BotApprovalDto { id: string; messageId: string; threadId: string; runId?: string | null; status: 'pending' | 'approved' | 'rejected'; createdAt: string; resolvedAt: string | null; resolution: string | null }
export interface BotQuestionDto { id: string; runId: string; messageId: string; status: 'pending' | 'answered'; createdAt: string; answeredAt: string | null; answerMessageId: string | null }
export interface BotRunDto { id: string; status: string; errorCode: string | null; wakeAt: string | null }
/** Observed runtime state, never model-authored narration or an estimated percentage. */
export interface BotActivityDto {
  phase: 'queued' | 'running' | 'model' | 'tools' | 'waiting_user' | 'waiting_event';
  tools: Array<{ id: string; name: string }>;
  activeTools: number;
  completedTools: number;
}
export function isBotActivity(value: unknown): value is BotActivityDto {
  if (!value || typeof value !== 'object') return false;
  const a = value as BotActivityDto;
  return ['queued', 'running', 'model', 'tools', 'waiting_user', 'waiting_event'].includes(a.phase) &&
    Number.isSafeInteger(a.activeTools) && a.activeTools >= 0 && Number.isSafeInteger(a.completedTools) && a.completedTools >= 0 &&
    (a.phase === 'tools' ? a.activeTools > 0 : a.activeTools === 0) &&
    Array.isArray(a.tools) && a.tools.length === Math.min(a.activeTools, 4) && a.tools.every(tool =>
      tool && typeof tool.id === 'string' && tool.id.length > 0 && tool.id.length <= 200 && typeof tool.name === 'string' && tool.name.length > 0 && tool.name.length <= 200);
}
export interface BotSyncState {
  thread?: ThreadDto;
  approvals: BotApprovalDto[];
  questions: BotQuestionDto[];
  runs: BotRunDto[];
  running: boolean;
  activity?: BotActivityDto | null;
  /** Watermark of the consistent read, not a message sequence number. */
  eventCursor: number;
}
export interface BotMessagePage {
  messages: MessageDto[];
  approvals: BotApprovalDto[];
  questions: BotQuestionDto[];
  hasOlder: boolean;
  nextBeforeSeq: number | null;
}
export interface BotSnapshot extends ThreadDto, BotMessagePage, BotSyncState {
  schemaVersion: 1;
}
