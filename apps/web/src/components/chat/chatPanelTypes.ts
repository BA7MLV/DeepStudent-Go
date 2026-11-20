import type { MediaPlayerInstance } from '@vidstack/react';
import type { ResponseSegment } from '@wangke/contracts/client-runtime';
import type { ChatImage, ChatToolCall, QuizState } from '../../store/db';
import type { UnitKind } from '../../materials/units.ts';
import type { MaterialReaderHandle } from '../../materials/types';
import type { WidgetPayload } from '../../harness/widgetRuntime';
import type { ProcessPhase } from '../../utils/responseProcess';

export interface ChatPanelProps {
  videoId: string;
  videoName: string;
  /** 视频：播放器实例；材料：传一个恒为 null 的 ref（材料没有播放器） */
  playerRef: React.RefObject<MediaPlayerInstance | null>;
  /**
   * 阅读器句柄（只有材料课程有）。用于把回答里的 `[第3页]` 引用变成「点一下就滚过去」。
   * 与 playerRef 完全对称：视频靠 playerRef 跳时间，材料靠 readerRef 跳页/段。
   */
  readerRef?: React.RefObject<MaterialReaderHandle | null>;
  /**
   * 材料的定位单元类型：`'page'`（PDF）/ `'para'`（Word）。
   * **不传 = 视频课程**，此时走字幕检索 + 时间戳引用。
   */
  materialKind?: UnitKind;
  /**
   * 材料的原始格式（视频课程不传）。**只有 `'md'` 有编辑面**，
   * `edit_markdown` 工具与「材料可编辑」那条提示词都据此开关（见 send 里那段注释）。
   *
   * 为什么与 materialKind 分开两个 prop：kind 是**定位单位**（页码 / 段落号），
   * format 是**文件格式**（能不能改）。`'html'` 与 `'md'` 的定位单位相同但一个能改一个不能，
   * 合成一个 prop 就得在两边各自反推「这个 kind 是不是可编辑的」，那是两处会漂移的判断。
   */
  materialFormat?: 'pdf' | 'docx' | 'md' | 'html';
}

export interface ChatMsg {
  responseSegments?: ResponseSegment[];
  processPhase?: ProcessPhase;
  /** 本轮启动时刻，切页重挂时不重置过程计时（不落库）。 */
  processStartedAt?: number;
  key: string;
  role: 'user' | 'ai';
  content: string;
  explicitSkillIds?: number[];
  /** 落库时间：手机端长按用户气泡时显示（与主页对话一致） */
  createdAt?: number;
  /** 用户消息附带的截图缩略图 */
  images?: ChatImage[];
  /** 思考过程（推理模型 reasoning_content 的回调累计值） */
  reasoning?: string;
  /** 思考耗时（毫秒）：首个思考 token → 末个。落库，历史消息也显示 */
  reasoningMs?: number;
  /**
   * 首个思考 token 的时刻（毫秒时间戳）。
   *
   * **不落库**：它只服务「思考中」那几秒的实时计时（`ReasoningChain` 的 `since`），
   * 历史消息用的是终值 `reasoningMs`。存进库里只会多一个没人读、还会过期的字段。
   */
  reasoningStartedAt?: number;
  /** 工具调用期间的提示（如"正在检索…"） */
  hint?: string;
  /**
   * 这一轮调过的工具（含正在跑的那次）。落库，历史消息也回放 ——
   * 见 `components/ToolTrace.tsx` 顶部那段「为什么要有这一块」。
   */
  tools?: ChatToolCall[];
  /** 答题卡（present_quiz 工具产出） */
  quiz?: QuizState;
  /** 沙箱图形卡（show_widget 的 html 形态产出） */
  widget?: WidgetPayload;
  widgets?: WidgetPayload[];
  /** show_widget 参数尚未完整到达时的静态安全预览（不落库） */
  widgetPreview?: { html: string };
  /** 落库后的 chats 行 id（作答状态回写用） */
  rowId?: number;
  taskId?: string;
  streaming?: boolean;
  error?: boolean;
  interrupted?: boolean;
  interruptReason?: string;
}

