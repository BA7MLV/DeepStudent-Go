import type { ExecutorInteraction } from '@wangke/contracts/client-runtime';
import { db } from '../store/db';
import { cloud } from './state';
import { executorRuntime } from './executor-runtime';

/** Durable inbox, not a second executor. Only an unstarted delivery may invoke
 * the callback. An interrupted 'applying' delivery is preserved as uncertain;
 * neither reconnect nor a new task capability may execute it again. */
export async function followExecutorInteractions(port: {
  ready(command: ExecutorInteraction, signal: AbortSignal): Promise<void>;
  apply(command: ExecutorInteraction): Promise<void>;
  failed(error: unknown): void;
  applied?(command: ExecutorInteraction): void;
}) {
  const database = db, taskId = cloud.taskId, token = cloud.workerToken;
  const runtime = await executorRuntime();
  const current = () => database === db && taskId === cloud.taskId && token === cloud.workerToken;
  return runtime.followInteractions(async (frame, signal) => {
    for (const command of frame.commands) {
      if (!current()) throw new Error('executor_capability_changed');
      signal.throwIfAborted();
      const key = `executor-interaction:${taskId}:${command.sequence}`;
      let stored = (await database.table('_cloudMeta').get(key))?.value;
      if (stored && (command.attempt ?? 0) > (stored.command.attempt ?? 0)) stored = undefined;
      if (stored && JSON.stringify(stored.command) !== JSON.stringify(command)) throw new Error('executor_interaction_identity_changed');
      if (!stored) {
        stored = { command, phase: 'received', taskId };
        await database.table('_cloudMeta').put({ id: key, value: stored });
      }
      if (stored.phase === 'applying' || stored.phase === 'uncertain') throw new Error('executor_interaction_requires_reconciliation');
      if (stored.phase === 'received') {
        await port.ready(command, signal);
        if (!current()) throw new Error('executor_capability_changed');
        signal.throwIfAborted();
        stored = { ...stored, phase: 'applying' };
        await database.table('_cloudMeta').put({ id: key, value: stored });
        let begun;
        // Unary response loss may retry this SQL-only admission, not the domain
        // callback. A new realm sees 'applying' and never repeats that callback.
        try { begun = await retryReceipt(() => runtime.deliverInteraction({ sequence: command.sequence, phase: 'begin' })); }
        catch (error) {
          // Even a lost begin response cannot authorize another invocation.
          await database.table('_cloudMeta').put({ id: key, value: { ...stored, phase: 'uncertain', error: String(error) } });
          throw error;
        }
        if (begun.phase !== 'started') throw new Error('executor_interaction_requires_reconciliation');
        if (!current()) throw new Error('executor_capability_changed');
        // This is intentionally not retried: loss before dispatch is reconciled
        // from the server phase, never guessed from a local flag.
        await runtime.deliverInteraction({ sequence: command.sequence, phase: 'executing' });
        // Once admitted, carrier loss does not cancel this domain callback.
        try { await port.apply(command); }
        catch (error) {
          await database.table('_cloudMeta').put({ id: key, value: { ...stored, phase: 'uncertain', error: String(error) } });
          await runtime.deliverInteraction({ sequence: command.sequence, phase: 'uncertain' }).catch(() => {});
          throw error;
        }
        stored = { ...stored, phase: 'applied' };
        await database.table('_cloudMeta').put({ id: key, value: stored });
      }
      if (!current()) throw new Error('executor_capability_changed');
      const receipt = await retryReceipt(() => runtime.deliverInteraction({ sequence: command.sequence, phase: 'applied' }));
      if (receipt.phase !== 'applied') throw new Error('executor_interaction_receipt_mismatch');
      await database.table('_cloudMeta').put({ id: key, value: { ...stored, receipt } });
      port.applied?.(command);
    }
  }, port.failed);
}

async function retryReceipt<T>(send: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await send(); }
    catch (error) {
      const code = (error as { code?: string }).code;
      if (attempt >= 2 || code?.startsWith('client/') || code === 'gateway/bad-request') throw error;
    }
  }
}
