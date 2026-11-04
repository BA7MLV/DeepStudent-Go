import crypto from 'node:crypto';
import type { DatabaseStore } from '../storage/database.js';
import { appendAudit } from '../storage/audit.js';
import { readBotActivity } from './activity.js';

export type BotLifecycleEvent = {
  id: string; at: string; owner: string; thread?: string; run?: string; step?: string; requestId?: string;
  type: 'run.started' | 'run.paused' | 'run.finished' | 'model.started' | 'model.finished' | 'tool.started' | 'tool.finished' | 'approval.waiting' | 'compaction.saved' | 'memory.saved' | 'memory.deleted' | 'delivery.finished';
  status?: string;
};
export type BotEventHook = (event: Readonly<BotLifecycleEvent>) => void | Promise<void>;
/** Observers cannot turn a successful commit into an unknown side effect.
 * Authorization and budget checks must never go through this best-effort API. */
export function publishBotEvent(store: DatabaseStore, input: Omit<BotLifecycleEvent, 'id' | 'at'>, hook?: BotEventHook) {
  const event = Object.freeze({ ...input, id: crypto.randomUUID(), at: new Date().toISOString() });
  appendAudit(store, event.owner, `bot.${event.type}`, event, event.at);
  // Reuse the durable, authorized Web stream. This is not a chat message and
  // must never be projected to IM or leak tool arguments through diagnostics.
  if (event.run && ['run.started', 'run.paused', 'run.finished', 'model.started', 'model.finished', 'tool.started', 'tool.finished', 'approval.waiting'].includes(event.type)) {
    try {
      store.transaction(() => {
        const thread = store.db.prepare("SELECT t.id FROM runs r JOIN threads t ON t.id=r.thread_id WHERE r.id=? AND t.owner_id=? AND t.mode='bot'").get(event.run, event.owner) as { id: string } | undefined;
        if (!thread) return;
        const activity = readBotActivity(store, thread.id);
        store.db.prepare("INSERT INTO message_events(id,thread_id,seq,type,payload,created_at) VALUES(?,?,0,'thread.activity',?,?)")
          .run(event.id, thread.id, JSON.stringify({ activity }), event.at);
      });
    } catch { console.error('bot_activity_persistence_unavailable'); }
  }
  if (hook) void Promise.resolve().then(() => hook(event)).catch(() => console.error('bot_event_observer_failed'));
}
