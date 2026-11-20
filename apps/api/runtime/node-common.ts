/** Node 任务执行器的共享形状与小工具。
 * 从 runtime/node.ts 原样搬出:这些类型与函数被服务端工具循环、QA/chat 与资料生成
 * 共同使用,拆开后必须保持同一份定义,避免两处漂移。 */
import { PROMPTS } from '@wangke/study-core/prompts';
import type { ChatMessage } from '@wangke/study-core/model/client';
import type { ModelRequestRecord } from '@wangke/study-core/model/usage';
import type { ResponseSegment } from '@wangke/study-core/response-order';
import type { WidgetPayload } from '@wangke/study-core/widgets';
import type { TaskContext } from '../src/cloud/execution.js';
import { gatewayTaskFetch, gatewayTaskTarget } from '../src/agent/model-gateway-runtime.js';
import { ModelFailure } from '../src/agent/model-client.js';
import { modelThinkingLevel } from '../src/agent/model-preferences.js';

export type ServerToolTrace = {
  id?: string;
  webSearch?: import('@wangke/contracts/web-search').WebSearchResult;
  name: string;
  detail?: string;
  result?: string;
  status: 'running' | 'done' | 'error';
  ms?: number;
  reasoningOffset?: number;
};

export interface ServerAgentResult {
  ask?: import('@wangke/study-core/ask-user').AskUserData & { answer?: import('@wangke/study-core/ask-user').AskUserAnswer; picked?: string };
  content: string;
  reasoning?: string;
  responseSegments: ResponseSegment[];
  tools: ServerToolTrace[];
  transcript: ChatMessage[];
  requests: ModelRequestRecord[];
  widgets: WidgetPayload[];
}

/** 渲染投影:widgets 数组与最近一个 widget 同时下发,客户端据此挂载预览与历史。 */
export function widgetFields(result: Pick<ServerAgentResult, 'widgets'>) {
  return result.widgets.length ? { widgets: [...result.widgets], widget: result.widgets.at(-1) } : {};
}

export function responseFields(result: ServerAgentResult) {
  return { responseSegments: result.responseSegments, ...widgetFields(result) };
}

export function targetFor(context: TaskContext) {
  return gatewayTaskTarget(context);
}

export function modelFetch(context: TaskContext): typeof fetch {
  return async (url, init) => {
    context.checkActive();
    try {
      // The model gateway owns the absolute request deadline. An independent
      // outer 300s timer here would silently cap a longer stream or a configured
      // reasoning-model budget before the gateway can classify it.
      const response = await gatewayTaskFetch(context)(url, { ...init, redirect: 'error' });
      if (!response.ok) {
        await response.body?.cancel();
        const retryAfter = response.headers.get('retry-after');
        // Keep status/Retry-After for the shared retry policy, never provider error bodies.
        return new Response(JSON.stringify({ error: { message: `model_http_${response.status}` } }), {
          status: response.status, headers: { 'content-type': 'application/json', ...(retryAfter ? { 'retry-after': retryAfter } : {}) },
        });
      }
      return response;
    } catch (error) {
      context.signal.throwIfAborted();
      if (error instanceof Error && error.name === 'BudgetBlocked') throw error;
      // Stable gateway codes are safe to persist; provider text, URLs and
      // credentials are not. Preserve timeout/cancellation instead of turning
      // every pre-response failure into a generic connection error.
      if (error instanceof ModelFailure) throw error;
      throw new Error('model_connection_failed');
    }
  };
}

/** Snapshot intent at task submission. Older clients/Bot tasks may use the
 * synced preference, but never accept an arbitrary enum into provider JSON. */
export function taskThinkingLevel(context: TaskContext) {
  return context.task.frozenModel?.thinkingLevel ?? modelThinkingLevel(context.store, context.owner, context.task.input.thinkingLevel);
}

/** 保守截断:入参是外部数据,长文本只保留可读前缀。 */
export function clip(value: string, max: number) {
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断）`;
}

export function traceResult(traces: ServerToolTrace[]) {
  return traces.map(trace => ({ ...trace, result: trace.result ? clip(trace.result, 800) : trace.result }));
}

/** Do not let task input turn a model request into an unbounded proxy. */
export function safeImageParts(value: unknown): import('@wangke/study-core/model/client').ContentPart[] {
  if (!Array.isArray(value)) return [];
  const out: import('@wangke/study-core/model/client').ContentPart[] = [];
  let bytes = 0;
  for (const part of value.slice(0, 24)) {
    if (!part || typeof part !== 'object') continue;
    const record = part as { type?: unknown; text?: unknown; image_url?: { url?: unknown } };
    if (record.type === 'text' && typeof record.text === 'string') {
      const text = String(record.text).slice(0, 5000);
      out.push({ type: 'text', text });
      bytes += text.length;
    } else if (record.type === 'image_url' && typeof record.image_url?.url === 'string') {
      const url = String(record.image_url.url);
      if (!/^(?:data:image\/[\w.+-]+;base64,|https?:\/\/)/i.test(url) || url.length > 12_000_000) continue;
      out.push({ type: 'image_url', image_url: { url } });
      bytes += url.length;
    }
    if (bytes > 24_000_000) break;
  }
  return out;
}

export function parseArgs(value: string) {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function qaSystemPrompt(video: Record<string, any> | null, kind: 'page' | 'para' | undefined, input: Record<string, any>) {
  const name = String(input.videoName ?? video?.name ?? input.videoId ?? '当前课程');
  const shotCount = Number(input.shotCount) || 0;
  const refsCount = Number(input.refsCount) || 0;
  return kind
    ? PROMPTS.qaSystemMaterial(name, kind, undefined, shotCount, refsCount, false)
    : PROMPTS.qaSystem(name, undefined, false, shotCount, refsCount);
}


export type { ChatMessage };
