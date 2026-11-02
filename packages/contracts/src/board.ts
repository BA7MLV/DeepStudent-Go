import type { CloudTask } from './cloud.js';

export const BOARD_PATH = '/system/board';
export const BOARD_PLUGINS_PATH = `${BOARD_PATH}/plugins`;
export const BOARD_CAPABILITIES = ['state', 'tasks', 'schedules'] as const;
export type BoardCapability = typeof BOARD_CAPABILITIES[number];
export interface BoardManifest {
  apiVersion: 1;
  id: string;
  name: string;
  description?: string;
  version: string;
  entry: 'index.html';
  enabled: boolean;
  order?: number;
  height?: number;
  capabilities: BoardCapability[];
}
export interface BoardPlugin {
  id: string;
  path: string;
  manifest?: BoardManifest;
  revision?: number;
  error?: string;
}
export interface BoardSchedule {
  id: string;
  prompt: string;
  threadId: string;
  nextRunAt: string;
  everySeconds?: number;
  enabled: boolean;
  lastRunAt?: string;
  lastMessageId?: string;
  /** Server projection; dispatch is not completion. The result stays in the run record. */
  lastTask?: Pick<BoardBotTask, 'id' | 'status' | 'completedAt' | 'error'>;
  error?: string;
}
export interface BoardBotTask {
  id: `bot:${string}`;
  kind: 'bot';
  title: string;
  threadId: string;
  runId: string;
  resourceName: string;
  source: { kind: 'bot'; name?: string };
  status: 'queued' | 'running' | 'waiting_user' | 'waiting_event' | 'paused' | 'completed' | 'failed' | 'cancelled';
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  stepCount: number;
  progress: { tool: string } | null;
  result: { messageId: string; kind: string; text: string; truncated: boolean } | null;
  error: string | null;
}
export type BoardTask = CloudTask | BoardBotTask;
export const boardTaskTerminal = (status: string) => ['completed', 'failed', 'cancelled', 'interrupted'].includes(status);
export const boardSlug = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(value);
/** Portable paths, shared by the resource reader, Chat and Bot. */
export function boardPath(value: unknown): value is `/system/board${string}` {
  return typeof value === 'string' && (value === BOARD_PATH || value.startsWith(`${BOARD_PATH}/`) && value.slice(BOARD_PATH.length + 1).split('/').every(part => /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,99}$/.test(part) && part !== '..'));
}
export function parseBoardManifest(value: unknown, id: string): BoardManifest {
  const m = value as BoardManifest;
  if (!m || typeof m !== 'object' || !boardSlug(id) || m.id !== id || m.apiVersion !== 1 || m.entry !== 'index.html' ||
    typeof m.name !== 'string' || !m.name.trim() || m.name.length > 80 || typeof m.version !== 'string' || m.version.length > 40 ||
    typeof m.enabled !== 'boolean' || !Array.isArray(m.capabilities) || m.capabilities.length > BOARD_CAPABILITIES.length ||
    m.capabilities.some(c => !BOARD_CAPABILITIES.includes(c)) || new Set(m.capabilities).size !== m.capabilities.length ||
    m.description !== undefined && (typeof m.description !== 'string' || m.description.length > 300) ||
    m.order !== undefined && (!Number.isSafeInteger(m.order) || Math.abs(m.order) > 10000) ||
    m.height !== undefined && (!Number.isSafeInteger(m.height) || m.height < 160 || m.height > 800)) throw new Error('invalid_board_manifest');
  return m;
}
export function parseBoardSchedules(value: unknown): { jobs: BoardSchedule[] } {
  const data = value as { jobs: BoardSchedule[] };
  if (!data || !Array.isArray(data.jobs) || data.jobs.length > 100) throw new Error('invalid_board_schedules');
  const ids = new Set<string>();
  for (const job of data.jobs) {
    if (!job || !boardSlug(job.id) || ids.has(job.id) || typeof job.prompt !== 'string' || !job.prompt.trim() || job.prompt.length > 12000 ||
      typeof job.threadId !== 'string' || !job.threadId || job.threadId.length > 100 || typeof job.enabled !== 'boolean' ||
      typeof job.nextRunAt !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(job.nextRunAt) || !Number.isFinite(Date.parse(job.nextRunAt)) ||
      job.everySeconds !== undefined && (!Number.isSafeInteger(job.everySeconds) || job.everySeconds < 60 || job.everySeconds > 31536000)) throw new Error('invalid_board_schedules');
    ids.add(job.id);
  }
  return data;
}
