import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { sandboxArgs, commandTimeoutSeconds, seccompProfile, uuid } from './arguments.mjs';
import { workspacePath, workspaceFileLimit } from './file-read.mjs';
import { OutputPreview, outputLimitBytes } from './output.mjs';
import { removeContainer } from './cleanup.mjs';
import { directoryBytes, volumeBytes, workspaceQuotaBytes } from './quota.mjs';
export { sandboxArgs } from './arguments.mjs';

const token = process.env.SANDBOX_TOKEN;
if (!token || token.length < 32) throw new Error('SANDBOX_TOKEN must contain at least 32 characters');
const sandboxImage = process.env.SANDBOX_IMAGE || 'wangke-sandbox:0.1.0';
const quotaBytes = workspaceQuotaBytes();
const run = promisify(execFile);
// Fail fast instead of surfacing sandbox_start_failed on every command.
{
  const profile = seccompProfile();
  if (profile !== 'none' && !fs.existsSync(profile)) throw new Error(`seccomp_profile_missing:${profile}`);
  const { stdout } = await run('docker', ['image', 'inspect', '--format', '{{.Id}}', sandboxImage], { timeout: 10_000 });
  const imageId = stdout.trim();
  if (process.env.SANDBOX_IMAGE_ID && process.env.SANDBOX_IMAGE_ID !== imageId) throw new Error(`sandbox_image_mismatch:${imageId}`);
  console.info(JSON.stringify({ event: 'sandbox.image', image: sandboxImage, id: imageId, quotaBytes }));
}
async function workspaceBytes(body) {
  if (body.projectId) return directoryBytes(path.join(process.env.SANDBOX_PROJECTS_DIR, body.projectId));
  return volumeBytes(`wangke-workspace-${body.threadId}`, sandboxImage);
}
const active = new Map();
const executions = new Map();
const cancelled = new Map();
const removals = new Map();
const remove = name => {
  if (!removals.has(name)) removals.set(name, removeContainer(name).finally(() => removals.delete(name)));
  return removals.get(name);
};

let hostRoot;
async function projectsHostRoot() {
  const root = process.env.SANDBOX_PROJECTS_DIR;
  if (!root || !path.isAbsolute(root)) throw new Error('project_mount_not_configured');
  if (!hostRoot) {
    if (process.env.SANDBOX_PROJECTS_HOST_DIR) hostRoot = process.env.SANDBOX_PROJECTS_HOST_DIR;
    else if (fs.existsSync('/.dockerenv')) {
      // Compose may use a relative host path. Docker reports the canonical
      // daemon-side source, so never interpret it relative to the broker CWD.
      const { stdout } = await promisify(execFile)('docker', ['inspect', '--format', '{{json .Mounts}}', process.env.HOSTNAME], { timeout: 10000 });
      const mount = JSON.parse(stdout).filter(m => m.Type === 'bind' && (root === m.Destination || root.startsWith(`${m.Destination}/`))).sort((a, b) => b.Destination.length - a.Destination.length)[0];
      if (!mount) throw new Error('project_mount_not_configured');
      hostRoot = path.join(mount.Source, path.relative(mount.Destination, root));
    } else hostRoot = fs.realpathSync(root);
  }
  return hostRoot;
}
async function projectRoot(id) {
  const root = process.env.SANDBOX_PROJECTS_DIR;
  const target = path.join(root, id);
  if (!fs.lstatSync(target).isDirectory() || fs.realpathSync(target) !== path.join(fs.realpathSync(root), id)) throw new Error('invalid_project_directory');
  return projectsHostRoot();
}
async function systemFilesRoot() {
  const projects = await projectsHostRoot();
  return path.join(path.dirname(projects), 'system-files');
}

const server = http.createServer(async (req, res) => {
  const reply = (status, body) => { if (!res.destroyed) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } };
  if (req.url === '/health' && req.method === 'GET') return reply(200, { ok: true });
  const supplied = Buffer.from(req.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return reply(401, { error: 'unauthorized' });
  if (!['/execute', '/cancel', '/files/read'].includes(req.url) || req.method !== 'POST') return reply(404, { error: 'not_found' });
  const readingFile = req.url === '/files/read';
  let body;
  try {
    let bytes = 0; const chunks = [];
    for await (const chunk of req) { bytes += chunk.length; if (bytes > 32_768) throw new Error(); chunks.push(chunk); }
    body = JSON.parse(Buffer.concat(chunks).toString());
    if (!body || !uuid.test(body.executionId)) throw new Error();
    if (req.url !== '/cancel' && (!uuid.test(body.threadId) || (body.projectId !== undefined && !uuid.test(body.projectId)))) throw new Error();
    if ((body.systemWrite !== undefined && typeof body.systemWrite !== 'boolean') || (readingFile && body.systemWrite === true)) throw new Error();
    if (readingFile) body = { threadId: body.threadId, projectId: body.projectId, executionId: body.executionId, filePath: workspacePath(body.path) };
    else if (req.url === '/execute') {
      if (!uuid.test(body.owner) || (body.network !== undefined && typeof body.network !== 'boolean') || typeof body.command !== 'string' || !body.command.trim() || body.command.length > 16_000 || body.filePath !== undefined) throw new Error();
      body.timeoutSeconds = commandTimeoutSeconds(body.timeoutSeconds);
    }
  } catch { return reply(400, { error: 'invalid_request' }); }
  for (const [id, expires] of cancelled) if (expires < Date.now()) cancelled.delete(id);
  if (req.url === '/cancel') {
    // Tombstone first, including execute requests still waiting in the network.
    cancelled.set(body.executionId, Date.now() + 300_000);
    const execution = executions.get(body.executionId);
    if (execution) { execution.cancelled = true; execution.stop?.(); await execution.done; }
    try { await remove(`wangke-exec-${body.executionId}`); execution?.finish(); return reply(200, { cancelled: true }); }
    catch { return reply(503, { error: 'sandbox_cleanup_pending' }); }
  }
  if (cancelled.has(body.executionId)) return reply(409, { error: 'execution_cancelled' });
  const scope = body.projectId ? `project:${body.projectId}` : `thread:${body.threadId}`;
  if (active.has(scope) || executions.has(body.executionId) || active.size >= 8) return reply(409, { error: 'sandbox_busy' });
  if (!readingFile && body.projectId !== undefined && !fs.existsSync(path.join(process.env.SANDBOX_PROJECTS_DIR, body.projectId))) return reply(400, { error: 'invalid_project_workspace' });
  if (!readingFile) {
    // Quota is enforced before admission: an over-quota workspace blocks new
    // commands until the user clears it, so a runaway script cannot wedge the
    // host disk. Reads stay available for inspection and recovery.
    let used;
    try { used = await workspaceBytes(body); } catch { return reply(503, { error: 'sandbox_unavailable' }); }
    if (used > quotaBytes) {
      console.info(JSON.stringify({ event: 'sandbox.quota_exceeded', executionId: body.executionId, scope, used, quotaBytes }));
      return reply(409, { error: 'sandbox_workspace_quota_exceeded' });
    }
  }
  const name = `wangke-exec-${body.executionId}`;
  let resolveDone;
  const execution = { name, cancelled: false, stop: null, done: new Promise(resolve => { resolveDone = resolve; }) };
  const finish = () => {
    if (active.get(scope) === execution) active.delete(scope);
    if (executions.get(body.executionId) === execution) executions.delete(body.executionId);
    resolveDone();
  };
  execution.finish = finish;
  active.set(scope, execution); executions.set(body.executionId, execution);
  let args;
  try { args = sandboxArgs(body, body.projectId ? await projectRoot(body.projectId) : undefined, readingFile ? undefined : await systemFilesRoot()); }
  catch { finish(); return reply(400, { error: 'invalid_project_workspace' }); }
  if (res.destroyed || execution.cancelled) { finish(); return reply(409, { error: 'execution_cancelled' }); }
  const streaming = !readingFile && req.headers.accept === 'application/x-ndjson';
  const stdout = new OutputPreview(), stderr = new OutputPreview();
  let size = 0; let timer; let terminationReason; let spawnError = false; let backpressure = false;
  const send = value => { if (!res.destroyed) return res.write(`${JSON.stringify(value)}\n`); return false; };
  if (streaming) res.writeHead(200, { 'content-type': 'application/x-ndjson', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
  const fileChunks = []; let fileBytes = 0; let fileOverflow = false;
  const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let removing;
  const stop = reason => {
    terminationReason ??= reason;
    removing ??= remove(name).catch(() => {}).finally(() => { child.kill('SIGKILL'); child.stdout.resume(); child.stderr.resume(); });
  };
  execution.stop = () => stop('cancelled');
  const disconnected = () => { if (!res.writableEnded) stop('cancelled'); };
  res.on('close', disconnected);
  res.on('error', disconnected);
  timer = setTimeout(() => stop('command_timeout'), (readingFile ? 120 : body.timeoutSeconds) * 1000 + 10_000);
  const collect = (kind, chunk) => {
    if (readingFile && kind === 'stdout') {
      fileBytes += chunk.length;
      if (fileBytes > workspaceFileLimit) { fileOverflow = true; stop('output_limit_exceeded'); return; }
      fileChunks.push(chunk); return;
    }
    const remaining = Math.max(0, outputLimitBytes - size);
    size += chunk.length;
    const accepted = chunk.subarray(0, remaining);
    (kind === 'stdout' ? stdout : stderr).push(accepted);
    if (streaming && accepted.length && !res.destroyed) {
      if (!send({ type: kind, data: accepted.toString('base64') }) && !backpressure) {
        backpressure = true;
        child.stdout.pause(); child.stderr.pause();
        res.once('drain', () => { backpressure = false; child.stdout.resume(); child.stderr.resume(); });
      }
    }
    if (size > outputLimitBytes) stop('output_limit_exceeded');
  };
  child.stdout.on('data', (chunk) => collect('stdout', chunk));
  child.stderr.on('data', (chunk) => collect('stderr', chunk));
  child.on('error', () => { spawnError = true; });
  child.on('close', async (code) => {
    clearTimeout(timer);
    try {
      await removing;
      await remove(name);
      finish();
      if (readingFile) {
        if (code === 4 || fileOverflow) return reply(413, { error: 'workspace_file_too_large_or_empty' });
        if (code === 2) return reply(404, { error: 'workspace_file_not_found' });
        if (code !== 0 || !fileBytes) return reply(400, { error: 'workspace_file_unavailable' });
        if (!res.destroyed) { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': fileBytes }); res.end(Buffer.concat(fileChunks)); }
      } else {
        const out = stdout.result(), err = stderr.result();
        const result = { stdout: out.text, stderr: err.text, exitCode: code ?? 137,
          output: { stdoutBytes: out.bytes, stderrBytes: err.bytes, stdoutTruncated: out.truncated, stderrTruncated: err.truncated, complete: size <= outputLimitBytes, limitBytes: outputLimitBytes },
          ...(terminationReason ? { terminationReason } : {}), ...(spawnError ? { error: 'sandbox_start_failed' } : {}) };
        console.info(JSON.stringify({ event: 'sandbox.finished', executionId: body.executionId, exitCode: result.exitCode, ...result.output, terminationReason }));
        if (streaming) { send({ type: 'result', ...result }); res.end(); }
        else reply(spawnError ? 503 : 200, result);
      }
    } catch {
      // Keep both broker scope and API project lease blocked until Docker has
      // actually confirmed removal. A failed cleanup must never unlock them.
      resolveDone();
      console.error(JSON.stringify({ event: 'sandbox.cleanup_pending', executionId: body.executionId, terminationReason }));
      const retry = () => { const retryTimer = setTimeout(() => remove(name).then(finish, retry), 1000); retryTimer.unref(); };
      retry();
      if (streaming) { send({ type: 'error', error: 'sandbox_cleanup_pending', terminationReason }); res.end(); }
      else reply(503, { error: 'sandbox_cleanup_pending', terminationReason });
    }
  });
});
server.listen(Number(process.env.PORT ?? 3001), process.env.HOST || '0.0.0.0');
process.on('SIGTERM', async () => {
  server.close();
  await Promise.all([...active.values()].map(async execution => { execution.cancelled = true; execution.stop?.(); await execution.done; }));
  process.exit(0);
});
