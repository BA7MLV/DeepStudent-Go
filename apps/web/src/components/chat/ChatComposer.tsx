import { Suspense, lazy } from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Dropdown, Tooltip } from '@heroui/react';
import type { Snapshot } from '../../media/snapshot';
import { fmtTime } from '../../utils/vtt';
import { fmtUnitRef, type UnitKind } from '../../materials/units.ts';
import type { Citation } from '../../store/selectionAsk';
import type { CompressionState } from '../../store/contextCompression';
import { Sym, toast } from '../../ui';
import { assertPluginAvailable } from '../../plugins/availability';
import ComposerExpand from '../ComposerExpand';
import ContextUsageButton from '../ContextUsageButton';
import TaskModelPicker from '../TaskModelPicker';
import type { InlineSkillInputHandle } from '../InlineSkillInput';
// CodeMirror 全家桶(~130KB gzip)只服务这个输入框,懒加载别让对话首屏静态依赖它。
const InlineSkillInput = lazy(() => import('../InlineSkillInput'));

/**
 * 输入区：引用条 / 待发送截图 / 文本编辑 / 工具行（添加、用量环、发送键）。
 *
 * 这里只收「值 + 回调」，不参与发送状态机：`send` / `stopGenerating` 由面板持有，
 * 点击顺序与原先内联时一致（同一次 DOM 事件同步调用）。
 */
export function ChatComposer({
  activeId,
  loadedSessionId,
  input,
  onInputChange,
  loading,
  indexReady,
  isMaterial,
  materialKind,
  materialFormat,
  refs,
  onRemoveRef,
  shots,
  onRemoveShot,
  turnSkillIds,
  onTurnSkillsChange,
  skillIds,
  mcpServerIds,
  skillsOpen,
  onSkillsOpenChange,
  composerOverflow,
  onComposerOverflowChange,
  composerInput,
  addButton,
  addOpen,
  onAddOpenChange,
  practiceAvailable,
  reviewAvailable,
  onOpenPlugin,
  onShot,
  send,
  onStop,
  ctxEst,
  ctxWin,
  ctxBreakdown,
  contextCompression,
  ctxLevel,
  pinList,
}: {
  activeId: number | null;
  loadedSessionId: number | null;
  input: string;
  onInputChange: (value: string) => void;
  loading: boolean;
  indexReady: boolean;
  isMaterial: boolean;
  materialKind: UnitKind | undefined;
  materialFormat: 'pdf' | 'docx' | 'md' | 'html' | undefined;
  refs: Citation[];
  onRemoveRef: (index: number) => void;
  shots: Snapshot[];
  onRemoveShot: (index: number) => void;
  turnSkillIds: number[];
  onTurnSkillsChange: (ids: number[]) => void;
  skillIds: number[] | undefined;
  mcpServerIds: string[] | undefined;
  skillsOpen: boolean;
  onSkillsOpenChange: (open: boolean) => void;
  composerOverflow: boolean;
  onComposerOverflowChange: (overflow: boolean) => void;
  composerInput: React.RefObject<InlineSkillInputHandle | null>;
  addButton: React.RefObject<HTMLButtonElement | null>;
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
  practiceAvailable: boolean;
  reviewAvailable: boolean;
  onOpenPlugin: (id: string) => void;
  onShot: () => void;
  send: (question: string) => Promise<void>;
  onStop: () => void;
  ctxEst: number;
  ctxWin: number;
  ctxBreakdown: { system: number; history: number; current: number };
  contextCompression: { state: CompressionState; compress: () => void };
  ctxLevel: '' | 'warn' | 'bad';
  pinList: () => void;
}) {
  const { t: chatText } = useTranslation('common');
  const { t: settingsText } = useTranslation('settings');

  return (
    <div className="chat-composer" data-testid="chat-composer">
      {/*
        引用条：划词/框选带进来的原文片段（最多 MAX_REFS 条）。
        单独一行而不是塞进输入框文本里 —— 用户能一眼看清引了什么、能单条删掉，
        也不会污染自己正在写的句子。
      */}
      {refs.length > 0 && (
        <div className="chat-refs" data-testid="chat-refs">
          {refs.map((c, i) => (
            <span
              key={`${c.source}-${c.unit ?? c.time ?? 0}-${i}`}
              className="chat-ref"
              data-testid="chat-ref-chip"
            >
              {c.image && <img src={c.image.thumb} alt="" className="chat-ref__img" />}
              <span className="chat-ref__body">
                {c.unitLabel && <span className="chat-ref__where">{c.unitLabel}</span>}
                <span className="chat-ref__text" title={c.text}>
                  {c.text}
                </span>
              </span>
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                className="chat-ref__remove"
                aria-label={chatText('chatPanel.removeQuote')}
                data-testid="ref-chip-remove"
                onPress={() => onRemoveRef(i)}
              >
                <Sym name="close" />
              </Button>
            </span>
          ))}
        </div>
      )}
      {shots.length > 0 && (
        <div className="chat-shots chat-shots--pending">
          {shots.map((s, i) => (
            <span key={i} className="chat-shot">
              <img src={s.thumb} alt="" className="chat-shot__img chat-shot__img--sm" />
              <span className="chat-ts-chip">
                {isMaterial ? fmtUnitRef(materialKind!, s.ts) : fmtTime(s.ts)}
              </span>
              <Button
                isIconOnly
                variant="tertiary"
                size="sm"
                className="chat-shot__remove"
                aria-label={chatText('chatPanel.removeShot')}
                onPress={() => onRemoveShot(i)}
              >
                <Sym name="close" />
              </Button>
            </span>
          ))}
        </div>
      )}
      <div className="chat-composer__row">
        <ComposerExpand visible={composerOverflow} key={activeId} value={input} onChange={onInputChange}
          renderInput={className => <Suspense fallback={null}><InlineSkillInput expanded autoFocus className={className} label={chatText('chatPanel.fullMessage')}
            value={input} onChange={onInputChange} skillIds={turnSkillIds} availableSkillIds={skillIds} onSkillsChange={onTurnSkillsChange} /></Suspense>} />
        <div className="chat-input" data-testid="chat-input">
          <Suspense fallback={null}>
          <InlineSkillInput
            documentKey={activeId}
            label={chatText('chatPanel.composerLabel')}
            placeholder={indexReady ? chatText('chatPanel.inputReady') : chatText('chatPanel.inputWaiting')}
            disabled={!indexReady}
            value={input}
            ref={composerInput}
            onChange={onInputChange}
            skillIds={turnSkillIds}
            availableSkillIds={skillIds}
            onSkillsChange={onTurnSkillsChange}
            onOverflowChange={onComposerOverflowChange}
            onFocus={pinList}
            onSubmit={() => void send(input)}
          />
          </Suspense>
        </div>
        <div className="chat-composer__tools">
        <Dropdown isOpen={addOpen} onOpenChange={onAddOpenChange}>
          <Button ref={addButton} isIconOnly variant="tertiary" size="sm" data-testid="panel-chat-add"
            aria-label={chatText('chatPanel.addMenuAria')} isDisabled={activeId == null || activeId !== loadedSessionId}>
            <Sym name="add" />
          </Button>
          <Dropdown.Popover placement="top start">
            <div className="px-2 py-1">
              <TaskModelPicker sessionId={activeId} />
            </div>
            <Dropdown.Menu aria-label={chatText('chatPanel.addToQA')}
              disabledKeys={[
                ...(!indexReady || loading ? ['shot', 'quiz', 'question-bank', 'bank-practice'] : []),
                ...(!practiceAvailable ? ['quiz', 'question-bank', 'bank-practice'] : []),
                ...(!reviewAvailable ? ['review'] : []),
                ...(shots.length >= 4 ? ['shot'] : []),
              ]}
              onAction={(key) => {
                if (key === 'shot') onShot();
                else if (key === 'quiz') onOpenPlugin('practice');
                else if (key === 'quiz') void assertPluginAvailable('practice').then(() => send('根据课程内容出 3 道单选题考考我，选项要有干扰性')).catch(e => toast.error(e.message));
                else if (key === 'question-bank') onOpenPlugin('practice');
                else if (key === 'question-bank') void send('请按「原题题库」技能，逐页提取这份资料的原题，保留题号、题干、选项和原图引用，核对原文答案及解析，并用 edit 保存到 /courses/current/questions.md。已有题库就读最新版后继续，不覆盖用户修改。缺答案和无法辨读的题明确标注；预算不足先保存已完成部分并说明尚未覆盖范围，不要重新编题。保存后给我题库链接，并展示第一批原题供我直接作答和批改。');
                else if (key === 'bank-practice') onOpenPlugin('practice');
                else if (key === 'bank-practice') void send(`请从题库最新版开始做原题。${materialFormat === 'md' ? '先 read 当前 Markdown 原文：若它本身含原题 quiz 数据块，使用 /courses/current/material，否则使用 /courses/current/questions.md。' : '题库路径为 /courses/current/questions.md。'}调用 present_quiz 的 path 参数，每批最多 5 题，不要改写或提前透露答案。若题库尚不存在，请说明并引导先提取原题。`);
                else if (key === 'review') onOpenPlugin('review');
                else if (key === 'skills') onSkillsOpenChange(true);
              }}>
              {!isMaterial && <Dropdown.Item id="shot" textValue={chatText('chatPanel.shot')} data-testid="shot-btn"><Sym name="photo_camera" />{chatText('chatPanel.shot')}</Dropdown.Item>}
              <Dropdown.Item id="quiz" textValue={chatText('chatPanel.quizMe')} data-testid="quiz-btn"><Sym name="quiz" />{chatText('chatPanel.quizMe')}</Dropdown.Item>
              {isMaterial && <Dropdown.Item id="question-bank" textValue={chatText('chatPanel.extractQuestions')} data-testid="question-bank-extract"><Sym name="description" />{chatText('chatPanel.extractQuestions')}</Dropdown.Item>}
              {isMaterial && <Dropdown.Item id="bank-practice" textValue={chatText('chatPanel.startQuiz')} data-testid="question-bank-practice"><Sym name="quiz" />{chatText('chatPanel.startQuiz')}</Dropdown.Item>}
              {<Dropdown.Item id="review" textValue={chatText('chatPanel.reviewList')} data-testid="question-bank-review"><Sym name="checklist" />{chatText('chatPanel.reviewList')}</Dropdown.Item>}
              <Dropdown.Item id="skills" textValue={settingsText('skillPicker.title')}><Sym name="extension" />{settingsText('skillPicker.title')}{skillIds !== undefined || mcpServerIds !== undefined ? chatText('chatPanel.restrictedSuffix') : ''}</Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
        {/* 上文用量环：只留环，不再跟一串 `≈2.1k / 131k` 文字 —— 常驻的估值
            在工具行上太吵（详情在环的弹层里），文字还会把发送键从最右侧挤开。
            环排在发送键**前面**，发送键永远占最右那一格。 */}
        <div className={ctxLevel ? `chat-ctx chat-ctx--${ctxLevel}` : 'chat-ctx'} data-testid="chat-ctx">
          <ContextUsageButton
            tokens={ctxEst} windowTokens={ctxWin} breakdown={ctxBreakdown} testId="panel-context-usage"
            compression={contextCompression.state} onCompress={contextCompression.compress}
            isDisabled={loading || !indexReady || activeId == null || activeId !== loadedSessionId}
          />
        </div>
        {/* 生成中：发送键**变成**停止键。单课程问答没有课程上下文要等用户，
            所以不用给「提问卡悬着」开口子（那边是例外）。 */}
        {loading ? (
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                variant="secondary"
                size="sm"
                className="chat-send"
                data-testid="chat-stop"
                aria-label={chatText('chatPanel.stop')}
                onPress={onStop}
              >
                <Sym name="stop" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>停止生成</p>
            </Tooltip.Content>
          </Tooltip>
        ) : (
          <Tooltip>
            <Tooltip.Trigger>
              <Button
                isIconOnly
                variant="primary"
                size="sm"
                className="chat-send"
                data-testid="chat-send"
                aria-label={chatText('chatPanel.send')}
                isDisabled={!indexReady}
                onPress={() => send(input)}
              >
                <Sym name="arrow_upward" />
              </Button>
            </Tooltip.Trigger>
            <Tooltip.Content>
              <p>发送</p>
            </Tooltip.Content>
          </Tooltip>
        )}
        </div>
      </div>
    </div>
  );
}
