// Browser workers cannot publish products any more. Exercise the current server
// product/receipt boundary, real browser commands and explicit legacy recovery.
import { spawnSync } from 'node:child_process';
const root = new URL('..', import.meta.url);
for (const file of ['test-plugin-learning.mjs', 'e2e-single-source-of-truth.mjs', 'e2e-history-recovery-demand.mjs']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${file}`], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
