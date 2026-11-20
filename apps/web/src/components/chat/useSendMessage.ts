import { useTranslation } from 'react-i18next';
import type { ChatImage } from '../../store/db';
import { sessionWriteGuard } from './accountGuard';
import { explicitSkillIds } from '../../skills/activation';
import { type Snapshot } from '../../media/snapshot';
import { fmtTime } from '../../utils/vtt';
import { fmtUnitRef, type UnitKind } from '../../materials/units.ts';
import { formatCitation, type Citation } from '../../store/selectionAsk';
import { framePatch } from '../../utils/framePatch';
import type { WidgetPayload } from '../../harness/widgetRuntime';
import { toast } from '../../ui';
import { taskModelChoice, taskModelKey, useTaskModel } from '../../store/taskModel';
import type { ChatMsg } from './chatPanelTypes';

let keySeq = 0;
const nextKey = () => `${Date.now()}-${keySeq++}`;

/** 一轮问答需要从面板读取的全部状态（与原先内联在 send 里的闭包同源） */
export interface SendParams {
  videoId: string;
  videoName: string;
  materialKind: UnitKind | undefined;
  materialFormat: 'pdf' | 'docx' | 'md' | 'html' | undefined;
  /** 引用条：seat 进消息与提示词，见下 */
  refs: Citation[];
  /** 引用条的最新值（`send` 会被 effect 同步调用，闭包里的 state 可能还没落地） */
  refsRef: React.RefObject<Citation[]>;
  shots: Snapshot[];
  turnSkillIds: number[];
  /** 会话级技能白名单；`undefined` = 不限定 */
  skillIds: number[] | undefined;
  loading: boolean;
  indexReady: boolean;
  activeId: number | null;
  msgs: ChatMsg[];
  localRequest: React.RefObject<boolean>;
  inflightAbort: React.RefObject<AbortController | null>;
  historySession: React.RefObject<number | null>;
  /** 一轮结束后让服务端投影再拉一次（流式进度由它落库，界面上要换成同一行） */
  refreshFollower: () => void;
  setInput: (value: string) => void;
  setShots: (update: (previous: Snapshot[]) => Snapshot[]) => void;
  setRefs: (refs: Citation[]) => void;
  setLoading: (value: boolean) => void;
  setMsgs: (update: (previous: ChatMsg[]) => ChatMsg[]) => void;
  setTurnSkillIds: (ids: number[]) => void;
}

/**
 * 发送一轮提问。
 *
 * 从原来的面板组件里整段搬出，**没有**改事件顺序：先清输入与引用条 → 立刻上屏用户气泡
 * 与 AI 占位 → 才 await 动态 import 的 `runQa`。中途任何一步抛错都落在占位气泡上。
 * 读的仍是面板那一份 state（通过参数传入），所以它看到的是「点击那一刻」的输入与引用。
 */
export function useSendMessage(p: SendParams) {
  const { t: chatText } = useTranslation('common');
  const isMaterial = p.materialKind !== undefined;

  /**
   * 发送一轮提问。
   *
   * `extraRefs` 用于「解释这段」：那一步在 effect 里触发，走 refsRef 传进来，
   * 免得依赖 state 的落地时序。普通输入框发送不传，用当前引用条。
   */
  const send = async (question: string, extraRefs?: Citation[], suppliedSkills?: number[]) => {
    const q = question.trim();
    const curRefs = extraRefs ?? p.refsRef.current;
    // 引用也算内容：只划了词没打字也应能发送
    if ((!q && p.shots.length === 0 && curRefs.length === 0) || p.loading || p.activeId == null) return;
    if (!p.indexReady) {
      toast.warning(chatText('chatPanel.indexNotReady'));
      return;
    }
    const sessionId = p.activeId;
    /**
     * 框选截图与视频截图共用同一条多模态通道：把引用里的裁图折进 shots，
     * 下面的「多模态直读 / 视觉模型描述 / 不支持则拦截」三级降级链就**一行都不用改**。
     * 材料的锚点是页号，正好复用 Snapshot.ts 这个字段（语义由 isMaterial 决定）。
     */
    const refShots: Snapshot[] = curRefs
      .filter((c) => c.image)
      .map((c) => ({ dataUrl: c.image!.dataUrl, thumb: c.image!.thumb, ts: c.unit ?? 0 }));
    const curShots = [...p.shots, ...refShots].sort((a, b) => a.ts - b.ts);

    /** 素材标记：视频是 [截图@mm:ss]，材料是 [选区@第N页] */
    const shotTag = (s: Snapshot) =>
      isMaterial ? `[选区@${fmtUnitRef(p.materialKind!, s.ts)}]` : `[截图@${fmtTime(s.ts)}]`;

    // Screenshot capability and any vision-model preparation belong to the server.
    const current = sessionWriteGuard(() => p.historySession.current === sessionId);

    p.setInput('');
    p.setShots(() => []);
    p.setRefs([]);
    p.refsRef.current = [];
    p.setLoading(true);
    p.localRequest.current = true;

    const userKey = nextKey();
    const aiKey = nextKey();
    let answer = '';
    let reasoning = '';
    const selectedSkills = explicitSkillIds(suppliedSkills ?? p.turnSkillIds);
    let widgetState: WidgetPayload | undefined;
    const widgets: WidgetPayload[] = [];
    const abort = new AbortController();
    p.inflightAbort.current = abort;
    const updates = framePatch<ChatMsg>((patch) => {
      if (current()) p.setMsgs((prev) => prev.map((m) => (m.key === aiKey ? { ...m, ...patch } : m)));
    });
    const patchAi = updates.write;

    try {
      // 先上屏用户气泡与 AI 占位，此后描述/落库/问答任何一步抛错都能落到占位气泡上
      //
      // 引用块放在最前面：模型对「开头是引用、后面是问题」的结构最敏感，
      // 也让用户回看历史时一眼看到「我当时引的是哪一段」。
      const quoteBlock = curRefs.map(formatCitation).join('\n\n');
      const marker = curShots.map(shotTag).join('');
      const displayContent = (quoteBlock ? `${quoteBlock}\n\n` : '') + marker + q;
      const createdAt = Date.now();
      const userImages: ChatImage[] = curShots.map((s) =>
        isMaterial
          ? {
              ts: s.ts,
              thumb: s.thumb,
              label: `${fmtUnitRef(p.materialKind!, s.ts)}选区`,
              kind: 'page-selection' as const,
            }
          : { ts: s.ts, thumb: s.thumb },
      );
      p.setMsgs((prev) => [
        ...prev,
        {
          key: userKey,
          role: 'user',
          content: displayContent,
          explicitSkillIds: selectedSkills,
          createdAt,
          images: userImages.length > 0 ? userImages : undefined,
        },
        { key: aiKey, role: 'ai', content: '', streaming: true, processStartedAt: Date.now() },
      ]);

        const { runQa } = await import('../../harness/qaRunner');
        const result = await runQa({ videoId: p.videoId, sessionId, text: (quoteBlock ? `${quoteBlock}\n\n` : '') + q,
          displayText: displayContent, chatImages: userImages, videoName: p.videoName, skillIds: p.skillIds, explicitSkillIds: selectedSkills,
          modelSelection: taskModelChoice(sessionId),
          materialKind: p.materialKind, materialFormat: p.materialFormat, refsCount: curRefs.length, shotCount: curShots.length,
          images: curShots.flatMap(s => [{ type: 'text' as const, text: shotTag(s) }, { type: 'image_url' as const, image_url: { url: s.dataUrl } }]),
        }, { signal: abort.signal,
          onPersist: rowId => patchAi({ rowId }),
          onWidgetPreview: preview => patchAi({ widgetPreview: preview }),
          onProgress: progress => { answer = progress.content; reasoning = progress.reasoning; updates.stream(progress); },
          onCard: card => {
            if (card.kind === 'widget') { widgetState = card.widget; widgets.push(card.widget); patchAi({ widgets: [...widgets], widget: card.widget }); }
          },
        });
        patchAi({ ...result, streaming: false, hint: undefined, widgetPreview: undefined });
        if (current()) { p.setTurnSkillIds([]); useTaskModel.getState().set(taskModelKey(sessionId)); }
    } catch (e) {
        // Server progress already owns the durable row. Never create a second
        // local assistant when a remote task fails before the next sync poll.
        const reason = e instanceof Error ? e.message : String(e);
        const useful = !!answer.trim() || !!widgetState;
        patchAi({ streaming: false, hint: undefined, widgetPreview: undefined,
          content: abort.signal.aborted ? `${answer}\n\n_（已停止生成）_` : useful ? answer : `回答失败：${reason}`,
          error: !useful && !abort.signal.aborted, interrupted: useful && !abort.signal.aborted,
          interruptReason: abort.signal.aborted ? undefined : reason });
    } finally {
      updates.flush();
      if (p.inflightAbort.current === abort) p.inflightAbort.current = null;
      if (current()) { p.localRequest.current = false; p.setLoading(false); p.refreshFollower(); }
    }
  };

  return { send };
}
