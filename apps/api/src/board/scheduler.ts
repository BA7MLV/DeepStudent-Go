import crypto from 'node:crypto';
import { parseBoardSchedules } from '@wangke/contracts/board';
import { BoardFiles } from './files.js';
import type { BotApplicationService } from '../agent/service.js';
import { BoardTasks } from './tasks.js';

/** Durable jobs are files; Bot message deduplication makes crash replay idempotent. */
export class BoardScheduler {
  private timer?: ReturnType<typeof setInterval>;
  constructor(private files: BoardFiles, private bots: BotApplicationService) {}
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { try { this.tick(); } catch { console.error('board_scheduler_unavailable'); } }, 5000);
    this.timer.unref();
  }
  close() { clearInterval(this.timer); this.timer = undefined; }
  tick(time = Date.now()) {
    const tasks = new BoardTasks(this.files.store);
    const owners = this.files.store.db.prepare('SELECT id FROM users').all() as { id: string }[];
    for (const owner of owners) {
      let plugins;
      try { plugins = this.files.catalog(owner.id); } catch { continue; }
      for (const plugin of plugins) {
        if (!plugin.manifest?.capabilities.includes('schedules')) continue;
        const resource = `${plugin.path}/schedules.json`;
        try {
          const document = this.files.read(owner.id, resource);
          const data = parseBoardSchedules(JSON.parse(document.content));
          this.files.store.transaction(() => {
            for (const job of data.jobs) {
              if (plugin.manifest!.enabled && job.enabled && Date.parse(job.nextRunAt) <= time) try {
                const thread = this.bots.thread(owner.id, job.threadId);
                if (thread.mode !== 'bot') throw new Error('board_thread_not_found');
                const nonce = `board:${crypto.createHash('sha256').update(`${plugin.id}\0${job.id}\0${job.nextRunAt}`).digest('hex')}`;
                const message = this.bots.send(owner.id, job.threadId, { clientNonce: nonce, content: job.prompt });
                job.lastMessageId = message.id;
                job.lastRunAt = new Date(time).toISOString();
                delete job.error;
                if (job.everySeconds) {
                  const step = job.everySeconds * 1000, previous = Date.parse(job.nextRunAt);
                  // Coalesce downtime; do not flood a conversation with missed intervals.
                  job.nextRunAt = new Date(previous + (Math.floor((time - previous) / step) + 1) * step).toISOString();
                } else job.enabled = false;
              } catch (error) {
                job.enabled = false;
                job.error = error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : 'board_schedule_failed';
              }
              // Also reconcile one-shots and disabled schedules: their dispatched run is still real work.
              const task = typeof job.lastMessageId === 'string' ? tasks.forMessage(owner.id, job.threadId, job.lastMessageId) : undefined;
              if (task) job.lastTask = { id: task.id, status: task.status, completedAt: task.completedAt, error: task.error };
              else delete job.lastTask;
            }
            const content = JSON.stringify(data, null, 2) + '\n';
            if (content !== document.content) this.files.save(owner.id, resource, content, document.content, document.revision);
          });
        } catch { /* A malformed, removed or concurrently edited plugin cannot stop other jobs. */ }
      }
    }
  }
}
