// The browser /systemone executor is retired. Keep the command as a real test
// entry for server selection, consumption, and rejection of browser model IO.
import { spawnSync } from 'node:child_process';
const root = new URL('..', import.meta.url);
for (const file of ['test-server-context-compression.mjs', 'test-server-context-compression-consumption.mjs', 'test-browser-model-transports.mjs']) {
  const result = spawnSync(process.execPath, ['--import', 'tsx', `scripts/${file}`], { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
