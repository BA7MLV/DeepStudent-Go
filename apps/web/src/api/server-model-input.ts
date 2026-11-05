import type { ModelTarget, ModelListConnection } from '@wangke/study-core/model/types';
import type { TranscriptionResult, TranscriptionSegment } from './modelClient';
import { ApiError } from './modelClient';
import { parseDiscoveredModel, type DiscoveredModel } from './modelDiscoveryData';
import { apiUrl } from './base';
import { cloud } from '../cloud/state';
import { accountLifetime } from '../client/account-lifecycle';

/** Only saved server connections may be discovered. Arbitrary provider URLs and
 * keys are editor input, never a browser network destination or credential. */
function discoveryProvider(connection: ModelListConnection) {
  const url = new URL(connection.baseUrl.replace(/\/+$/, ''), location.href);
  const id = decodeURIComponent(url.pathname.split('/').pop() ?? '');
  if (!id || !['models', 'model-gateway/providers'].some(route =>
    url.href === new URL(apiUrl(`/api/v1/cloud/${route}/${encodeURIComponent(id)}`), location.href).href)) {
    throw new Error('server_model_connection_required');
  }
  return id;
}

async function responseError(response: Response): Promise<never> {
  const body = await response.json().catch(() => null);
  const retry = response.headers.get('retry-after');
  const retryAfterMs = retry == null ? undefined : Number.isFinite(Number(retry))
    ? Math.max(0, Number(retry) * 1000) : Number.isNaN(Date.parse(retry)) ? undefined : Math.max(0, Date.parse(retry) - Date.now());
  throw new ApiError(response.status, body?.error?.message ?? body?.error ?? `HTTP ${response.status}`, retryAfterMs);
}

export async function listModelDetails(connection: ModelListConnection, signal?: AbortSignal): Promise<DiscoveredModel[]> {
  if (!cloud.enabled || !cloud.userId) throw new Error('server_model_connection_required');
  const lifetime = accountLifetime(cloud.userId), providerId = discoveryProvider(connection);
  const requestSignal = AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]);
  const found = new Map<string, DiscoveredModel>(), cursors = new Set<string>();
  let cursor = '';
  for (let page = 0; page < 100; page++) {
    requestSignal.throwIfAborted();
    const url = apiUrl(`/api/v1/cloud/model-gateway/providers/${encodeURIComponent(providerId)}/models${cursor ? `?after_id=${encodeURIComponent(cursor)}` : ''}`);
    const response = await fetch(url, { credentials: 'include', redirect: 'error', cache: 'no-store', signal: requestSignal });
    if (!response.ok) await responseError(response);
    const data: unknown = await response.json();
    lifetime.assertCurrent();
    if (!data || typeof data !== 'object') throw new Error('模型列表响应格式无效');
    const body = data as { data?: unknown; models?: unknown; has_more?: unknown; last_id?: unknown };
    const models = Array.isArray(data) ? data : body.data ?? body.models;
    if (!Array.isArray(models)) throw new Error('接口未返回模型列表，可手动添加模型');
    for (const model of models) {
      const parsed = parseDiscoveredModel(model);
      if (!parsed) throw new Error('模型列表条目缺少有效 ID');
      if (!found.has(parsed.id)) found.set(parsed.id, parsed);
    }
    if (body.has_more === undefined || body.has_more === false) return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (body.has_more !== true || typeof body.last_id !== 'string' || !body.last_id || cursors.has(body.last_id)) throw new Error('模型列表分页信息无效');
    cursor = body.last_id; cursors.add(cursor);
  }
  throw new Error('模型列表分页超出安全上限');
}
export async function listModels(connection: ModelListConnection, signal?: AbortSignal) {
  return (await listModelDetails(connection, signal)).map(model => model.id);
}

/** Ephemeral microphone input, not a browser course transcription executor.
 * Browser capture/PCM/WAV preparation stays local; saved server ASR configuration
 * and Gateway admission own the actual model call. Never send a provider key. */
export async function transcribe(target: ModelTarget, audio: Blob, filename = 'voice.wav', signal?: AbortSignal): Promise<TranscriptionResult> {
  if (!cloud.enabled || !cloud.userId || !target.providerId) throw new Error('server_voice_input_required');
  const lifetime = accountLifetime(cloud.userId);
  const form = new FormData();
  form.append('file', audio, filename);
  form.append('model', target.model);
  const response = await fetch(apiUrl(`/api/v1/cloud/model-gateway/providers/${encodeURIComponent(target.providerId)}/audio/transcriptions`), {
    method: 'POST', credentials: 'include', redirect: 'error', body: form,
    signal: AbortSignal.any([lifetime.signal, ...(signal ? [signal] : [])]),
  });
  if (!response.ok) await responseError(response);
  const data = await response.json();
  lifetime.assertCurrent();
  const segments: TranscriptionSegment[] = Array.isArray(data?.segments) ? data.segments.filter((segment: TranscriptionSegment) =>
    segment && typeof segment.start === 'number' && Number.isFinite(segment.start) && typeof segment.end === 'number' && Number.isFinite(segment.end)
      && segment.end > segment.start && typeof segment.text === 'string' && segment.text.trim()).map((segment: TranscriptionSegment) => ({ start: segment.start, end: segment.end, text: segment.text.trim() })) : [];
  return { text: typeof data?.text === 'string' ? data.text : '', duration: typeof data?.duration === 'number' ? data.duration : undefined,
    ...(segments.length ? { segments } : {}) };
}
