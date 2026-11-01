import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

// Docker --rm and explicit cancellation can race. "Removal in progress" is
// neither failure nor proof of completion: retry until absence is confirmed.
export async function removeContainer(name, { run = promisify(execFile), sleep = delay, now = Date.now, timeoutMs = 10_000 } = {}) {
  const deadline = now() + timeoutMs;
  do {
    try { await run('docker', ['rm', '-f', name], { timeout: Math.max(1, Math.min(3000, deadline - now())) }); return; }
    catch (error) {
      const stderr = String(error.stderr || '');
      if (/No such container/i.test(stderr)) return;
      if (!/removal .*already in progress|is being removed/i.test(stderr)) throw error;
    }
    await sleep(Math.min(200, Math.max(0, deadline - now())));
  } while (now() < deadline);
  throw new Error('sandbox_cleanup_pending');
}
