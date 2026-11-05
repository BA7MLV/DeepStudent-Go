import { useJobStore } from '../store/jobs';
import { assertPluginAvailable } from '../plugins/availability';
import { runMaterialPluginTask } from '../plugins/legacy-actions';
import type { MaterialFormat } from '../materials/parse';

const running = new Set<string>();
export function isMaterialJobRunning(id: string): boolean { return running.has(id); }
export interface MaterialJobResult { parsed: number; scanned: boolean; empty: boolean }

export async function startMaterialJob(materialId: string, _format: MaterialFormat): Promise<MaterialJobResult> {
  await assertPluginAvailable('material-tools');
  running.add(materialId);
  try {
    return await runMaterialPluginTask('material', materialId, p => useJobStore.getState().upsert(materialId, p));
  } finally { running.delete(materialId); }
}
