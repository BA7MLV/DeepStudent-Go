import { Fragment, type ReactNode } from 'react';
import type { CourseChatMessage } from '../store/courseChat';
import { responseTimeline } from '../utils/responseOrder';
import ResponseProcess from './ResponseProcess';

/** The same ordered transcript is used during streaming, continuation and history replay. */
export default function ResponseTimeline({ message, content, children }: {
  message: Pick<CourseChatMessage, 'responseSegments' | 'reasoning' | 'tools' | 'ask' | 'folderPlan' | 'streaming' | 'processPhase' | 'hint' | 'processStartedAt' | 'reasoningStartedAt' | 'reasoningMs'>;
  content: string;
  children: (content: string, streaming: boolean) => ReactNode;
}) {
  const reasoning = message.reasoning ?? '';
  const calls = message.tools ?? [];
  const waiting = !!message.ask && !message.ask.picked || !!message.folderPlan && message.folderPlan.applied === 0;
  const slices = responseTimeline(content, reasoning, calls, message.responseSegments);
  return slices.map(({ segment, last, content: text, reasoning: processReasoning, tools }, index) => {
    return <Fragment key={index}>
      <ResponseProcess reasoning={processReasoning} calls={tools}
        streaming={last && !!message.streaming && (!message.responseSegments?.length || !text.trim() || message.processPhase !== 'answering')}
        phase={message.processPhase} hint={last ? message.hint : undefined} waiting={last && waiting}
        since={segment.startedAt ?? message.processStartedAt ?? message.reasoningStartedAt}
        elapsedMs={slices.length === 1 ? message.reasoningMs : undefined} />
      {text && <><div aria-hidden="true" data-chat-answer-start="" />
        {children(text, last && !!message.streaming && (!message.processPhase || message.processPhase === 'answering'))}</>}
    </Fragment>;
  });
}
