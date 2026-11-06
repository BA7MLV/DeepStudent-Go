import crypto from 'node:crypto';
import { wakeInteractions } from './interaction-wake.js';
import { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { DatabaseStore } from '../storage/database.js';
import { CloudRecords, CloudConflict } from './records.js';
import { CloudConfiguration, ModelConfigurationError } from './config.js';
import { CloudTaskRunner, taskDto, listOwnerTasks, TASK_KINDS } from './tasks.js';
import type { CloudConfig, CloudMutation } from '@wangke/contracts/cloud';
import type { ModelSettingsUpdate, ProviderSettingsUpdate } from '@wangke/contracts/model-settings';
import { BudgetBlocked } from '../agent/budget.js';
import { ModelFailure } from '../agent/model-client.js';
import { createModelGateway } from '../agent/model-gateway-factory.js';
import { ModelGatewayFailure } from '../agent/model-errors.js';
import { gatewayDisabledPurposes } from '../agent/model-rollout.js';
import { modelUsageReport } from '../agent/model-observations.js';
import type { WebSearchService } from '../web-search/service.js';
import { PluginFiles } from '../plugins/files.js';
import type { McpManager } from '../mcp/manager.js';
import { submitOwnerTask } from './task-commands.js';
import { TaskDelegationService } from './delegation.js';
import { validateAskAnswer, type AskUserData, type AskUserAnswer } from '@wangke/study-core/ask-user';

interface Dependencies {
  mcp?: McpManager;
  webSearch?: WebSearchService;
  store: DatabaseStore; records: CloudRecords; configuration: CloudConfiguration;
  requireAuth: (request: FastifyRequest, reply: FastifyReply) => any;
  checkOrigin: (request: FastifyRequest, reply: FastifyReply) => boolean;
  filesDir: string; maxFileBytes: number; fetch?: typeof fetch;
  canStart?: () => boolean;
}

export function registerCloudRoutes(app: FastifyInstance, deps: Dependencies) {
  const { store, records, configuration, requireAuth, checkOrigin } = deps;
  const runner = new CloudTaskRunner(store, { records, configuration, filesDir: deps.filesDir, fetch: deps.fetch, webSearch: deps.webSearch, mcp: deps.mcp });
  const fail = (reply: FastifyReply, code: number, error: string) => reply.code(code).send({ error });
  const configurationError = (reply: FastifyReply, e: unknown) => e instanceof ModelConfigurationError
    ? reply.code(e.status).send({ error: e.message, issues: e.issues })
    : fail(reply, 400, e instanceof Error ? e.message : 'invalid_config');
  const ownedTask = (owner: string, id: string) => store.db.prepare('SELECT * FROM cloud_tasks WHERE id=? AND owner_id=?').get(id, owner) as any;
  const authorize = (request: FastifyRequest, reply: FastifyReply, admin = false) => {
    if (!['GET', 'HEAD'].includes(request.method) && !checkOrigin(request, reply)) return null;
    const user = requireAuth(request, reply);
    return user;
  };
  app.addHook('onListen', async () => {
    if (process.env.CLOUD_WORKER_DISABLED === '1' || deps.canStart?.() === false) return;
    const address = app.server.address();
    if (address && typeof address === 'object') runner.start(`http://127.0.0.1:${address.port}`);
  });

  app.get('/api/v1/cloud/status', async () => ({ cloud: true, maxFileBytes: deps.maxFileBytes,
    passkeyConfigured: Boolean(process.env.PUBLIC_ORIGIN && process.env.WEBAUTHN_RP_ID), singleUser: true }));
  app.get('/api/v1/cloud/config', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return configuration.get(user.id);
  });
  app.get<{ Querystring: { days?: string; start?: string; end?: string; source?: string } }>('/api/v1/cloud/model-usage', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const { start, end, days, source = 'all' } = request.query;
    if (source !== 'all' && source !== 'chat' && source !== 'bot') return fail(reply, 400, 'invalid_usage_source');
    const now = new Date(Date.now() + 1).toISOString(); // exclusive bound, includes this millisecond
    let since: string, until = now;
    if (start !== undefined || end !== undefined) {
      const validDate = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
        && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
      if (days !== undefined || !validDate(start) || !validDate(end)) return fail(reply, 400, 'invalid_usage_window');
      const span = (Date.parse(end) - Date.parse(start)) / 86400000 + 1;
      if (span < 1 || span > 90) return fail(reply, 400, 'invalid_usage_window');
      since = new Date(start).toISOString();
      until = new Date(Date.parse(end) + 86400000).toISOString();
    } else {
      if (days !== undefined && (typeof days !== 'string' || !/^\d+$/.test(days))) return fail(reply, 400, 'invalid_usage_window');
      const count = Number(days ?? 1);
      if (!Number.isInteger(count) || count < 1 || count > 90) return fail(reply, 400, 'invalid_usage_window');
      since = new Date(Date.parse(now) - count * 86400000).toISOString();
    }
    reply.header('cache-control', 'no-store');
    return modelUsageReport(store, user.id, since, { until, source });
  });
  app.put<{ Body: CloudConfig }>('/api/v1/cloud/config', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.save(user.id, request.body); }
    catch (e) { return configurationError(reply, e); }
  });
  app.put<{ Body: ModelSettingsUpdate }>('/api/v1/cloud/model-settings', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.saveModels(user.id, request.body); }
    catch (e) { return configurationError(reply, e); }
  });
  app.put<{ Params: { id: string }; Body: ProviderSettingsUpdate }>('/api/v1/cloud/providers/:id', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.saveProvider(user.id, request.params.id, request.body); }
    catch (e) { return configurationError(reply, e); }
  });
  app.get<{ Params: { id: string } }>('/api/v1/cloud/providers/:id/accounts', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    try { return configuration.providerAccounts(user.id, request.params.id); }
    catch (e) { return configurationError(reply, e); }
  });
  app.post<{ Params: { id: string }; Body: { name?: string; apiKey?: string; modelRevision?: string } }>('/api/v1/cloud/providers/:id/accounts', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.addProviderAccount(user.id, request.params.id, request.body); }
    catch (e) { return configurationError(reply, e); }
  });
  app.put<{ Params: { id: string; accountId: string }; Body: { modelRevision?: string } }>('/api/v1/cloud/providers/:id/accounts/:accountId/active', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.activateProviderAccount(user.id, request.params.id, request.params.accountId, request.body?.modelRevision ?? ''); }
    catch (e) { return configurationError(reply, e); }
  });
  app.delete<{ Params: { id: string; accountId: string }; Body: { modelRevision?: string } }>('/api/v1/cloud/providers/:id/accounts/:accountId', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    try { return configuration.removeProviderAccount(user.id, request.params.id, request.params.accountId, request.body?.modelRevision ?? ''); }
    catch (e) { return configurationError(reply, e); }
  });
  app.get<{ Querystring: { after?: string } }>('/api/v1/cloud/records', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return fail(reply, 400, 'invalid_cursor');
    // Record feeds must not mutate workspace files or depend on sandbox leases.
    const result = records.list(user.id, after);
    return { records: result, cursor: result.at(-1)?.revision ?? after, more: result.length === 200 };
  });
  app.get<{ Querystring: { table: string; key: string } }>('/api/v1/cloud/record', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    try { return { value: records.get(user.id, request.query.table, JSON.parse(request.query.key)) }; }
    catch { return fail(reply, 400, 'invalid_record_key'); }
  });
  const commitRecords = async (request: FastifyRequest<{ Body: { mutations: CloudMutation[] }; Params: { id?: string } }>, reply: FastifyReply) => {
    const user = authorize(request, reply); if (!user) return;
    return fail(reply, 410, 'domain_command_required');
  };
  app.post('/api/v1/cloud/records', commitRecords);

  // Gateway credentials come exclusively from saved configuration. No caller-controlled URL,
  // Authorization forwarding or redirects (which could leak a provider credential).
  for (const route of ['/api/v1/cloud/models/:provider/*', '/api/v1/cloud/model-gateway/providers/:provider/*']) app.route<{ Params: { provider: string; '*': string } }>({
    method: ['GET', 'POST'], url: route,
    onRequest: async (request, reply) => { authorize(request, reply); },
    handler: async (request, reply) => {
      const user = authorize(request, reply); if (!user) return;
      const provider = configuration.get(user.id).providers.find(p => p.id === request.params.provider);
      const endpoint = request.params['*'];
      if (!provider || !['models', 'chat/completions', 'responses', 'messages', 'audio/transcriptions', 'systemone'].includes(endpoint)) return fail(reply, 404, 'model_endpoint_not_found');
      if ((endpoint === 'models') !== (request.method === 'GET')) return fail(reply, 405, 'method_not_allowed');
      const disconnected = new AbortController();
      request.raw.once('aborted', () => disconnected.abort());
      reply.raw.once('close', () => { if (!reply.raw.writableEnded) disconnected.abort(); });
      // The gateway owns model deadlines (first token / idle / total). This
      // layer only cancels when the browser disconnects; a second fixed timer
      // here would silently override a longer configured stream budget.
      const init: RequestInit & { duplex?: 'half' } = { signal: disconnected.signal };
      if (request.method === 'POST') {
        if (request.body instanceof Readable) { init.body = request.body as any; init.duplex = 'half'; }
        else {
          init.body = JSON.stringify(request.body);
        }
      }
      try {
        const pagination = new URLSearchParams();
        if (endpoint === 'models') {
          const query = new URL(request.url, 'http://localhost').searchParams;
          for (const key of ['after_id', 'limit']) {
            const value = query.get(key);
            if (value !== null) pagination.set(key, value);
          }
        }
        const cacheKey = request.headers['x-wangke-cache-key'];
        const scopedKey = typeof cacheKey === 'string' && cacheKey.length <= 200 ? crypto.createHash('sha256').update(`${user.id}:${cacheKey}`).digest('hex') : undefined;
        const model = endpoint === 'models' ? '' : typeof request.body === 'object' && request.body && 'model' in request.body && typeof request.body.model === 'string' ? request.body.model
          : endpoint === 'audio/transcriptions' ? configuration.get(user.id).asrModel.model : endpoint === 'systemone' ? configuration.get(user.id).decisionModel?.model ?? '' : '';
        const response = await createModelGateway(store, configuration, deps.fetch ?? fetch).forward({ owner: user.id,
          purpose: endpoint === 'audio/transcriptions' ? 'asr' : endpoint === 'systemone' ? 'decision' : 'chat', modelRef: { providerId: provider.id, model }, endpoint,
          body: init.body, contentType: request.headers['content-type'], signal: init.signal!, pagination, cacheKey: scopedKey,
          conversationId: typeof request.headers['x-wangke-conversation'] === 'string' ? request.headers['x-wangke-conversation'] : undefined,
          attribution: { purpose: 'chat' } });
        if (!response.ok) {
          const retryAfter = response.headers.get('retry-after');
          if (retryAfter) reply.header('retry-after', retryAfter);
          await response.body?.cancel();
          return fail(reply, response.status, `model_http_${response.status}`);
        }
        reply.header('content-type', response.headers.get('content-type') ?? 'application/json');
        reply.header('cache-control', 'no-store');
        return response.body ? reply.send(Readable.fromWeb(response.body as any)) : reply.send('');
      } catch (error) {
        if (error instanceof BudgetBlocked) {
          return fail(reply, 429, error.code);
        }
        if (error instanceof ModelFailure) return fail(reply, 502, error.code);
        return fail(reply, 502, 'model_connection_failed');
      }
    },
  });

  app.post<{ Body: import('@wangke/contracts/cloud').ModelGatewayInput }>('/api/v1/cloud/model-gateway/request', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const input = request.body;
    const allowed = ['purpose', 'presetId', 'modelRef', 'messages', 'tools', 'image', 'audio', 'outputTokens', 'cacheKey', 'conversationId', 'idempotencyKey', 'continuationRef', 'sideEffectsOccurred', 'thinkingLevel', 'temperature', 'toolChoice'];
    if (!input || typeof input !== 'object' || Object.keys(input).some(k => !allowed.includes(k)) || !['chat', 'bot', 'vision', 'asr', 'decision', 'memory'].includes(input.purpose)) return fail(reply, 400, 'invalid_gateway_request');
    const disconnected = new AbortController();
    request.raw.once('aborted', () => disconnected.abort());
    reply.raw.once('close', () => { if (!reply.raw.writableEnded) disconnected.abort(); });
    try {
      return await createModelGateway(store, configuration, deps.fetch ?? fetch).request({ ...input, owner: user.id, signal: disconnected.signal });
    } catch (error) {
      if (error instanceof BudgetBlocked) return fail(reply, 429, error.code);
      if (error instanceof ModelGatewayFailure) return reply.code(502).send({ error: error.code, errorClass: error.errorClass, traceId: error.traceId, attempts: error.attempts });
      return fail(reply, 400, 'invalid_gateway_request');
    }
  });

  app.get('/api/v1/cloud/model-gateway/status', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const config = configuration.get(user.id);
    return {
      circuits: createModelGateway(store, configuration, deps.fetch ?? fetch).health(user.id),
      providers: config.providers.map(p => ({ id: p.id, configured: p.configured, protocol: p.protocol, dataPolicy: p.dataPolicy ?? 'default' })),
      presets: (config.modelPresets ?? []).map(p => ({ id: p.id, purposes: p.purposes, candidates: p.candidates.map(c => ({ ref: c.ref, enabled: c.enabled !== false, providerExists: config.providers.some(provider => provider.id === c.ref.providerId) })) })),
      recentRoutes: (store.db.prepare("SELECT action,detail,created_at AS createdAt FROM cloud_audit WHERE owner_id=? AND action LIKE 'model.route.%' ORDER BY id DESC LIMIT 50").all(user.id) as Array<{ action: string; detail: string; createdAt: string }>).map(r => ({ ...r, detail: JSON.parse(r.detail) })),
      recentUsage: (store.db.prepare("SELECT detail,created_at AS createdAt FROM cloud_audit WHERE owner_id=? AND action='model.metric' ORDER BY id DESC LIMIT 50").all(user.id) as Array<{ detail: string; createdAt: string }>).map(r => ({ ...JSON.parse(r.detail), createdAt: r.createdAt })),
      disabledPurposes: gatewayDisabledPurposes(),
    };
  });
  app.get('/api/v1/cloud/model-presets', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const { modelRevision, modelPresets, modelRoutes } = configuration.get(user.id);
    return { modelRevision, modelPresets, modelRoutes };
  });
  // Atomic collection replacement supports create/edit/delete/default changes in one CAS.
  app.put<{ Body: Pick<import('@wangke/contracts/cloud').CloudConfig, 'modelPresets' | 'modelRoutes'> & { modelRevision: string } }>('/api/v1/cloud/model-presets', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const input = request.body;
    if (!input || typeof input.modelRevision !== 'string' || !input.modelRevision || !Array.isArray(input.modelPresets) || !input.modelRoutes || Object.keys(input).some(k => !['modelRevision', 'modelPresets', 'modelRoutes'].includes(k))) return fail(reply, 400, 'invalid_model_presets');
    try {
      const saved = configuration.saveModels(user.id, { ...configuration.get(user.id), modelRevision: input.modelRevision, modelPresets: input.modelPresets, modelRoutes: input.modelRoutes });
      return { modelRevision: saved.modelRevision, modelPresets: saved.modelPresets, modelRoutes: saved.modelRoutes };
    } catch (error) {
      if (error instanceof ModelConfigurationError) return reply.code(error.status).send({ error: error.message, issues: error.issues });
      return fail(reply, 400, 'invalid_model_presets');
    }
  });
  app.post<{ Body: { purpose: import('@wangke/contracts/cloud').ModelPurpose; presetId?: string; modelRef?: import('@wangke/contracts/cloud').ModelRef } }>('/api/v1/cloud/model-gateway/preview', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const input = request.body;
    if (!input || !['chat', 'bot', 'vision', 'asr', 'decision', 'memory'].includes(input.purpose) || Object.keys(input).some(k => !['purpose', 'presetId', 'modelRef'].includes(k))) return fail(reply, 400, 'invalid_gateway_request');
    try {
      const { preset, candidates } = createModelGateway(store, configuration, deps.fetch ?? fetch).resolver.resolve({ ...input, owner: user.id });
      return { presetId: preset?.id, candidates: candidates.map(({ adapter, privacy, allowFallback }, index) => ({ ...adapter.target, candidateIndex: index, dataPolicy: privacy, fallbackAllowed: index === 0 || allowFallback && candidates[0].allowFallback && privacy === candidates[0].privacy && (adapter.target.providerId === candidates[0].adapter.target.providerId || preset?.policy?.allowCrossProvider !== false) })), discoveryIsAuthorization: false };
    } catch { return fail(reply, 400, 'invalid_model_route'); }
  });

  app.get('/api/v1/cloud/tasks', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return { tasks: listOwnerTasks(store, user.id) };
  });
  app.post<{ Body: { nonce: string; kind: string; resource: string; input: Record<string, unknown> } }>('/api/v1/cloud/tasks', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const b = request.body;
    if (!b || !TASK_KINDS.includes(b.kind as any) || typeof b.nonce !== 'string' || b.nonce.length > 100 || !b.nonce ||
        typeof b.resource !== 'string' || b.resource.length > 256 || !b.resource || !b.input || typeof b.input !== 'object' || Array.isArray(b.input)) return fail(reply, 400, 'invalid_task');
    const previous = store.db.prepare('SELECT * FROM cloud_tasks WHERE owner_id=? AND nonce=?').get(user.id, b.nonce);
    try {
      const task = submitOwnerTask(store, records, configuration, user.id, { operationId: b.nonce,
        kind: b.kind as import('@wangke/contracts/cloud').CloudTaskKind, resource: b.resource,
        input: b.input as Record<string, import('@wangke/contracts/client-runtime').RuntimeJson> });
      return reply.code(previous ? 200 : 201).send(task);
    } catch (error) {
      if (error instanceof Error && ['task_nonce_conflict', 'handout_edit_conflict', 'context_compression_conflict'].includes(error.message)) return fail(reply, 409, error.message);
      if (error instanceof Error && ['session_not_found', 'handout_not_found'].includes(error.message)) return fail(reply, 404, error.message);
      if (error instanceof Error && ['invalid_handout_persist', 'invalid_context_compression', 'invalid_context_compression_expected', 'context_compression_history_too_large'].includes(error.message)) return fail(reply, 400, error.message);
      return fail(reply, 403, 'plugin_unavailable');
    }
  });
  app.get<{ Params: { id: string } }>('/api/v1/cloud/tasks/:id', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    const task = ownedTask(user.id, request.params.id);
    return task ? taskDto(task) : fail(reply, 404, 'task_not_found');
  });
  app.post<{ Params: { id: string } }>('/api/v1/cloud/tasks/:id/cancel', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const task = ownedTask(user.id, request.params.id); if (!task) return fail(reply, 404, 'task_not_found');
    new TaskDelegationService(store, configuration).command(user.id, { action: 'cancel', taskId: task.id });
    await runner.cancel(task.id);
    configuration.audit(user.id, 'task.cancelled', { id: task.id });
    return { cancelled: true };
  });
  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/v1/cloud/tasks/:id/events', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    if (!ownedTask(user.id, request.params.id)) return fail(reply, 404, 'task_not_found');
    const after = Number(request.query.after ?? 0);
    if (!Number.isSafeInteger(after) || after < 0) return fail(reply, 400, 'invalid_cursor');
    return { events: (store.db.prepare('SELECT seq,event FROM cloud_task_events WHERE task_id=? AND seq>? ORDER BY seq LIMIT 500').all(request.params.id, after) as any[]).map(r => ({ seq: r.seq, ...JSON.parse(r.event) })) };
  });

  app.post<{ Params: { id: string }; Body: { nonce: string; action: string; value?: unknown } }>('/api/v1/cloud/tasks/:id/commands', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    const task = ownedTask(user.id, request.params.id);
    if (!task || !['running', 'waiting_user'].includes(task.status)) return fail(reply, 409, 'task_not_running');
    if (task.executor !== 'node') return fail(reply, 409, 'legacy_executor_read_only');
    const b = request.body;
    if (!b || typeof b.nonce !== 'string' || b.nonce.length > 100 || !['answerAsk','confirmPlan','cancelPlan'].includes(b.action)) return fail(reply, 400, 'invalid_task_command');
    const value = JSON.stringify(b.value ?? null);
    const previous = store.db.prepare('SELECT action,value FROM cloud_task_commands WHERE task_id=? AND nonce=?').get(task.id, b.nonce) as { action: string; value: string } | undefined;
    if (previous && (previous.action !== b.action || previous.value !== value)) return fail(reply, 409, 'task_command_nonce_conflict');
    store.transaction(() => {
      store.db.prepare('INSERT OR IGNORE INTO cloud_task_commands(task_id,nonce,action,value) VALUES(?,?,?,?)').run(task.id, b.nonce, b.action, value);
    });
    wakeInteractions(store, task.id);
    return { ok: true };
  });

  app.get('/api/v1/cloud/permissions', async (request, reply) => {
    const user = authorize(request, reply); if (!user) return;
    return { permissions: store.db.prepare('SELECT id,task_id AS taskId,capability,arguments,status,created_at AS createdAt FROM cloud_permissions WHERE owner_id=? ORDER BY created_at DESC LIMIT 100').all(user.id) };
  });
  app.post<{ Params: { id: string }; Body: { approved: boolean } }>('/api/v1/cloud/permissions/:id/resolve', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    if (typeof request.body?.approved !== 'boolean') return fail(reply, 400, 'invalid_decision');
    const status = request.body.approved ? 'approved' : 'rejected';
    const changed = store.db.prepare("UPDATE cloud_permissions SET status=?,resolved_at=? WHERE id=? AND owner_id=? AND status IN ('pending','approved') AND task_id IN (SELECT id FROM cloud_tasks WHERE status IN ('running','waiting_user'))").run(status, new Date().toISOString(), request.params.id, user.id);
    if (!changed.changes) return fail(reply, 409, 'permission_already_resolved');
    const permission = store.db.prepare('SELECT task_id FROM cloud_permissions WHERE id=? AND owner_id=?').get(request.params.id, user.id) as { task_id: string };
    wakeInteractions(store, permission.task_id);
    configuration.audit(user.id, 'permission.resolved', { id: request.params.id, status });
    return { status };
  });
  app.get('/api/v1/cloud/audit', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    return { entries: store.db.prepare('SELECT action,detail,created_at AS createdAt FROM cloud_audit WHERE owner_id=? ORDER BY id DESC LIMIT 100').all(user.id) };
  });
  app.get('/api/v1/cloud/passkeys', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    return { passkeys: store.db.prepare('SELECT id,created_at AS createdAt FROM passkey_credentials WHERE user_id=? ORDER BY created_at').all(user.id) };
  });
  app.delete<{ Params: { id: string } }>('/api/v1/cloud/passkeys/:id', async (request, reply) => {
    const user = authorize(request, reply, true); if (!user) return;
    store.db.prepare('DELETE FROM passkey_credentials WHERE id=? AND user_id=?').run(request.params.id, user.id);
    configuration.audit(user.id, 'passkey.removed', { id: request.params.id });
    return { removed: true };
  });
  return runner;
}
