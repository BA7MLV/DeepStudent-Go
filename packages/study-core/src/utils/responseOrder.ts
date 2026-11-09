import type { ResponseSegment } from '@wangke/contracts/client-runtime';
export type { ResponseSegment } from '@wangke/contracts/client-runtime';

/** Opening line of the Markdown fence covering `offset`, when slicing there would split it. */
export function fenceStartAt(content: string, offset: number): number | null {
  if (offset <= 0 || offset > content.length) return null;
  const lines = content.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  let at = 0;
  let open: { start: number; marker: string } | undefined;
  for (const line of lines) {
    const text = line.replace(/\r?\n$/, '');
    const lineStart = at;
    at += line.length;
    if (open) {
      if (new RegExp(`^ {0,3}${open.marker[0]}{${open.marker.length},}[ \t]*$`).test(text)) {
        if (offset > open.start && offset < at) return open.start;
        open = undefined;
      } else if (offset > open.start && offset <= at) return open.start;
      continue;
    }
    const match = /^ {0,3}(`{3,}|~{3,})\s*([^\s`~]*)[^\r\n]*$/.exec(text);
    if (match) {
      open = { start: lineStart, marker: match[1] };
      if (offset > lineStart && offset <= at) return lineStart;
    }
  }
  return open && offset > open.start ? open.start : null;
}

/** New activity never moves above text that has already been delivered. */
export function beginResponseSegment(segments: ResponseSegment[], content: string, reasoning: string, tools: readonly unknown[], now = Date.now()): ResponseSegment[] {
  const last = segments.at(-1);
  if (last && !content.slice(last.contentOffset).trim()) return segments;
  // Anchors must land on Markdown block boundaries: an open fence stays whole.
  const fence = fenceStartAt(content, content.length);
  const contentOffset = fence ?? content.length;
  if (last && contentOffset <= last.contentOffset) return segments;
  return [...segments, { contentOffset, reasoningOffset: reasoning.length, toolOffset: tools.length, startedAt: now }];
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
  const raw = valid ? segments : [{ contentOffset: 0, reasoningOffset: 0, toolOffset: 0 }];
  // Legacy anchors may sit inside a fence; fall back to its opening line and
  // merge any anchor that no longer advances into the previous process group.
  const safe: ResponseSegment[] = [];
  for (const segment of raw) {
    const fence = fenceStartAt(content, segment.contentOffset);
    const anchor = fence == null ? segment : { ...segment, contentOffset: fence };
    if (safe.length && anchor.contentOffset <= safe[safe.length - 1].contentOffset) continue;
    safe.push(anchor);
  }
  const anchors = safe;
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
