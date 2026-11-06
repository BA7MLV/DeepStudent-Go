import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { workspaceQuotaBytes, directoryBytes } from '../infra/sandbox/quota.mjs';
import { seccompArgs, seccompProfile, sandboxArgs } from '../infra/sandbox/arguments.mjs';

assert.equal(workspaceQuotaBytes(undefined), 2 * 1024 ** 3);
assert.equal(workspaceQuotaBytes(''), 2 * 1024 ** 3);
assert.equal(workspaceQuotaBytes('512m'), 512 * 1024 ** 2);
assert.equal(workspaceQuotaBytes('10g'), 10 * 1024 ** 3);
assert.equal(workspaceQuotaBytes('1GiB'), 1024 ** 3);
assert.throws(() => workspaceQuotaBytes('abc'), /invalid_workspace_quota/);
assert.throws(() => workspaceQuotaBytes('-1g'), /invalid_workspace_quota/);

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wangke-quota-'));
fs.writeFileSync(path.join(root, 'a.txt'), 'x'.repeat(100));
fs.mkdirSync(path.join(root, 'sub'));
fs.writeFileSync(path.join(root, 'sub', 'b.bin'), 'y'.repeat(250));
fs.symlinkSync(path.join(root, 'a.txt'), path.join(root, 'link'));
assert.equal(directoryBytes(root), 350);
fs.rmSync(root, { recursive: true, force: true });

assert.ok(seccompProfile().endsWith('seccomp.json'));
assert.ok(fs.existsSync(seccompProfile()), 'profile ships next to the broker');
const profile = JSON.parse(fs.readFileSync(seccompProfile(), 'utf8'));
assert.equal(profile.defaultAction, 'SCMP_ACT_ERRNO');
const allowed = new Set(profile.syscalls.filter(e => e.action === 'SCMP_ACT_ALLOW').flatMap(e => e.names));
for (const blocked of ['bpf', 'perf_event_open', 'ptrace', 'process_vm_readv', 'userfaultfd', 'unshare', 'mount', 'reboot', 'kexec_load'])
  assert.ok(!allowed.has(blocked), `${blocked} must stay deny-by-default`);
assert.ok(allowed.has('execve') && allowed.has('clone') && allowed.has('openat'), 'ordinary userland must keep working');

const base = { owner: '00000000-0000-0000-0000-000000000001', threadId: '00000000-0000-0000-0000-000000000002', executionId: '00000000-0000-0000-0000-000000000003', command: 'true' };
const args = sandboxArgs(base, undefined, undefined);
const security = args.filter((value, index) => args[index - 1] === '--security-opt');
assert.deepEqual(security, [`seccomp=${seccompProfile()}`]);
assert.ok(args.includes('--security-opt=no-new-privileges:true'));
assert.ok(args.includes('--cap-drop=ALL'));

process.env.SANDBOX_SECCOMP_PROFILE = 'none';
assert.deepEqual(seccompArgs(), []);
delete process.env.SANDBOX_SECCOMP_PROFILE;
assert.equal(seccompProfile().endsWith('seccomp.json'), true);

console.info('sandbox quota + seccomp args ok');
