import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';

const units = { k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 };

/** Workspace disk quota in bytes. Accepts 2, 2k, 512m, 2g, 1t (optionally 2GiB). */
export function workspaceQuotaBytes(value = process.env.SANDBOX_WORKSPACE_QUOTA) {
  if (value === undefined || value === '') return 2 * 1024 ** 3;
  const match = /^(\d+)([kmgt]?)i?b?$/i.exec(String(value).trim());
  if (!match) throw new Error('invalid_workspace_quota');
  return Number(match[1]) * (units[match[2].toLowerCase()] ?? 1);
}

/** Project workspaces are plain bind mounts the broker can measure directly. */
export function directoryBytes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}/${entry.name}`;
      if (entry.isDirectory()) stack.push(p);
      else if (entry.isFile()) total += fs.lstatSync(p).size;
    }
  }
  return total;
}

/** Thread workspaces are named volumes; only a container can see inside them. */
export async function volumeBytes(volume, image, run = promisify(execFile)) {
  if (!/^[\w.-]+$/.test(volume)) throw new Error('invalid_volume_name');
  const { stdout } = await run('docker', ['run', '--rm', '--network', 'none', '--cap-drop', 'ALL',
    '--mount', `type=volume,source=${volume},target=/ws`, '--entrypoint', 'du', image, '-sb', '/ws'], { timeout: 30_000 });
  return Number((/^(\d+)/.exec(stdout) || [0, 0])[1]);
}
