import type { AgentStopInfo } from './agent';
import { runCloudTask } from '../cloud/tasks';
import type { ChatImage, QuizState, ChatToolCall } from '../store/db';
import { getSettings, type ModelTarget } from '../store/settings';
import type { ContentPart } from '../api/siliconflow';
import type { WidgetPayload } from './widgetRuntime';
import type { UnitKind } from '../materials/units';
import type { TaskModelSelection } from '@wangke/contracts/cloud';

export interface QaRunInput {
  videoId: string;
  sessionId: number;
  text: string;
  images?: ContentPart[];
  skillIds?: number[];
  explicitSkillIds?: number[];
  modelTarget?: ModelTarget;
  modelSelection?: TaskModelSelection;
  videoName?: string;
  materialKind?: UnitKind;
  materialFormat?: 'pdf' | 'docx' | 'md' | 'html';
  refsCount?: number;
  shotCount?: number;
  displayText?: string;
  chatImages?: ChatImage[];
}
export type QaCard = { kind: 'quiz'; quiz: QuizState } | { kind: 'widget'; widget: WidgetPayload };
export interface QaSink {
  onPersist?: (rowId: number) => void;
  onWidgetPreview?: (preview: { html: string } | undefined) => void;
  onTools?: (tools: ChatToolCall[]) => void;
  onReasoning?: (text: string) => void;
  onDelta?: (text: string) => void;
  onRoundStart?: (round: number) => void;
  onToolStart?: (name: string, argsJson: string, callId: string) => void;
  onToolEnd?: (name: string, result: string, callId: string) => void;
  onStop?: (info: AgentStopInfo) => void;
  onCard?: (card: QaCard) => void;
  signal?: AbortSignal;
}
export interface QaRunResult {
  tools?: ChatToolCall[];
  rowId?: number;
  content: string;
  reasoning?: string;
  reasoningMs?: number;
  quiz?: QuizState;
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
  stopped?: AgentStopInfo;
}

/** Submit and observe; only the server executes tools/models and commits the answer. */
export async function runQa(input: QaRunInput, sink: QaSink = {}): Promise<QaRunResult> {
  let content = '', reasoning = '';
  const delivered = new Set<string>();
  const settings = getSettings();
  return runCloudTask('qa', `session:${input.sessionId}`, { ...input, modelTarget: undefined, thinkingLevel: settings.thinkingEnabled ? settings.thinkingEffort : 'none', modelRef: input.modelTarget ? { providerId: input.modelTarget.providerId, model: input.modelTarget.model } : settings.llmModel }, p => {
    if (typeof p.content === 'string') {
      if (!p.content.startsWith(content)) { sink.onRoundStart?.(0); content = ''; }
      sink.onDelta?.(p.content.slice(content.length)); content = p.content;
    }
    if (typeof p.reasoning === 'string') { sink.onReasoning?.(p.reasoning.slice(reasoning.length)); reasoning = p.reasoning; }
    if (Array.isArray(p.tools)) sink.onTools?.(p.tools);
    if (typeof p.rowId === 'number') sink.onPersist?.(p.rowId);
    sink.onWidgetPreview?.(p.widgetPreview as { html: string } | undefined);
    if (Array.isArray(p.widgets)) for (const widget of p.widgets as WidgetPayload[]) {
      if (!widget?.id || delivered.has(widget.id)) continue;
      delivered.add(widget.id);
      sink.onCard?.({ kind: 'widget', widget });
    }
  }, sink.signal);
}

export function qaToolHint(name: string, argsJson: string, isMaterial: boolean): string {
  if (name.startsWith('MCP · ')) return name;
  let hint = isMaterial ? '正在检索材料…' : '正在检索字幕…';
  try {
    const args = JSON.parse(argsJson || '{}') as { query?: string; name?: string };
    if ((name === 'search_transcript' || name === 'grep') && args.query) hint = `正在检索：${args.query}`;
    if (name === 'search_material' && args.query) hint = `正在检索材料：${args.query}`;
    if (name === 'get_transcript_range') hint = '正在查看字幕原文…';
    if (name === 'get_material_range') hint = '正在查看材料原文…';
    if (name === 'list_frames') hint = '正在查看课程画面…';
    if (name === 'present_quiz') hint = '正在出题…';
    if (name === 'show_widget') hint = '正在预检图形…';
    if (name === 'edit_markdown') hint = '正在修改材料正文…';
    if (name === 'use_skill') hint = `正在加载技能：${args.name ?? ''}`;
    if (name === 'read_skill_reference') hint = '正在查阅参考文档…';
  } catch { /* Display hints must not interfere with server tool results. */ }
  return hint;
}
