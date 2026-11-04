import type { CloudTask } from '@wangke/contracts/cloud';
import { cloud } from './state';
import { executorRuntime, completeExecutor } from './executor-runtime';
import type { ExecutorCompletion, RuntimeJson } from '@wangke/contracts/client-runtime';
import { apiUrl } from '../api/base';

/** Dedicated authenticated browser worker. The API owns scheduling; this page only leases and runs browser tasks. */
export async function startBrowserWorker(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(apiUrl('/api/v1/cloud/worker/claim'), { method: 'POST', credentials: 'include' });
      if (response.status === 204) { await new Promise(r => setTimeout(r, 1000)); continue; }
      if (!response.ok) throw new Error(`worker_claim_${response.status}`);
      const claimed = await response.json() as { token: string; task: CloudTask };
      cloud.workerToken = claimed.token;
      cloud.taskId = claimed.task.id;
      try {
        const task = await (await executorRuntime()).read();
        let outcome: ExecutorCompletion['outcome'];
        try {
          const result = await window.__runCloudTask(task as CloudTask);
          outcome = { status: 'completed', result: JSON.parse(JSON.stringify(result ?? null)) as RuntimeJson };
        } catch (error) {
          outcome = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
        }
        // Completion transport errors are not execution failures. The persisted
        // terminal command must never be replaced with a contradictory outcome.
        await completeExecutor(outcome);
      } finally {
        cloud.workerToken = '';
        cloud.taskId = '';
      }
    } catch {
      cloud.workerToken = '';
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}
