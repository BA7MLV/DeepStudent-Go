import type { MessageDto, ThreadDto } from './index.js';

export interface BotThreadPage { threads: ThreadDto[]; nextCursor: string | null }

export interface BotApprovalDto { id: string; messageId: string; threadId: string; runId?: string | null; status: 'pending' | 'approved' | 'rejected'; createdAt: string; resolvedAt: string | null; resolution: string | null }
export interface BotQuestionDto { id: string; runId: string; messageId: string; status: 'pending' | 'answered'; createdAt: string; answeredAt: string | null; answerMessageId: string | null }
export interface BotRunDto { id: string; status: string; errorCode: string | null; wakeAt: string | null }
export interface BotSyncState {
  thread?: ThreadDto;
  approvals: BotApprovalDto[];
  questions: BotQuestionDto[];
  runs: BotRunDto[];
  running: boolean;
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
