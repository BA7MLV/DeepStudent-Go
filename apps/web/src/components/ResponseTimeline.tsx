import { Fragment, type ReactNode } from 'react';
import type { CourseChatMessage } from '../store/courseChat';
import { responseTimeline } from '../utils/responseOrder';
import ResponseProcess from './ResponseProcess';

/**
 * 提问卡是「这一轮先问、用户答完再继续」的分界。它必须落在提问发生的位置，
 * 而不是整条消息的末尾：续跑的正文和推理都追加在同一条消息里，卡片留在末尾
 * 就会把用户回答之后的思考链顶到卡片前面。
 *
 * `ask_user` 是一条工具 trace，所在分段的 contentOffset 正是提问那一刻的正文长度，
 * 所以按 trace 找锚点无需额外落库，旧消息也能按同一规则回放。
 */
function askToolIndex(calls: CourseChatMessage['tools']): number {
  let found = -1;
  (calls ?? []).forEach((call, index) => { if (call.name === 'ask_user') found = index; });
  return found;
}

/** The same ordered transcript is used during streaming, continuation and history replay. */
export default function ResponseTimeline({ message, content, ask, children }: {
  message: Pick<CourseChatMessage, 'responseSegments' | 'reasoning' | 'tools' | 'ask' | 'folderPlan' | 'streaming' | 'processPhase' | 'hint' | 'processStartedAt' | 'reasoningStartedAt' | 'reasoningMs'>;
  content: string;
  /** 已回答的提问卡；由页面提供，按提问 trace 的位置插入时间线。 */
  ask?: ReactNode;
  children: (content: string, streaming: boolean) => ReactNode;
}) {
  const reasoning = message.reasoning ?? '';
  const calls = message.tools ?? [];
  const waiting = !!message.ask && !message.ask.picked || !!message.folderPlan && message.folderPlan.applied === 0;
  const askWaiting = !!message.ask && !message.ask.picked;
  const slices = responseTimeline(content, reasoning, calls, message.responseSegments);
  const askedAt = askToolIndex(calls);
  const timeline = slices.map(({ segment, last, content: text, reasoning: processReasoning, tools }, index) => {
    const streaming = last && !!message.streaming && (!message.responseSegments?.length || !text.trim() || message.processPhase !== 'answering');
    const since = segment.startedAt ?? message.processStartedAt ?? message.reasoningStartedAt;
    const answer = text && <><div aria-hidden="true" data-chat-answer-start="" />
      {children(text, last && !!message.streaming && (!message.processPhase || message.processPhase === 'answering'))}</>;
    // 提问 trace 落在本段才拆；正常分段保持原来的「过程 → 正文」顺序。
    const localAsk = askedAt >= segment.toolOffset && askedAt < segment.toolOffset + tools.length ? askedAt - segment.toolOffset : -1;
    if (localAsk < 0) {
      return <Fragment key={index}>
        <ResponseProcess reasoning={processReasoning} calls={tools} streaming={streaming}
          phase={message.processPhase} hint={last ? message.hint : undefined} waiting={last && waiting}
          since={since} elapsedMs={slices.length === 1 ? message.reasoningMs : undefined} />
        {answer}
      </Fragment>;
    }
    // 旧记录可能没有 reasoningOffset：此时不猜推理顺序，只保证卡片仍在续跑正文之前。
    const askOffset = tools[localAsk]?.reasoningOffset;
    const split = askOffset == null ? processReasoning.length : Math.max(0, Math.min(processReasoning.length, askOffset));
    const preReasoning = processReasoning.slice(0, split), preTools = tools.slice(0, localAsk + 1);
    const postReasoning = processReasoning.slice(split), postTools = tools.slice(localAsk + 1);
    const postActive = !!postReasoning.trim() || postTools.length > 0;
    return <Fragment key={index}>
      <ResponseProcess reasoning={preReasoning} calls={preTools} streaming={streaming && askWaiting}
        waiting={last && askWaiting} since={since}
        elapsedMs={last && !postActive && slices.length === 1 ? message.reasoningMs : undefined} />
      {ask}
      <ResponseProcess reasoning={postReasoning} calls={postTools} streaming={streaming && !askWaiting}
        phase={message.processPhase} hint={last ? message.hint : undefined}
        elapsedMs={last && slices.length === 1 ? message.reasoningMs : undefined} />
      {answer}
    </Fragment>;
  });
  // 提问卡没有对应的工具 trace（极旧数据）时仍要显示，宁可回到末尾也不能丢。
  return <>{timeline}{askedAt < 0 && ask}</>;
}
