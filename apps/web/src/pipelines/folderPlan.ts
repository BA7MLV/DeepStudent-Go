import { create } from 'zustand';
import type { FolderPlan } from '../harness/folderPlan';

export const useLibraryRevision = create<{ revision: number; bump: () => void }>()(set => ({
  revision: 0, bump: () => set(s => ({ revision: s.revision + 1 })),
}));
export interface AppliedPlanResult {
  createdFolders: string[];
  moved: number;
  missing: string[];
  perFolder: { name: string; count: number }[];
}

/** The domain command owns authorization and the whole organization transaction. */
export async function applyFolderPlan(plan: FolderPlan): Promise<AppliedPlanResult> {
  const result = await (await import('../client/resources')).resourceCommand({ kind: 'organizeCourses', folders: plan.folders });
  await (await import('../cloud/sync')).flushCloud();
  useLibraryRevision.getState().bump();
  return result as unknown as AppliedPlanResult;
}

export function formatPlanForModel(plan: FolderPlan, applied: AppliedPlanResult | null): string {
  if (!applied) return plan.folders.map(e => `- ${e.name}：${e.courseIds.length} 门`)
    .concat([`共 ${plan.folders.length} 个分类、${plan.folders.reduce((n, e) => n + e.courseIds.length, 0)} 门课程`]).join('\n');
  const lines = applied.perFolder.map(p => `- ${p.name}：实际归入 ${p.count} 门`);
  if (applied.createdFolders.length) lines.push(`新建文件夹：${applied.createdFolders.join('、')}`);
  if (applied.missing.length) lines.push(`⚠️ 忽略了 ${applied.missing.length} 个资料库中不存在的 id：${applied.missing.join('、')}（不要再次使用它们）`);
  lines.push(`合计移动 ${applied.moved} 门课程。`);
  return lines.join('\n');
}
