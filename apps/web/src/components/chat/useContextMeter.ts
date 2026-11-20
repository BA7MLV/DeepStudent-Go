import { useMemo } from 'react';
import { estimateTokens } from '../../harness/context';
import { PROMPTS } from '../../harness/prompts';
import { retainedContext, type CompressionState } from '../../store/contextCompression';
import { useSettings } from '../../store/settings';
import type { Citation } from '../../store/selectionAsk';
import type { UnitKind } from '../../materials/units.ts';
import type { Snapshot } from '../../media/snapshot';
import { useContextCompression } from '../useContextCompression';
import type { ChatMsg } from './chatPanelTypes';

/**
 * 输入框上方的上下文用量环：估算本次请求会带多少 token，并接管压缩入口。
 *
 * 估算**只是 UI 提示**，不参与发送 —— 真正发出去的提示词由 `runQa` 自己拼。
 * 所以这里按「最坏情况」估：宁可估高一点（用量条早变色），也不能估低让用户以为还有余量。
 */
export function useContextMeter({
  videoName,
  materialKind,
  materialFormat,
  isMaterial,
  input,
  shots,
  refs,
  msgs,
  agentInstructions,
  compressionEnabled,
  contextPlan,
  activeId,
  loadedSessionId,
  loading,
  indexReady,
}: {
  videoName: string;
  materialKind: UnitKind | undefined;
  materialFormat: 'pdf' | 'docx' | 'md' | 'html' | undefined;
  isMaterial: boolean;
  input: string;
  shots: Snapshot[];
  refs: Citation[];
  msgs: ChatMsg[];
  agentInstructions: string;
  compressionEnabled: boolean;
  contextPlan: CompressionState;
  activeId: number | null;
  loadedSessionId: number | null;
  loading: boolean;
  indexReady: boolean;
}) {
  const ctxWin = useSettings((s) => s.contextWindow);
  const ctxBreakdown = useMemo(() => {
    // 注意 estimateTokens：两个 qaSystem 返回的都是**提示词文本**，忘了包就变成字符串拼接
    // 末尾的 canEditMd 参数：这里用「格式是 md」代替 send 里的完整判断（材料 + 编辑面开着）——
    // 注册表是模块级的，点「编辑」不会触发本组件重渲染，按状态算就得把它塞进 useMemo 依赖。
    // 于是按「最坏情况 = 多带一条可编辑规则」估：估高只是用量条早一点变色，估低会让用户以为还有余量。
    const sysText = isMaterial
      ? PROMPTS.qaSystemMaterial(videoName, materialKind!, undefined, shots.length, refs.length, materialFormat === 'md', agentInstructions)
      : PROMPTS.qaSystem(videoName, undefined, undefined, shots.length, refs.length, agentInstructions);
    const sys = estimateTokens(sysText);
    // 历史只发送 content，reasoning 不计入
    const historyRows = compressionEnabled ? retainedContext(msgs, contextPlan) : msgs;
    const hist = historyRows.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    // 引用块会随本轮一起发出去，得算进去（一段 1200 字上限 ≈ 1.2k tokens），否则用量条会低估
    const refTokens = refs.reduce((n, c) => n + estimateTokens(c.text) + 12, 0);
    const cur = estimateTokens(input) + shots.length * 1200 + refTokens; // 每张图约 1.2k tokens
    return { system: sys, history: hist, current: cur };
  }, [msgs, input, shots, refs, videoName, isMaterial, materialKind, materialFormat, contextPlan, compressionEnabled, agentInstructions]);
  const ctxEst = ctxBreakdown.system + ctxBreakdown.history + ctxBreakdown.current;
  const contextCompression = useContextCompression({
    sessionId: activeId, tokens: ctxEst, windowTokens: ctxWin, query: input,
    busy: loading || !indexReady || activeId !== loadedSessionId,
  });
  const ratio = ctxEst / ctxWin;
  // 用量告警分三档（>90% 危险 / >70% 注意），色走 MD3 语义令牌
  const ctxLevel: '' | 'warn' | 'bad' = ratio > 0.9 ? 'bad' : ratio > 0.7 ? 'warn' : '';
  return { ctxEst, ctxWin, ctxBreakdown, contextCompression, ctxLevel };
}
