import type { ReactNode } from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';
import { useTranslation } from 'react-i18next';
import { Button } from '@heroui/react';
import { linkifyFrames, linkifyTimestamps, linkifyUnits } from '../../utils/linkify';
import type { UnitKind } from '../../materials/units.ts';
import type { MaterialReaderHandle } from '../../materials/types';
import { displayChatError, displayChatFailure } from '../../utils/chatError';
import { PanelBody, PanelPlaceholder } from '../../ui';
import { StreamParagraph } from '../motion';
import ResponseTimeline from '../ResponseTimeline';
import VirtualMessages, { type VirtualMessagesHandle } from '../VirtualMessages';
import ChatHistorySkeleton from '../ChatHistorySkeleton';
import { MarkdownCode, MarkdownPre } from '../mermaid/markdown';
import { MarkdownTable } from '../MdTable';
import { MarkdownStreamingProvider } from '../markdown/streaming';
import { Markdown as XMarkdown } from '../markdown/Markdown';
import { WebsiteCitations } from '../markdown/WebsiteCitations';
import QuizCard from '../QuizCard';
import type { QuizPick } from '../../harness/quiz';
import WidgetMessage from '../WidgetMessage';
import WidgetStreamFrame from '../WidgetStreamFrame';
import { ArtifactEditProvider } from '../ArtifactEditor';
import AssistantContent from '../AssistantContent';
import ChatScreenshots from '../ChatScreenshots';
import { MessageActions } from './MessageActions';
import { UserMessageBubble } from './UserMessageBubble';
import type { ChatMsg } from './chatPanelTypes';

/** 两种自定义 markdown 渲染器的签名（与 `ComponentProps` 的组合在原组件里内联声明） */
export type ComponentLink = (props: ComponentProps & { href?: string }) => ReactNode;
export type ComponentImage = (props: ComponentProps & { src?: string; alt?: string }) => ReactNode;

/**
 * 消息流：骨架 / 空态 / 翻页按钮 / 虚拟列表，以及单条消息的两种气泡。
 *
 * 为什么整块搬出来：这一段的 JSX 与面板的状态机（发送、重试、分叉、删除、滚动）
 * 没有写关系，只需要「数据 + 一组回调」。搬出来之后 ChatPanelBody 只剩会话与输入区，
 * 也不用再把二十个闭包逐个透传成 props —— 回调仍是父组件里的同一份函数，
 * 事件时序与在父组件里内联时完全一致。
 */
export function ChatMessageThread({
  activeId,
  loadedSessionId,
  msgs,
  entering,
  hasOlder,
  loadingOlder,
  historyError,
  loading,
  deleting,
  latestInterruptedKey,
  materialKind,
  videoId,
  videoName,
  widgetDark,
  readerRef,
  listRef,
  virtualMessagesRef,
  onResize,
  onLoadOlder,
  retryMessage,
  forkMessage,
  deleteMessage,
  downloadSession,
  seekTo,
  handleAnswer,
  SeekLink,
  FrameImage,
  send,
  onEditSaved,
}: {
  activeId: number | null;
  loadedSessionId: number | null;
  msgs: ChatMsg[];
  entering: ReadonlySet<string>;
  hasOlder: boolean;
  loadingOlder: boolean;
  historyError: boolean;
  loading: boolean;
  deleting: boolean;
  latestInterruptedKey: string | undefined;
  materialKind: UnitKind | undefined;
  videoId: string;
  videoName: string;
  widgetDark: boolean;
  readerRef?: React.RefObject<MaterialReaderHandle | null>;
  listRef: React.RefObject<HTMLDivElement | null>;
  virtualMessagesRef: React.RefObject<VirtualMessagesHandle | null>;
  onResize: () => void;
  onLoadOlder: () => void;
  retryMessage: (key: string) => Promise<void>;
  forkMessage: (message: ChatMsg) => Promise<void>;
  deleteMessage: (key: string) => void;
  downloadSession: () => Promise<void>;
  seekTo: (t: number) => void;
  handleAnswer: (key: string, qi: number, pick: QuizPick) => Promise<void>;
  /**
   * 正文里挂的自定义 markdown 节点。父组件每次渲染都会重建这两个函数，
   * 与原先内联在列表里的版本等价（同样随父组件重渲染换新）。
   */
  SeekLink: ComponentLink;
  FrameImage: ComponentImage;
  /** 题卡解析里的「继续追问」：交给面板的 send（它会落库、走同一轮问答应答） */
  send: (question: string) => Promise<void>;
  onEditSaved: (row: { id?: number; content: string; responseSegments?: ChatMsg['responseSegments']; widget?: ChatMsg['widget']; widgets?: ChatMsg['widgets'] }) => void;
}) {
  const { t: chatText } = useTranslation('common');
  const isMaterial = materialKind !== undefined;
  // 材料没有播放器：#seek- 要一个存在的播放器才能跳，材料里留着只会是点了没反应的死链。
  const materialLinks = isMaterial && materialKind ? linkifyUnits : undefined;

  return (
    <div className="chat-message-viewport">
      <PanelBody bodyRef={listRef} className="chat-list-wrap" testId="chat-list">
        {activeId != null && loadedSessionId !== activeId && <ChatHistorySkeleton />}
        {msgs.length === 0 && (activeId == null || loadedSessionId === activeId) && (
          <PanelPlaceholder testId="chat-empty">针对课程内容提问，回答中的时间戳可点击跳转</PanelPlaceholder>
        )}
        {msgs.length > 0 && loadedSessionId === activeId && <div className="chat-panel-history" data-chat-session-id={activeId} aria-live="polite">
          {hasOlder && <button type="button" disabled={loadingOlder} onClick={() => void onLoadOlder()}>
            {loadingOlder ? chatText('chat.loadingEarlier') : historyError ? chatText('chat.historyLoadFailed') : chatText('chat.loadEarlier')}
          </button>}
        </div>}
        {msgs.length > 0 && loadedSessionId === activeId && <VirtualMessages key={activeId} items={msgs} scrollRef={listRef} ref={virtualMessagesRef} onResize={onResize}>{(m, index) => {
          const isUser = m.role === 'user';
          /** 与主页同一套判据：回答只重试最后一条；提问只重试「答复就在末尾」的那一句 */
          const canRetry = !isUser && index === msgs.length - 1;
          const canRetryAsk = isUser && msgs[index + 1]?.role === 'ai' && index === msgs.length - 2;
          return (
            <div
              key={m.key}
              className={(isUser ? 'chat-msg chat-msg--user' : 'chat-msg chat-msg--ai')
                + (entering.has(m.key) ? ' t-msg-enter' : '')}
              data-testid={isUser ? 'chat-msg-user' : 'chat-msg-ai'}
              data-streaming={m.streaming ? 'true' : undefined}
              data-error={m.error ? 'true' : undefined}
              data-chat-message={m.key}
            >
              {isUser ? (
                <>
                  {m.images && m.images.length > 0 && <ChatScreenshots images={m.images} materialKind={materialKind}
                    onSource={image => image.kind === 'page-selection' ? readerRef?.current?.scrollToUnit(image.ts) : seekTo(image.ts)} />}
                  <UserMessageBubble
                    message={m}
                    busy={loading || deleting}
                    canRetry={canRetryAsk}
                    onRetry={() => void retryMessage(m.key)}
                    onFork={() => void forkMessage(m)}
                    onDelete={() => void deleteMessage(m.key)}
                  />
                  {!m.streaming && m.rowId != null && (
                    <MessageActions
                      content={m.content}
                      isUser
                      busy={loading || deleting}
                      canRetry={canRetryAsk}
                      retryHint={chatText('chatPanel.retryFull')}
                      onRetry={() => void retryMessage(m.key)}
                      onFork={() => void forkMessage(m)}
                      onExport={downloadSession}
                      onDelete={() => void deleteMessage(m.key)}
                    />
                  )}
                </>
              ) : (
                <>
                  <ArtifactEditProvider rowId={m.rowId} content={m.content} disabled={loading || !!m.streaming || !!m.error}
                    onSaved={(row) => onEditSaved(row)}>
                  <div className="chat-bubble chat-bubble--ai">
                        <WebsiteCitations content={m.error ? '' : m.content} streaming={!!m.streaming}>
                        <WidgetMessage message={m} content={m.error ? displayChatFailure(m.content) : m.content} dark={widgetDark} rowId={m.rowId}
                          disabled={loading || !!m.streaming || !!m.error} onPrompt={(text) => void send(text)}>
                        {(markdown) => (
                          <ResponseTimeline message={m} content={markdown}>
                          {(content, active) => <AssistantContent content={content} streaming={active}>
                            {(part, streaming) => (
                              <MarkdownStreamingProvider value={streaming}>
                                <XMarkdown
                                  // 材料只跑 linkifyUnits：#seek- 需要一个存在的播放器，
                                  // 材料没有播放器，留着会生成点了没反应的死链；
                                  // #frame- 画面引用同理（材料没有抽帧）。
                                  content={
                                    materialLinks && materialKind
                                      ? materialLinks(part, materialKind)
                                      : linkifyTimestamps(linkifyFrames(part))
                                  }
                                  components={{ a: SeekLink, p: StreamParagraph, img: FrameImage, code: MarkdownCode, pre: MarkdownPre, table: MarkdownTable }}
                                  streaming={{ hasNextChunk: streaming, tail: streaming }}
                                />
                              </MarkdownStreamingProvider>
                            )}
                          </AssistantContent>}
                          </ResponseTimeline>
                        )}
                        </WidgetMessage>
                        {m.quiz && (
                          <QuizCard
                            notebookSource={{ courseId: videoId, name: videoName }}
                            quiz={m.quiz.data}
                            picks={m.quiz.picks}
                            onAnswer={(qi, oi) => handleAnswer(m.key, qi, oi)}
                            onReview={loading || m.streaming ? undefined : (text) => void send(text)}
                            onSeek={seekTo}
                            // 材料没有播放器：解析里的时间戳不 linkify，免得出现点了没反应的死链
                            seekable={!isMaterial}
                          />
                        )}
                        {m.widgetPreview && (
                          <WidgetStreamFrame html={m.widgetPreview.html} dark={widgetDark} status={chatText('chatPanel.generatingWidget')} />
                        )}
                        </WebsiteCitations>
                  </div>
                  </ArtifactEditProvider>
                  {!m.streaming && m.interrupted && m.key === latestInterruptedKey && (
                    <div className="chat-note chat-note--interrupted" role="status" data-testid="chat-interrupted">
                      <span>{chatText('chat.interrupted')}{m.interruptReason ? `：${displayChatError(m.interruptReason)}` : ''}</span>
                      <Button size="sm" variant="tertiary" className="chat-note__continue" onPress={() => void retryMessage(m.key)}>
                        {chatText('chat.continue')}
                      </Button>
                    </div>
                  )}
                  {!m.streaming && (m.content || m.widget || m.quiz) && (m.rowId != null || m.error) && (
                    <MessageActions
                      content={m.content}
                      isUser={false}
                      busy={loading || deleting}
                      canRetry={canRetry}
                      retryHint={chatText('chatPanel.regenerate')}
                      onRetry={() => void retryMessage(m.key)}
                      onFork={() => void forkMessage(m)}
                      onExport={downloadSession}
                      onDelete={() => void deleteMessage(m.key)}
                    />
                  )}
                </>
              )}
            </div>
          );
        }}</VirtualMessages>}
      </PanelBody>
    </div>
  );
}
