import type { ResponseSegment } from '@wangke/contracts/client-runtime';
export type { ResponseSegment } from '@wangke/contracts/client-runtime';

/** New activity never moves above text that has already been delivered. */
export function beginResponseSegment(segments: ResponseSegment[], content: string, reasoning: string, tools: readonly unknown[], now = Date.now()): ResponseSegment[] {
  const last = segments.at(-1);
  if (last && !content.slice(last.contentOffset).trim()) return segments;
  return [...segments, { contentOffset: content.length, reasoningOffset: reasoning.length, toolOffset: tools.length, startedAt: now }];
}

/** Preserve the exact rendered prefix, including Markdown indentation. */
export function nextResponseRound(content: string): string {
  if (!content || content.endsWith('\n\n')) return content;
  return content + (content.endsWith('\n') ? '\n' : '\n\n');
}

/** Local artifact edits shift later anchors, never their identity. */
export function rebaseResponseSegments(segments: ResponseSegment[], before: string, after: string): ResponseSegment[] {
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start++;
  let end = before.length, nextEnd = after.length;
  while (end > start && nextEnd > start && before[end - 1] === after[nextEnd - 1]) { end--; nextEnd--; }
  return segments.map(segment => ({ ...segment, contentOffset: segment.contentOffset <= start ? segment.contentOffset
    : segment.contentOffset >= end ? segment.contentOffset + nextEnd - end : nextEnd }));
}

/** Legacy or invalid anchors fall back without dropping or duplicating text. */
export function responseTimeline<T extends { reasoningOffset?: number }>(content: string, reasoning: string, tools: T[], segments?: ResponseSegment[]) {
  const valid = Array.isArray(segments) && segments.length && segments.every((segment, index) => {
    if (!segment || typeof segment !== 'object') return false;
    const previous = segments[index - 1];
    return (['contentOffset', 'reasoningOffset', 'toolOffset'] as const).every((key, dimension) =>
      Number.isSafeInteger(segment[key]) && segment[key] >= (previous?.[key] ?? 0)
      && segment[key] <= [content.length, reasoning.length, tools.length][dimension]
      && (index !== 0 || segment[key] === 0));
  });
  const anchors = valid ? segments : [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0 }];
  return anchors.map((segment, index) => {
    const next = anchors[index + 1];
    return {
      segment, last: !next,
      content: content.slice(segment.contentOffset, next?.contentOffset),
      reasoning: reasoning.slice(segment.reasoningOffset, next?.reasoningOffset),
      tools: tools.slice(segment.toolOffset, next?.toolOffset).map(call => ({ ...call,
        reasoningOffset: call.reasoningOffset == null ? undefined : Math.max(0, call.reasoningOffset - segment.reasoningOffset),
      })),
    };
  });
}
