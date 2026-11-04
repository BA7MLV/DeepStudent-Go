import type { WidgetPayload } from './widgetRuntime';
import { validateWidgetArgs } from './widget.ts';

export interface WidgetAnswerFeedback {
  version: 1;
  /** Host-owned submission identity, not an iframe RPC sequence. */
  requestId: string;
  status: 'pending' | 'correct' | 'incorrect' | 'partial' | 'review';
  answer: unknown;
  correctAnswer?: unknown;
  explanation?: string;
  grading: 'host' | 'ai' | 'self';
  authoritative: boolean;
  timestamp: number;
}

/** Self-contained: also injected into the opaque-origin runtime. Fail closed, never truncate. */
export function readWidgetAnswerFeedback(raw: unknown): WidgetAnswerFeedback | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const v = raw as WidgetAnswerFeedback;
    if (Object.keys(v).some(k => !['version', 'requestId', 'status', 'answer', 'correctAnswer', 'explanation', 'grading', 'authoritative', 'timestamp'].includes(k))) return null;
    if (v.version !== 1 || typeof v.requestId !== 'string' || !v.requestId || v.requestId.length > 128
      || !['pending', 'correct', 'incorrect', 'partial', 'review'].includes(v.status)
      || !['host', 'ai', 'self'].includes(v.grading) || typeof v.authoritative !== 'boolean'
      || !Number.isSafeInteger(v.timestamp) || v.timestamp < 0 || !Object.hasOwn(v, 'answer')
      || (v.explanation !== undefined && (typeof v.explanation !== 'string' || v.explanation.length > 16000))
      || (v.authoritative && (v.grading !== 'host' || !['correct', 'incorrect', 'partial'].includes(v.status)))
      || (!v.authoritative && ['correct', 'incorrect', 'partial'].includes(v.status))) return null;
    let nodes = 0;
    const stack: [unknown, number][] = [[v.answer, 0]];
    if (v.correctAnswer !== undefined) stack.push([v.correctAnswer, 0]);
    while (stack.length) {
      const [value, depth] = stack.pop()!;
      if (++nodes > 8000 || depth > 16) return null;
      if (typeof value === 'string' && value.length > 32768) return null;
      if (value === null || typeof value === 'boolean' || typeof value === 'string') continue;
      if (typeof value === 'number' && Number.isFinite(value)) continue;
      if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.prototype.toString.call(value) !== '[object Object]')) return null;
      const children = Object.values(value);
      if (children.length + stack.length > 8000) return null;
      for (const child of children) stack.push([child, depth + 1]);
    }
    const text = JSON.stringify(v);
    if (new TextEncoder().encode(text).length > 32768) return null;
    return JSON.parse(text);
  } catch { return null; }
}

/** One submission per mounted surface; later updates must be strictly newer.
 * A new question/attempt must mount a new surface, never retarget an old request.
 * Self-contained because the same rule runs inside the bridge.
 */
export function acceptsWidgetFeedback(current: WidgetAnswerFeedback | null, next: WidgetAnswerFeedback): boolean {
  return !current || (next.requestId === current.requestId && next.timestamp > current.timestamp
    && !(current.status !== 'pending' && next.status === 'pending'));
}

/** Metadata describes intent, never trust. Revalidate even persisted/imported payloads. */
export function validateWidgetPayload(payload: WidgetPayload): void {
  if (!payload || typeof payload.html !== 'string') throw new Error('作品源码缺失或格式无效');
  if (payload.schemaVersion != null && payload.schemaVersion !== 1) throw new Error('此作品协议版本暂不支持，请查看源码');
  if (payload.kind != null && payload.kind !== 'html') throw new Error('作品类型不受支持');
  if (payload.revision != null && (!Number.isSafeInteger(payload.revision) || payload.revision < 1)) throw new Error('作品修订号无效');
  for (const value of [payload.id, payload.ref]) {
    if (value != null && (typeof value !== 'string' || !value || value.length > 128)) throw new Error('作品身份格式无效');
  }
  if (payload.source != null && !['tool', 'legacy-widget', 'legacy-html'].includes(payload.source)) throw new Error('作品来源格式无效');
  const result = validateWidgetArgs({ format: 'html', code: payload.html, libs: payload.libs }, payload.source === 'legacy-html', false);
  if (!result.ok) throw new Error(result.error);
}

/** Called inside the owning message's transaction, or for a transient preview. */
export function versionWidget(payload: WidgetPayload, id: string): WidgetPayload {
  validateWidgetPayload(payload);
  return { ...payload, kind: 'html', schemaVersion: 1, revision: payload.revision ?? 1,
    source: payload.source ?? 'legacy-widget', id, ref: payload.ref ?? id };
}
