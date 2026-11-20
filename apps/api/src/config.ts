import os from 'node:os';
import path from 'node:path';
import { Ajv, type AnySchema } from 'ajv';

/** 进程配置的唯一读取点。apps/api 的 src/ 与 runtime/ 其它文件不得直接读
 * `process.env`(scripts/lint-anti-slop.mjs 的 process-env-direct 规则会拦)。
 *
 * 两种读取时机,刻意分开:
 * - 启动期快照:`initializeConfig()` 在 buildServer 入口按 schema 一次性校验,
 *   之后经 `config()` 读取。缺字节/数字越界/格式不对都在装配阶段 fail-fast,
 *   不会等第一个请求才炸。测试在同一进程里重建 server 时会重新校验一次。
 * - 惰性读取:`getConfig()` 每个调用点重新解析。只有「测试或运维会在进程运行中
 *   改 env,且代码必须立刻看到新值」的变量走这里,理由写在各字段上方。
 *
 * 校验失败只报变量名与不敏感的原因,绝不拼接变量值:密码、API key、Bearer token
 * 都从这里经过,泄露一次就等于泄露全部。 */

/** 环境变量映射。顶层只取一次 process.env 的引用;每个键在索引时才读取,
 * 所以运行中被测试改写的变量依然可见。 */
type EnvMap = Record<string, string | undefined>;


export type RuntimeConfig = {
  /** Fastify 日志开关(`!== 'test'`),只在此进程内读一次。 */
  readonly nodeEnv: string;
  /** 测试在用例内改并发再拉起 runner(scripts/test-task-delegation、
   * test-bot-default-workspace):调度器每次都重读。 */
  readonly botConcurrency: number;
  /** 同上,scripts/test-task-delegation 在运行中改。 */
  readonly cloudConcurrency: number;
  /** 读时即用:测试套件在用例内临时起停假 broker 并改写 URL 与 token。 */
  readonly sandboxUrl: string | undefined;
  readonly sandboxToken: string | undefined;
  /** 子进程唯一继承的环境变量,必须取当前值而不是启动快照。 */
  readonly inheritedPath: string | undefined;
  /** 发布脚本用 tar 改写 compose 后在同一进程探测版本,必须看到新内容。 */
  readonly appVersion: string;
  /** 保留量与审计上限:test-gateway-retention 等测试在用例内改小后在运行中触发,
   * 因此每次清理/审计都重读,不在启动时定死。 */
  readonly gatewayPendingLimit: number;
  readonly gatewayDedupeLimit: number;
  readonly gatewayPendingDays: number;
  readonly gatewayBodyDays: number;
  readonly botAuditLimit: number;
  /** 公开对外来源:原版三处消费方(study 引用/mcp origin/passkey 探测)都是
   * 每次调用直读 env,test-gateway-review 在用例中期设置它来验证引用拼接,
   * 属于运行期会变的变量,不进启动快照。 */
  readonly publicOrigin: string | undefined;
  readonly mcpPublicOrigin: string | undefined;
};

export type AppConfig = {
  readonly nodeEnv: string;
  readonly publicOrigin: string | undefined;
  readonly webauthnRpId: string | undefined;
  readonly webauthnRpName: string | undefined;
  readonly corsOrigins: readonly string[];
  readonly cookieSameSite: 'lax' | 'none' | 'strict';
  readonly allowInsecureCsrf: boolean;
  readonly cloudWorkerDisabled: boolean;
  readonly dataDir: string;
  readonly filesDir: string;
  readonly dbPath: string;
  readonly bootstrapSecretFile: string;
  readonly bootstrapTtlMs: number;
  readonly sessionTtlMs: number;
  readonly tokenTtlMs: number;
  readonly maxFileBytes: number;
  readonly boardSeedDir: string | undefined;
  readonly apiReleaseId: string | undefined;
  readonly apiReleaseToken: string;
  readonly apiDrainMs: number;
  readonly host: string;
  readonly port: number;
  readonly modelApiKey: string | undefined;
  readonly modelBaseUrl: string;
  readonly modelName: string;
  readonly opencodeGoApiKey: string | undefined;
  readonly modelTimeoutMs: number;
  readonly modelFirstTokenMs: number;
  readonly modelStreamIdleMs: number;
  readonly modelStreamTotalMs: number;
  readonly modelMaxRetries: number;
  readonly modelChainMs: number | undefined;
  readonly modelGatewayDisabledPurposes: readonly string[];
  readonly botMaxSteps: number;
  /** 日志事件窗口只在清理/重放时按需读取(getConfig),不进入启动快照。 */
  readonly botJournalEventWindow: number;
  readonly mcpPublicOrigin: string | undefined;
};

const modelPurposes = ['bot', 'chat', 'vision', 'asr', 'memory', 'decision'] as const;

/** 上限沿用旧读取处的既有钳制值,避免「集中解析」顺手改变行为。 */
const SEED_MAX_FILE_BYTES = 512 * 1024 * 1024;

const ajv = new Ajv({ strict: true, strictTypes: false, allowUnionTypes: true, ownProperties: true, allErrors: true, addUsedSchema: false, coerceTypes: false });

/** ajv 默认不认 `format: uri`(需要 ajv-formats,仓库没装);用「scheme 必须是
 * http(s) 且不含空白」的等价约束,再在 parse 里用 new URL 复查。 */
const origin = { type: 'string', minLength: 8, maxLength: 2048, pattern: '^https?://[^\\s]+$' } as const;

/** 启动期关键变量的 schema。整数字段只接受整数值;空串在 present() 里已被
 * 归一成「未设置」,所以这里不需要允许空串。 */
const envSchema: AnySchema = {
  type: 'object',
  additionalProperties: true,
  properties: {
    NODE_ENV: { type: 'string', enum: ['development', 'test', 'production'] },
    HOST: { type: 'string', minLength: 1, maxLength: 255 },
    PORT: { type: 'integer', minimum: 0, maximum: 65535 },
    APP_VERSION: { type: 'string', minLength: 1, maxLength: 100 },
    API_DRAIN_MS: { type: 'integer', minimum: 0, maximum: 300_000 },
    PUBLIC_ORIGIN: origin,
    WEBAUTHN_RP_ID: { type: 'string', minLength: 1, maxLength: 255 },
    WEBAUTHN_RP_NAME: { type: 'string', minLength: 1, maxLength: 255 },
    CORS_ORIGINS: { type: 'string', maxLength: 8192 },
    COOKIE_SAMESITE: { type: 'string', enum: ['lax', 'none', 'strict'] },
    ALLOW_INSECURE_CSRF: { type: 'string', enum: ['true', 'false', '1', '0'] },
    DATA_DIR: { type: 'string', minLength: 1, maxLength: 4096 },
    FILES_DIR: { type: 'string', minLength: 1, maxLength: 4096 },
    DB_PATH: { type: 'string', minLength: 1, maxLength: 4096 },
    BOOTSTRAP_SECRET_FILE: { type: 'string', minLength: 1, maxLength: 4096 },
    BOOTSTRAP_TTL_MS: { type: 'integer', minimum: 1, maximum: 31_536_000_000 },
    SESSION_TTL_MS: { type: 'integer', minimum: 1, maximum: 31_536_000_000 },
    TOKEN_TTL_MS: { type: 'integer', minimum: 1, maximum: 31_536_000_000 },
    MAX_FILE_BYTES: { type: 'integer', maximum: SEED_MAX_FILE_BYTES },
    BOARD_SEED_DIR: { type: 'string', minLength: 1, maxLength: 4096 },
    API_RELEASE_ID: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
    API_RELEASE_TOKEN: { type: 'string', pattern: '^[a-f0-9]{64}$' },
    CLOUD_WORKER_DISABLED: { type: 'string', enum: ['0', '1'] },
    MODEL_API_KEY: { type: 'string', minLength: 1, maxLength: 8192 },
    MODEL_BASE_URL: origin,
    MODEL_NAME: { type: 'string', minLength: 1, maxLength: 200 },
    OPENCODE_GO_API_KEY: { type: 'string', maxLength: 8192 },
    MODEL_TIMEOUT_MS: { type: 'integer', minimum: 1000, maximum: 600_000 },
    MODEL_FIRST_TOKEN_TIMEOUT_MS: { type: 'integer', minimum: 1000, maximum: 600_000 },
    MODEL_STREAM_IDLE_TIMEOUT_MS: { type: 'integer', minimum: 1000, maximum: 600_000 },
    MODEL_STREAM_TOTAL_TIMEOUT_MS: { type: 'integer', minimum: 1000, maximum: 3_600_000 },
    MODEL_MAX_RETRIES: { type: 'integer', minimum: 0, maximum: 5 },
    MODEL_CHAIN_TIMEOUT_MS: { type: 'integer', minimum: 1000, maximum: 3_660_000 },
    MODEL_GATEWAY_DISABLED_PURPOSES: { type: 'string', maxLength: 200 },
    BOT_MAX_STEPS: { type: 'integer', minimum: 1, maximum: 1000 },
    BOT_CONCURRENCY: { type: 'integer', minimum: 1, maximum: 8 },
    BOT_AUDIT_LIMIT: { type: 'integer', minimum: 1000, maximum: 1_000_000 },
    BOT_JOURNAL_EVENT_WINDOW: { type: 'integer', minimum: 1, maximum: 200_000 },
    CLOUD_CONCURRENCY: { type: 'integer', minimum: 1, maximum: 4 },
    GATEWAY_PENDING_LIMIT: { type: 'integer', minimum: 1, maximum: 10_000 },
    GATEWAY_DEDUPE_LIMIT: { type: 'integer', minimum: 1, maximum: 1_000_000 },
    GATEWAY_PENDING_DAYS: { type: 'integer', minimum: 1, maximum: 365 },
    GATEWAY_BODY_DAYS: { type: 'integer', minimum: 1, maximum: 3650 },
    MCP_PUBLIC_ORIGIN: origin,
    SANDBOX_URL: origin,
    SANDBOX_TOKEN: { type: 'string', minLength: 1, maxLength: 8192 },
  },
};
const validateEnv = ajv.compile(envSchema);

/** 空串与纯空白一律视为未设置:compose 里 `VAR: ""` 是常见的「留空」写法,
 * 把空 key 当成「已配置的空密钥」会造出比缺省更难排查的状态。 */
function present(env: EnvMap): EnvMap {
  const result: EnvMap = {};
  const entries = Object.entries(env);
  for (let index = 0; index < entries.length; index += 1) {
    const name = entries[index][0];
    const value = entries[index][1];
    if (typeof value !== 'string') continue;
    if (value.trim().length === 0) continue;
    result[name] = value;
  }
  return result;
}

/** 校验器输入:整数变量已转成 number,其余仍是 env 的字符串。 */
type Reflection = Record<string, string | number | undefined>;

/** schema.properties 里声明为 integer 的变量:字符串原样保留(让校验报「必须是整数」),
 * 合法的十进制整数字符串转成 number。 */
const integerVariables = Object.entries(envSchema.properties as Record<string, { type?: string }>).filter(([, value]) => value.type === 'integer').map(([name]) => name);

function numeric(env: EnvMap): Reflection {
  const result: Reflection = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (integerVariables.includes(name) && /^-?\d+$/u.test(value)) result[name] = Number(value);
    else result[name] = value;
  }
  return result;
}

function integer(env: EnvMap, name: string, fallback: number): number {
  const value = env[name];
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

/** lenient 模式:非法整数/URL/enum 一律当作未设置,交给 parse 的缺省值。 */
function tolerant(env: Reflection): Reflection {
  const result: Reflection = { ...env };
  if (validateEnv(result) === false) for (const issue of validateEnv.errors ?? []) {
    const name = issueName(issue);
    if (name !== 'env') delete result[name];
  }
  return result;
}

function setting(env: EnvMap, name: string, fallback: string): string {
  return env[name] ?? fallback;
}

/** 回到纯字符串空间给 parse 使用:数值已在 numeric() 里验过形态。 */
function envelope(env: Reflection): EnvMap {
  return Object.fromEntries(Object.entries(env).map(([name, value]) => [name, value === undefined ? undefined : String(value)]));
}

function list(env: EnvMap, name: string, fallback: string): string[] {
  return setting(env, name, fallback).split(',').map(value => value.trim()).filter(Boolean);
}

/** 只把变量名与不敏感的期望写进错误;值可能是密钥,永不拼接。 */
const failure = (name: string, problem: string) => `${name} ${problem}`;

function parse(env: EnvMap): AppConfig {
  const dataDir = path.resolve(setting(env, 'DATA_DIR', path.resolve(os.homedir(), 'data')));
  const filesDir = env.FILES_DIR ? path.resolve(env.FILES_DIR) : path.join(dataDir, 'files');
  const bootstrapSecretFile = env.BOOTSTRAP_SECRET_FILE ? path.resolve(env.BOOTSTRAP_SECRET_FILE) : path.join(dataDir, 'config/bootstrap-secret');
  const sameSite = setting(env, 'COOKIE_SAMESITE', 'lax').toLowerCase();
  return {
    // 未设置时给一个不等于 'test' 的值,与旧读取处 `!== 'test'` 的日志开关一致。
    nodeEnv: setting(env, 'NODE_ENV', 'development'),
    publicOrigin: env.PUBLIC_ORIGIN,
    webauthnRpId: env.WEBAUTHN_RP_ID,
    webauthnRpName: env.WEBAUTHN_RP_NAME,
    corsOrigins: list(env, 'CORS_ORIGINS', '').map(value => value.replace(/\/+$/, '')),
    cookieSameSite: sameSite === 'none' ? 'none' : sameSite === 'strict' ? 'strict' : 'lax',
    allowInsecureCsrf: setting(env, 'ALLOW_INSECURE_CSRF', 'false') === 'true' || setting(env, 'ALLOW_INSECURE_CSRF', 'false') === '1',
    cloudWorkerDisabled: setting(env, 'CLOUD_WORKER_DISABLED', '0') === '1',
    dataDir,
    filesDir,
    dbPath: env.DB_PATH ? path.resolve(env.DB_PATH) : path.join(dataDir, 'db/wangke.sqlite'),
    bootstrapSecretFile,
    bootstrapTtlMs: integer(env, 'BOOTSTRAP_TTL_MS', 24 * 60 * 60 * 1000),
    sessionTtlMs: integer(env, 'SESSION_TTL_MS', 30 * 24 * 60 * 60 * 1000),
    tokenTtlMs: integer(env, 'TOKEN_TTL_MS', 90 * 24 * 60 * 60 * 1000),
    // 旧读取处把 0/负数/小数钳成 1,这里保留:显式设成非法值不能从「可用」变成启动失败。
    maxFileBytes: Math.max(1, Math.floor(integer(env, 'MAX_FILE_BYTES', SEED_MAX_FILE_BYTES))),
    boardSeedDir: env.BOARD_SEED_DIR ? path.resolve(env.BOARD_SEED_DIR) : undefined,
    apiReleaseId: env.API_RELEASE_ID,
    apiReleaseToken: setting(env, 'API_RELEASE_TOKEN', ''),
    apiDrainMs: integer(env, 'API_DRAIN_MS', 30_000),
    host: setting(env, 'HOST', '0.0.0.0'),
    port: integer(env, 'PORT', 3000),
    modelApiKey: env.MODEL_API_KEY,
    modelBaseUrl: setting(env, 'MODEL_BASE_URL', 'https://api.openai.com/v1'),
    modelName: setting(env, 'MODEL_NAME', 'gpt-4o-mini'),
    opencodeGoApiKey: env.OPENCODE_GO_API_KEY?.trim(),
    modelTimeoutMs: integer(env, 'MODEL_TIMEOUT_MS', 300_000),
    modelFirstTokenMs: integer(env, 'MODEL_FIRST_TOKEN_TIMEOUT_MS', 120_000),
    modelStreamIdleMs: integer(env, 'MODEL_STREAM_IDLE_TIMEOUT_MS', 120_000),
    modelStreamTotalMs: integer(env, 'MODEL_STREAM_TOTAL_TIMEOUT_MS', 600_000),
    modelMaxRetries: integer(env, 'MODEL_MAX_RETRIES', 2),
    modelChainMs: env.MODEL_CHAIN_TIMEOUT_MS === undefined ? undefined : integer(env, 'MODEL_CHAIN_TIMEOUT_MS', 0),
    modelGatewayDisabledPurposes: list(env, 'MODEL_GATEWAY_DISABLED_PURPOSES', '').filter(purpose => (modelPurposes as readonly string[]).includes(purpose)),
    botMaxSteps: integer(env, 'BOT_MAX_STEPS', 100),
    botJournalEventWindow: integer(env, 'BOT_JOURNAL_EVENT_WINDOW', 20_000),
    mcpPublicOrigin: env.MCP_PUBLIC_ORIGIN,
  };
}

/** ajv 的 `instancePath` 是 `/VAR` 形式;变量名只由裸字符串键组成,不会含 `/`。 */
function issueName(issue: { instancePath?: string }): string {
  const instancePath = issue.instancePath ?? '';
  return instancePath.length > 1 ? instancePath.slice(1) : 'env';
}

function describe(issue: { keyword?: string; params?: Record<string, unknown> }): string {
  const params = issue.params ?? {};
  switch (issue.keyword) {
    case 'enum': return `必须是 ${(Array.isArray(params.allowedValues) ? params.allowedValues : []).join(' / ')} 之一`;
    case 'pattern': return '格式不合法';
    case 'type': return '必须是整数';
    case 'minimum': return `不能小于 ${String(params.limit)}`;
    case 'maximum': return `不能大于 ${String(params.limit)}`;
    case 'minLength': return '不能为空';
    case 'maxLength': return `长度不能超过 ${String(params.limit)}`;
    default: return '取值不合法';
  }
}

let current: AppConfig | undefined;

/** 装配期调用:一次校验、一次解析,之后所有读取都走 config()。
 * `lenient` 只给跨包测试夹具用(单元测试直接 import 领域模块,不经过 buildServer):
 * 跳过取值校验,非法值按旧读取处的「回落缺省」语义处理。 */
export function initializeConfig(options: { lenient?: boolean } = {}): AppConfig {
  const snapshotEnv = { ...globalThis.process.env };
  const candidate = numeric(present(snapshotEnv));
  if (!options.lenient && validateEnv(candidate) === false) {
    const errors = (validateEnv.errors ?? []).map(issue => `  - ${failure(issueName(issue), describe(issue))}`);
    throw new Error(`配置校验失败,请修正后重启:\n${errors.join('\n')}`);
  }
  const normalized = options.lenient ? tolerant(candidate) : candidate;
  const parsed = parse(envelope(normalized));
  if (parsed.apiReleaseId !== undefined && !/^[a-f0-9]{64}$/.test(parsed.apiReleaseToken)) throw new Error(failure('API_RELEASE_TOKEN', '在设置 API_RELEASE_ID 时必须是 64 位小写十六进制'));
  if (parsed.publicOrigin !== undefined) {
    const url = new URL(parsed.publicOrigin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(failure('PUBLIC_ORIGIN', '必须是 http(s) URL'));
  }
  if (parsed.mcpPublicOrigin !== undefined) {
    const url = new URL(parsed.mcpPublicOrigin);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error(failure('MCP_PUBLIC_ORIGIN', '必须是 http(s) URL'));
  }
  current = parsed;
  return parsed;
}

/** 启动期快照。未显式初始化时(领域模块的单元测试直接 import,不经过 buildServer)
 * 按当前 env 惰性初始化一次:语义与旧读取处的「每次读 env + 缺省值」等价,
 * 而生产入口 buildServer 总会先走带校验的 initializeConfig()。 */
export function config(): AppConfig {
  current ??= parse(present({ ...globalThis.process.env }));
  return current;
}

/** 现读 env 的正整数,钳制到 [1, max];非法值回落缺省(与旧读取处一致)。 */
function positiveOr(name: string, fallback: number, max: number): number {
  const raw = globalThis.process.env[name];
  if (raw === undefined) return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, max) : fallback;
}

/** 惰性读取。每个调用点都重新解析,用于「运行中改 env 必须立刻生效」的变量。 */
export function getConfig(): RuntimeConfig {
  // 每个字段直接在调用点索引环境变量。不做 `const env = process.env` 之类的中间
  // 别名:tsx 的转换会把别名提升成模块级的陈旧副本,运行中的改写就读不到了。
  return {
    nodeEnv: globalThis.process.env.NODE_ENV ?? 'development',
    botConcurrency: positiveOr('BOT_CONCURRENCY', 1, 8),
    cloudConcurrency: positiveOr('CLOUD_CONCURRENCY', 2, 4),
    sandboxUrl: globalThis.process.env.SANDBOX_URL,
    sandboxToken: globalThis.process.env.SANDBOX_TOKEN,
    inheritedPath: globalThis.process.env.PATH,
    appVersion: globalThis.process.env.APP_VERSION ?? '0.1.0',
    gatewayPendingLimit: positiveOr('GATEWAY_PENDING_LIMIT', 1_000, 10_000),
    gatewayDedupeLimit: positiveOr('GATEWAY_DEDUPE_LIMIT', 200_000, 1_000_000),
    gatewayPendingDays: positiveOr('GATEWAY_PENDING_DAYS', 7, 365),
    gatewayBodyDays: positiveOr('GATEWAY_BODY_DAYS', 30, 3_650),
    botAuditLimit: positiveOr('BOT_AUDIT_LIMIT', 100_000, 1_000_000),
    publicOrigin: globalThis.process.env.PUBLIC_ORIGIN,
    mcpPublicOrigin: globalThis.process.env.MCP_PUBLIC_ORIGIN,
  };
}

/** 测试与诊断用:清掉快照,下一次 initializeConfig 重新解析。 */
export function resetConfig(): void { current = undefined; }

