import type { BotActivityDto } from '@wangke/contracts';
import type { DatabaseStore } from '../storage/database.js';

/** Read only persisted facts; omit arguments, command output, secrets and model narration. */
export function readBotActivity(store: DatabaseStore, thread: string): BotActivityDto | null {
  const db = store.db;
  const runs = db.prepare("SELECT id,status FROM runs WHERE thread_id=? AND status IN ('queued','running','waiting_user','waiting_event')").all(thread) as Array<{ id: string; status: string }>;
  if (!runs.length) return null;
  const counts = db.prepare(`SELECT s.status,COUNT(*) AS n FROM runs r JOIN run_steps s ON s.run_id=r.id
    WHERE r.thread_id=? AND r.status IN ('queued','running','waiting_user','waiting_event')
    AND (s.status='completed' OR s.status='running' AND r.status='running') GROUP BY s.status`).all(thread) as Array<{ status: string; n: number }>;
  const activeTools = counts.find(row => row.status === 'running')?.n ?? 0;
  const tools = db.prepare(`SELECT s.id,s.tool AS name FROM runs r JOIN run_steps s ON s.run_id=r.id
    WHERE r.thread_id=? AND r.status='running' AND s.status='running' ORDER BY s.created_at,s.id LIMIT 4`).all(thread) as BotActivityDto['tools'];
  const model = db.prepare(`SELECT 1 FROM runs r JOIN bot_requests q ON q.run_id=r.id
    WHERE r.thread_id=? AND r.status='running' AND q.purpose='bot' AND q.status='inflight' AND q.ended_at IS NULL LIMIT 1`).get(thread);
  const phase = activeTools ? 'tools' : model ? 'model' : runs.some(run => run.status === 'running') ? 'running'
    : runs.some(run => run.status === 'queued') ? 'queued' : runs.some(run => run.status === 'waiting_user') ? 'waiting_user' : 'waiting_event';
  return { phase, tools: tools.map(tool => ({ id: tool.id, name: tool.name.slice(0, 200) || 'unknown' })), activeTools, completedTools: counts.find(row => row.status === 'completed')?.n ?? 0 };
}
