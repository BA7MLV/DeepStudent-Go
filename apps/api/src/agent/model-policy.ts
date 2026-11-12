import type { ModelPurpose } from '@wangke/contracts/cloud';

export type ModelRequestOptions = {
  attempts?: number; timeoutMs?: number; chainMs?: number; ordinary?: boolean;
  purpose?: ModelPurpose; firstTokenMs?: number; idleMs?: number; streamTotalMs?: number;
  /** Internal Gateway handoff only; never read from a request body/header. */
  imagesPrepared?: boolean;
};

export type ModelRequestPolicy = {
  timeoutMs: number;
  attempts: number;
  chainMs: number;
  firstTokenMs: number;
  idleMs: number;
  streamTotalMs: number;
};

type DeadlineProfile = Pick<ModelRequestPolicy, 'timeoutMs' | 'firstTokenMs' | 'idleMs' | 'streamTotalMs'>;

/** Non-stream requests need one total deadline; streams need separate
 * first-token, idle-between-chunks and absolute-turn deadlines. A single
 * wall-clock limit over the whole stream cuts healthy long generations. */
const profiles: Record<ModelPurpose, DeadlineProfile> = {
  chat: { timeoutMs: 300_000, firstTokenMs: 120_000, idleMs: 120_000, streamTotalMs: 600_000 },
  bot: { timeoutMs: 300_000, firstTokenMs: 120_000, idleMs: 120_000, streamTotalMs: 600_000 },
  vision: { timeoutMs: 180_000, firstTokenMs: 90_000, idleMs: 60_000, streamTotalMs: 300_000 },
  asr: { timeoutMs: 120_000, firstTokenMs: 60_000, idleMs: 60_000, streamTotalMs: 180_000 },
  decision: { timeoutMs: 60_000, firstTokenMs: 30_000, idleMs: 30_000, streamTotalMs: 90_000 },
  memory: { timeoutMs: 60_000, firstTokenMs: 30_000, idleMs: 30_000, streamTotalMs: 90_000 },
};

function setting(value: string | undefined, fallback: number, min: number, max: number) {
  const parsed = value?.trim() ? Number(value) : NaN;
  return Number.isSafeInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

/** The chain covers every attempt and backoff, rather than silently capping a
 * longer per-attempt timeout at an old two-minute deadline. A stream's first
 * token and total-turn limits are deliberately independent of retry policy. */
export function modelRequestPolicy(options: ModelRequestOptions = {}, env = process.env): ModelRequestPolicy {
  const profile = profiles[options.purpose ?? 'chat'] ?? profiles.chat;
  const timeoutMs = options.timeoutMs ?? setting(env.MODEL_TIMEOUT_MS, profile.timeoutMs, 1000, 600_000);
  const firstTokenMs = options.firstTokenMs ?? setting(env.MODEL_FIRST_TOKEN_TIMEOUT_MS, profile.firstTokenMs, 1000, 600_000);
  const idleMs = options.idleMs ?? setting(env.MODEL_STREAM_IDLE_TIMEOUT_MS, profile.idleMs, 1000, 600_000);
  const streamTotalMs = options.streamTotalMs ?? setting(env.MODEL_STREAM_TOTAL_TIMEOUT_MS, profile.streamTotalMs, 1000, 3_600_000);
  const attempts = options.attempts ?? setting(env.MODEL_MAX_RETRIES, 2, 0, 5) + 1;
  const chainMs = options.chainMs ?? setting(env.MODEL_CHAIN_TIMEOUT_MS, Math.max(timeoutMs * attempts, streamTotalMs) + 60_000, 1000, 3_660_000);
  if (![timeoutMs, attempts, chainMs, firstTokenMs, idleMs, streamTotalMs].every(Number.isSafeInteger) || timeoutMs < 1 || timeoutMs > 600_000 || attempts < 1 || attempts > 6 || chainMs < 1 || chainMs > 3_660_000 || firstTokenMs < 1 || firstTokenMs > 600_000 || idleMs < 1 || idleMs > 600_000 || streamTotalMs < 1 || streamTotalMs > 3_600_000) throw new Error('invalid_model_request_policy');
  return { timeoutMs, attempts, chainMs, firstTokenMs, idleMs, streamTotalMs };
}
