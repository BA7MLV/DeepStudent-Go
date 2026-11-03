import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { BoardFiles } from './files.js';
import type { CloudTaskRunner } from '../cloud/tasks.js';
import type { BotApplicationService } from '../agent/service.js';
import { BoardTasks } from './tasks.js';
import { PluginFiles } from '../plugins/files.js';

export function registerBoardRoutes(app: FastifyInstance, files: BoardFiles, runner: CloudTaskRunner, bots: BotApplicationService,
  auth: (r: FastifyRequest, p: FastifyReply) => { id: string } | null,
  origin: (r: FastifyRequest, p: FastifyReply) => boolean) {
  const tasks = new BoardTasks(files.store);
  const unified = new PluginFiles(files.store);
  const activePlugin = (owner: string, id: string) => { if (unified.plugin(owner, id).source !== 'v1') throw new Error('board_plugin_unavailable'); return files.plugin(owner, id); };
  const safe = async (reply: FastifyReply, action: () => unknown) => {
    try { return await action(); } catch (e) {
      const error = e instanceof Error && /^[a-z_]+$/.test(e.message) ? e.message : 'board_request_failed';
      return reply.code(error.includes('conflict') || error === 'board_plugin_changed' ? 409 : error.includes('denied') ? 403 : error.endsWith('not_found') ? 404 : 400).send({ error });
    }
  };
  app.get('/api/v1/board/plugins', async (r, p) => {
    const user = auth(r, p); if (!user) return;
    return safe(p, () => { const catalog = unified.catalog(user.id); return { plugins: files.catalog(user.id).map(p => { const current = catalog.find(row => row.id === p.id && row.source === 'v1'); return { ...p, error: current?.error ?? p.error, manifest: p.manifest ? { ...p.manifest, enabled: !!current?.manifest?.enabled && !current.error } : undefined }; }) }; });
  });
  app.get<{ Params: { id: string } }>('/api/v1/board/plugins/:id', async (r, p) => {
    const user = auth(r, p); if (!user) return;
    return safe(p, () => {
      const plugin = activePlugin(user.id, r.params.id);
      return { ...plugin, html: files.read(user.id, `${plugin.path}/index.html`).content };
    });
  });
  app.post<{ Params: { id: string }; Body: { revision: number; method: string; args?: Record<string, unknown> } }>('/api/v1/board/plugins/:id/rpc', async (r, p) => {
    if (!origin(r, p)) return;
    const user = auth(r, p); if (!user) return;
    return safe(p, async () => {
      const plugin = activePlugin(user.id, r.params.id), body = r.body;
      if (!body || body.revision !== plugin.revision) throw new Error('board_plugin_changed');
      const args = body.args ?? {};
      const capability = body.method?.startsWith('tasks.') ? 'tasks' : body.method?.startsWith('schedules.') ? 'schedules' : 'state';
      if (!plugin.manifest.capabilities.includes(capability)) throw new Error('board_capability_denied');
      if (body.method === 'state.read' || body.method === 'schedules.read') return files.read(user.id, `${plugin.path}/${capability === 'schedules' ? 'schedules' : 'state'}.json`);
      if (body.method === 'state.write' || body.method === 'schedules.write') return files.save(user.id, `${plugin.path}/${capability === 'schedules' ? 'schedules' : 'state'}.json`, JSON.stringify(args.data, null, 2) + '\n', args.expected as string, args.revision as number);
      if (body.method === 'schedules.threads') return { threads: files.store.db.prepare("SELECT id,title FROM threads WHERE owner_id=? AND mode='bot' AND archived=0 ORDER BY updated_at DESC LIMIT 200").all(user.id) };
      if (body.method === 'tasks.list') return { tasks: tasks.list(user.id) };
      if (body.method === 'tasks.get') return tasks.get(user.id, args.id);
      if (body.method === 'tasks.start') return tasks.start(user.id, plugin.id, bots, args);
      if (body.method === 'tasks.open') {
        const task = tasks.get(user.id, args.id);
        if (task.kind !== 'bot') throw new Error('invalid_bot_task');
        return { threadId: task.threadId };
      }
      if (body.method === 'tasks.cancel') {
        const task = tasks.get(user.id, args.id);
        if (task.kind === 'bot') bots.cancelRun(user.id, task.runId);
        else {
          files.store.db.prepare("UPDATE cloud_tasks SET status='cancelled',updated_at=? WHERE id=? AND owner_id=? AND status IN ('queued','running','waiting_user')").run(new Date().toISOString(), task.id, user.id);
          await runner.cancel(task.id);
        }
        return { cancelled: tasks.get(user.id, task.id).status === 'cancelled' };
      }
      throw new Error('invalid_board_method');
    });
  });
}
