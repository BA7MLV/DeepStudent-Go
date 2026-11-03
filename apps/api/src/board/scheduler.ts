import crypto from 'node:crypto';
import { parseBoardSchedules } from '@wangke/contracts/board';
import { BoardFiles } from './files.js';
import type { BotApplicationService } from '../agent/service.js';
import { BoardTasks } from './tasks.js';
import { PLUGIN_DATA_PATH, parsePluginLayout } from '@wangke/contracts/plugins';
import { PluginFiles } from '../plugins/files.js';

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
      const unified = new PluginFiles(this.files.store);
      let packages, instances;
      try { packages = unified.catalog(owner.id); instances = parsePluginLayout(JSON.parse(unified.layout(owner.id).content)).instances; } catch { continue; }
      const plugins = packages.flatMap(plugin => {
        if (plugin.error && !['plugin_uninstalled', 'plugin_dependency_unavailable'].includes(plugin.error) || !plugin.manifest?.capabilities.includes('schedules')) return [];
        const legacy = plugin.source === 'v1' ? [{ ...plugin, scope: { kind: 'account' } as const, resource: `${plugin.path}/schedules.json`, nonceScope: plugin.id }] : [];
        return [...legacy, ...instances.filter(i => i.pluginId === plugin.id && !(plugin.source === 'v1' && i.id === `legacy-${plugin.id}`)).map(i => ({ ...plugin, scope: i.scope, resource: `${PLUGIN_DATA_PATH}/${plugin.id}/instances/${i.id}/schedules.json`, nonceScope: `${plugin.id}\0${i.id}` }))];
      });
      for (const plugin of plugins) {
        if (!plugin.manifest?.capabilities.includes('schedules')) continue;
        const resource = plugin.resource;
        const files = resource.startsWith('/system/board/') ? this.files : unified;
        try {
          unified.validateScope(owner.id, plugin.scope);
          const document = files.read(owner.id, resource);
          const data = parseBoardSchedules(JSON.parse(document.content));
          this.files.store.transaction(() => {
            for (const job of data.jobs) {
              if (!plugin.error && plugin.manifest!.enabled && job.enabled && Date.parse(job.nextRunAt) <= time) try {
                const thread = this.bots.thread(owner.id, job.threadId);
                if (thread.mode !== 'bot') throw new Error('board_thread_not_found');
                if (plugin.scope.kind !== 'account') {
                  const projectThread = unified.projects.thread(job.threadId);
                  if (plugin.scope.kind !== 'project' || projectThread.project_id !== plugin.scope.id) throw new Error('plugin_project_thread_denied');
                }
                const nonce = `board:${crypto.createHash('sha256').update(`${plugin.nonceScope}\0${job.id}\0${job.nextRunAt}`).digest('hex')}`;
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
            if (content !== document.content) files.save(owner.id, resource, content, document.content, document.revision);
          });
        } catch { /* A malformed, removed or concurrently edited plugin cannot stop other jobs. */ }
      }
    }
  }
}
