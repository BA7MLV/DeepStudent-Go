import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseStore } from '../storage/database.js';
import { DEFAULT_AGENT_POLICY, type CloudConfig, type CloudProvider, type CloudProviderAccount } from '@wangke/contracts/cloud';
import { validateBudget } from '../agent/budget.js';
import { MODEL_FIELDS, modelReferenceIssues, type ModelSettingsIssue, type ModelSettingsUpdate, type ProviderSettingsUpdate } from '@wangke/contracts/model-settings';
import { migrateModelPresets, validateModelPresets, PresetConfigurationError } from './model-presets.js';
import { validateModelDeployments } from './model-deployments.js';
import { GO_PROVIDER, goBase } from '../agent/opencode-go.js';

export class ModelConfigurationError extends Error {
  constructor(message: string, readonly issues: ModelSettingsIssue[] = [], readonly status = 400) { super(message); }
}

/** Short credentials must not be revealed in full, even as a display hint. */
function keyHint(key: string | undefined): string | undefined {
  if (!key) return undefined;
  return key.length > 8 ? `••••${key.slice(-4)}` : '••••（短密钥）';
}

export class CloudConfiguration {
  private key: Buffer;
  constructor(private store: DatabaseStore, directory: string) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const keyFile = path.join(directory, 'credentials.key');
    try { fs.writeFileSync(keyFile, crypto.randomBytes(32), { flag: 'wx', mode: 0o600 }); }
    catch (e: any) { if (e.code !== 'EEXIST') throw e; }
    this.key = fs.readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('invalid_credentials_key');
  }
  seal(value: string) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
  }
  open(value: string) {
    const bytes = Buffer.from(value, 'base64');
    const cipher = crypto.createDecipheriv('aes-256-gcm', this.key, bytes.subarray(0, 12));
    cipher.setAuthTag(bytes.subarray(12, 28));
    return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
  }
  get(owner: string, secrets = false): CloudConfig {
    const row = this.store.db.prepare('SELECT value FROM cloud_config WHERE owner_id=?').get(owner) as { value: string } | undefined;
    const value: CloudConfig = row ? JSON.parse(this.open(row.value)) : {
      providers: process.env.MODEL_API_KEY ? [{ id: 'server', name: '服务端模型', baseUrl: process.env.MODEL_BASE_URL || 'https://api.openai.com/v1', apiKey: process.env.MODEL_API_KEY, protocol: 'openai-chat', catalogId: '', serves: ['chat', 'vision', 'asr'] }] : [],
      llmModel: { providerId: process.env.MODEL_API_KEY ? 'server' : '', model: process.env.MODEL_API_KEY ? process.env.MODEL_NAME || 'gpt-4o-mini' : '' },
      visionModel: { providerId: '', model: '' }, asrModel: { providerId: '', model: '' },
      decisionModel: { providerId: '', model: '' },
      policy: { ...DEFAULT_AGENT_POLICY },
    };
    // A Go environment key is the simple single-key setup. It is intentionally
    // not bound to a project owner; saved accounts provide multi-key management.
    for (const provider of value.providers) if (provider.id === GO_PROVIDER) provider.apiKey = process.env.OPENCODE_GO_API_KEY?.trim() ?? '';
    Object.assign(value, migrateModelPresets(value));
    value.modelRevision = this.modelRevision(value);
    if (!secrets) for (const provider of value.providers) if (provider.accounts) {
      provider.accounts = provider.accounts.map(account => ({ id: account.id, name: account.name, configured: Boolean(account.apiKey), keyHint: keyHint(account.apiKey) }));
    }
    if (!secrets) value.providers = value.providers.map(({ apiKey, ...p }) => ({ ...p, configured: Boolean(apiKey), keyHint: keyHint(apiKey) }));
    return value;
  }
  private modelRevision(value: CloudConfig) {
    // Keyed digest also changes on credential rotation without exposing a secret fingerprint.
    return crypto.createHmac('sha256', this.key).update(JSON.stringify([
      value.providers, ...MODEL_FIELDS.map((slot) => value[slot] ?? { providerId: '', model: '' }), value.modelPresets, value.modelRoutes,
    ])).digest('hex');
  }
  saveModels(owner: string, update: ModelSettingsUpdate) {
    return this.store.transaction(() => this.saveModelsInTransaction(owner, update));
  }
  private saveModelsInTransaction(owner: string, update: ModelSettingsUpdate) {
    if (!update || typeof update.modelRevision !== 'string') throw new ModelConfigurationError('model_revision_required');
    const latest = this.get(owner, true);
    // Whitelist the scope: model settings can never overwrite policy, trust or budgets.
    return this.save(owner, { ...latest, modelRevision: update.modelRevision, providers: update.providers.map(provider => {
      const saved = latest.providers.find(existing => existing.id === provider.id);
      return saved?.accounts ? { ...provider, accounts: saved.accounts, activeAccountId: saved.activeAccountId } : provider;
    }),
      llmModel: update.llmModel, visionModel: update.visionModel, asrModel: update.asrModel, decisionModel: update.decisionModel,
      modelPresets: update.modelPresets ?? latest.modelPresets, modelRoutes: update.modelRoutes ?? latest.modelRoutes });
  }
  saveProvider(owner: string, id: string, update: ProviderSettingsUpdate) {
    return this.store.transaction(() => this.saveProviderInTransaction(owner, id, update));
  }
  private saveProviderInTransaction(owner: string, id: string, update: ProviderSettingsUpdate) {
    if (!update || typeof update.modelRevision !== 'string') throw new ModelConfigurationError('model_revision_required');
    if (!update.provider || update.provider.id !== id) throw new ModelConfigurationError('invalid_provider');
    const latest = this.get(owner, true);
    const exists = latest.providers.some((p) => p.id === id);
    const providers = exists ? latest.providers.map((p) => p.id === id ? {
      ...update.provider,
      ...(p.accounts ? { accounts: p.accounts, activeAccountId: p.activeAccountId } : {}),
    } : p) : [...latest.providers, update.provider];
    return this.save(owner, { ...latest, providers, modelRevision: update.modelRevision }, true);
  }
  providerAccounts(owner: string, providerId: string) {
    const provider = this.get(owner).providers.find(p => p.id === providerId);
    if (!provider) throw new ModelConfigurationError('provider_not_found', [], 404);
    return { accounts: provider.accounts ?? [], activeAccountId: provider.activeAccountId };
  }
  addProviderAccount(owner: string, providerId: string, input: { name?: string; apiKey?: string; modelRevision?: string }) {
    return this.store.transaction(() => {
      const latest = this.get(owner, true);
      if (typeof input?.modelRevision !== 'string' || input.modelRevision !== latest.modelRevision) throw new ModelConfigurationError('model_settings_conflict', [], 409);
      const apiKey = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
      const name = typeof input.name === 'string' && input.name.trim() ? input.name.trim() : `${providerId} ${((latest.providers.find(p => p.id === providerId)?.accounts?.length ?? 0) + 1)}`;
      if (!apiKey || apiKey.length > 4096 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new ModelConfigurationError('invalid_provider_key', [], 400);
      if (name.length > 100) throw new ModelConfigurationError('invalid_provider_account', [], 400);
      const provider = latest.providers.find(p => p.id === providerId);
      if (!provider) throw new ModelConfigurationError('provider_not_found', [], 404);
      const account: CloudProviderAccount = { id: crypto.randomUUID(), name, apiKey };
      const accounts = [...(provider.accounts ?? []), account];
      const providers = latest.providers.map(p => p.id === providerId ? { ...p, accounts, activeAccountId: p.activeAccountId ?? account.id } : p);
      return this.saveInTransaction(owner, { ...latest, providers, modelRevision: latest.modelRevision }, true, true);
    });
  }
  activateProviderAccount(owner: string, providerId: string, accountId: string, modelRevision: string) {
    return this.store.transaction(() => {
      const latest = this.get(owner, true);
      const provider = latest.providers.find(p => p.id === providerId);
      if (!provider || !provider.accounts?.some(account => account.id === accountId)) throw new ModelConfigurationError('provider_account_not_found', [], 404);
      if (modelRevision !== latest.modelRevision) throw new ModelConfigurationError('model_settings_conflict', [], 409);
      const providers = latest.providers.map(p => p.id === providerId ? { ...p, activeAccountId: accountId } : p);
      return this.saveInTransaction(owner, { ...latest, providers, modelRevision: latest.modelRevision }, true, true);
    });
  }
  removeProviderAccount(owner: string, providerId: string, accountId: string, modelRevision: string) {
    return this.store.transaction(() => {
      const latest = this.get(owner, true);
      const provider = latest.providers.find(p => p.id === providerId);
      if (!provider) throw new ModelConfigurationError('provider_not_found', [], 404);
      if (modelRevision !== latest.modelRevision) throw new ModelConfigurationError('model_settings_conflict', [], 409);
      const accounts = provider.accounts?.filter(account => account.id !== accountId) ?? [];
      if (accounts.length === (provider.accounts?.length ?? 0)) throw new ModelConfigurationError('provider_account_not_found', [], 404);
      const activeAccountId = provider.activeAccountId === accountId ? accounts[0]?.id : provider.activeAccountId;
      const providers = latest.providers.map(p => p.id === providerId ? { ...p, accounts, ...(activeAccountId ? { activeAccountId } : { activeAccountId: undefined }) } : p);
      return this.saveInTransaction(owner, { ...latest, providers, modelRevision: latest.modelRevision }, true, true);
    });
  }
  save(owner: string, value: CloudConfig, preserveUnchangedInvalidModels = false) {
    return this.store.transaction(() => this.saveInTransaction(owner, value, preserveUnchangedInvalidModels));
  }
  private saveInTransaction(owner: string, value: CloudConfig, preserveUnchangedInvalidModels: boolean, allowAccountSecrets = false) {
    if (!value || !Array.isArray(value.providers) || value.providers.length > 30) throw new Error('invalid_config');
    const previous = this.get(owner, true);
    if (value.modelRevision !== undefined && value.modelRevision !== previous.modelRevision) {
      throw new ModelConfigurationError('model_settings_conflict', [], 409);
    }
    const ids = new Set<string>();
    const providers: CloudProvider[] = value.providers.map(p => {
      if (!p || typeof p.id !== 'string' || !/^[\w-]{1,64}$/.test(p.id) || ids.has(p.id) || typeof p.name !== 'string' || !p.name.trim() || p.name.length > 100 ||
          !['openai-chat', 'openai-responses', 'anthropic-messages'].includes(p.protocol)) throw new ModelConfigurationError('invalid_provider', [{ path: `providers.${p?.id ?? ''}`, reason: 'invalid_provider' }]);
      ids.add(p.id);
      let url: URL;
      try { url = new URL(p.baseUrl); }
      catch { throw new ModelConfigurationError('invalid_provider_url', [{ path: `providers.${p.id}.baseUrl`, reason: 'invalid_url' }]); }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ModelConfigurationError('invalid_provider_url', [{ path: `providers.${p.id}.baseUrl`, reason: 'invalid_url' }]);
      // LAN-hosted models are supported. Bot endpoint changes must pass the exact-argument human approval in BotSettingsTools.
      const apiKey = p.id === GO_PROVIDER ? '' : p.apiKey === undefined ? previous.providers.find(old => old.id === p.id)?.apiKey ?? '' : p.apiKey;
      if (typeof apiKey !== 'string' || apiKey.length > 4096) throw new ModelConfigurationError('invalid_provider_key', [{ path: `providers.${p.id}.apiKey`, reason: 'invalid_key' }]);
      let deployments: CloudProvider['deployments'];
      try { deployments = validateModelDeployments(p.deployments); } catch { throw new ModelConfigurationError('invalid_model_deployments'); }
       const previousProvider = previous.providers.find(old => old.id === p.id);
       const accounts = allowAccountSecrets ? (p.accounts ?? previousProvider?.accounts ?? []) : previousProvider?.accounts;
       if (accounts !== undefined && (!Array.isArray(accounts) || accounts.length > 20 || accounts.some(account => !account || typeof account.id !== 'string' || !/^[\w-]{1,100}$/.test(account.id) || typeof account.name !== 'string' || !account.name.trim() || account.name.length > 100 || typeof account.apiKey !== 'string' || account.apiKey.length > 4096))) throw new ModelConfigurationError('invalid_provider_account');
       return { id: p.id, name: p.name.trim(), baseUrl: p.id === GO_PROVIDER ? goBase(p.protocol) : url.href.replace(/\/+$/, ''), protocol: p.protocol, apiKey,
         catalogId: typeof p.catalogId === 'string' ? p.catalogId.slice(0, 100) : '',
         serves: Array.isArray(p.serves) ? p.serves.filter(s => ['chat', 'vision', 'asr', 'decision'].includes(s)) : ['chat'], ...(deployments ? { deployments } : {}),
         ...(p.dataPolicy === undefined ? {} : typeof p.dataPolicy === 'string' && /^[\w.-]{1,100}$/.test(p.dataPolicy) ? { dataPolicy: p.dataPolicy } : (() => { throw new ModelConfigurationError('invalid_provider'); })()),
         ...(accounts ? { accounts, ...(p.activeAccountId ? { activeAccountId: p.activeAccountId } : {}) } : {}) };
    });
    const decisionModel = value.decisionModel ?? { providerId: '', model: '' };
    const issues = modelReferenceIssues({ ...value, providers });
    const blocking = preserveUnchangedInvalidModels ? issues.filter((issue) => {
      const slot = issue.path as typeof MODEL_FIELDS[number];
      return JSON.stringify(value[slot]) !== JSON.stringify(previous[slot]);
    }) : issues;
    if (blocking.length) throw new ModelConfigurationError('invalid_model_slot', blocking);
    let gatewaySettings: Pick<CloudConfig, 'modelPresets' | 'modelRoutes'>;
    try { gatewaySettings = validateModelPresets({ ...value, providers, modelPresets: value.modelPresets ?? previous.modelPresets, modelRoutes: value.modelRoutes ?? previous.modelRoutes }, preserveUnchangedInvalidModels); }
    catch (error) {
      if (error instanceof PresetConfigurationError) throw new ModelConfigurationError(error.message, [{ path: error.path, reason: error.reason }]);
      throw new ModelConfigurationError('invalid_model_presets');
    }
    const policy = value.policy;
    if (!policy || !['read', 'write', 'remove', 'shell'].every(k => ['allow', 'ask', 'deny'].includes((policy as any)[k])) ||
        !['allow', 'deny'].includes(policy.network) || !Number.isInteger(policy.maxSteps) || policy.maxSteps < 1 || policy.maxSteps > 1000) throw new Error('invalid_policy');
    const cleanRef = (ref: { providerId: string; model: string }) => ref?.model
      ? { providerId: ref.providerId, model: ref.model } : { providerId: '', model: '' };
    const clean: CloudConfig = { ...gatewaySettings, providers, llmModel: cleanRef(value.llmModel), visionModel: cleanRef(value.visionModel), asrModel: cleanRef(value.asrModel),
      decisionModel: cleanRef(decisionModel),
      ...(value.botBudget ? { botBudget: validateBudget(value.botBudget) } : {}),
      policy: { read: policy.read, write: policy.write, remove: policy.remove, shell: policy.shell, network: policy.network, maxSteps: policy.maxSteps },
      trustedAgentIds: Array.isArray(value.trustedAgentIds) ? value.trustedAgentIds.filter(id => typeof id === 'string' && Boolean(this.store.db.prepare('SELECT 1 FROM agent_profiles WHERE id=? AND owner_id=?').get(id, owner))).slice(0, 100) : [] };
    this.store.db.prepare('INSERT INTO cloud_config(owner_id,value,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at')
      .run(owner, this.seal(JSON.stringify(clean)), new Date().toISOString());
    this.audit(owner, 'configuration.updated', { providers: providers.map(p => p.id), policy });
    return this.get(owner);
  }
  policy(owner: string, threadId: string) {
    const config = this.get(owner);
    const agents = this.store.db.prepare('SELECT agent_id FROM thread_participants WHERE thread_id=?').all(threadId) as Array<{ agent_id: string }>;
    const trusted = agents.length > 0 && agents.every(a => config.trustedAgentIds?.includes(a.agent_id));
    // Trust removes routine write/command prompts, not deletion or sensitive configuration approval.
    // Explicit prohibitions and the independent network switch still apply.
    const autonomous = Boolean(this.store.db.prepare(`SELECT 1 FROM gateway_bindings b JOIN gateway_accounts a ON a.id=b.account_id WHERE b.thread_id=? AND b.revoked=0 AND a.enabled=1 AND a.owner_id=? AND a.preset='autonomous'`).get(threadId, owner));
    const policy = { ...config.policy,
      write: trusted && config.policy.write === 'ask' ? 'allow' as const : config.policy.write,
      shell: trusted && config.policy.shell === 'ask' ? 'allow' as const : config.policy.shell };
    if (autonomous) for (const key of ['read', 'write', 'shell'] as const) if (policy[key] === 'ask') policy[key] = 'allow';
    return policy;
  }
  taskPolicy(owner: string, taskId: string) {
    const task = this.store.db.prepare('SELECT t.parent_step_id,r.thread_id FROM cloud_tasks t LEFT JOIN runs r ON r.id=t.parent_run_id WHERE t.id=? AND t.owner_id=?').get(taskId, owner) as any;
    const policy = task?.thread_id ? this.policy(owner, task.thread_id) : this.get(owner).policy;
    if (task?.parent_step_id && this.store.db.prepare("SELECT 1 FROM approvals WHERE step_id=? AND status='approved'").get(task.parent_step_id)) return { ...policy, read: policy.read === 'ask' ? 'allow' as const : policy.read, write: policy.write === 'ask' ? 'allow' as const : policy.write };
    return policy;
  }
  audit(owner: string, action: string, detail: unknown) {
    appendAudit(this.store, owner, action, detail);
  }
}
import { appendAudit } from '../storage/audit.js';
