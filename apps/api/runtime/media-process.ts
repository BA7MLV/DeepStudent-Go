import { spawn } from 'node:child_process';
import type { TaskContext } from '../src/cloud/execution.js';

/** All arguments are server-authored. Input is an inherited, owned descriptor,
 * never a task path/URL. No shell, network protocols or playlist demuxers. */
export function mediaProcess(context: TaskContext, binary: string, args: string[], fd: number, maxBytes = 16 * 1024 * 1024, timeout = 120000): Promise<Buffer> {
  context.checkActive();
  return new Promise((resolve, reject) => {
    const command = process.platform === 'linux' ? 'prlimit' : binary;
    // V8 reserves a large virtual address cage: RLIMIT_AS breaks startup even
    // with a small heap. Node workers instead receive an explicit heap cap.
    const limits = process.platform === 'linux' ? [...(binary === process.execPath ? [] : ['--as=1073741824']), '--cpu=120', '--nofile=64', '--', binary] : [];
    const child = spawn(command, [...limits, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe', fd], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: '/nonexistent' } });
    const chunks: Buffer[] = []; let size = 0, failure: Error | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      // Kill the whole owned process group, including a worker's decoder.
      try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const abort = () => stop(new DOMException('任务已取消', 'AbortError'));
    context.signal.addEventListener('abort', abort, { once: true });
    if (context.signal.aborted) abort();
    const timer = setTimeout(() => stop(new Error('media_process_timeout')), timeout);
    child.stdout!.on('data', (chunk: Buffer) => { size += chunk.length; if (size > maxBytes) stop(new Error('media_output_limit')); else chunks.push(chunk); });
    // Drain diagnostics without retaining untrusted filenames/content.
    child.stderr!.resume();
    child.on('error', error => { failure = error; });
    child.on('close', code => { clearTimeout(timer); context.signal.removeEventListener('abort', abort); if (failure || code !== 0) reject(failure ?? new Error(`${binary}_failed`)); else { try { context.checkActive(); resolve(Buffer.concat(chunks)); } catch (error) { reject(error); } } });
  });
}
export const inheritedInput = `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/3`;
export const formats = 'mov,matroska,webm,avi,wav,mp3,flac,ogg,aac,mpeg,mpegts';
export const ffmpegInputArgs = ['-nostdin', '-v', 'error', '-max_alloc', '134217728', '-threads', '1', '-filter_threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', formats];
export function ffmpeg(context: TaskContext, fd: number, output: string[], maxBytes?: number) {
  return mediaProcess(context, 'ffmpeg', [...ffmpegInputArgs, '-i', inheritedInput, ...output], fd, maxBytes);
}
export function pdfPage(context: TaskContext, fd: number, page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 2000) throw new Error('invalid_pdf_page');
  return mediaProcess(context, 'pdftoppm', ['-f', String(page), '-l', String(page), '-scale-to', '1280', '-singlefile', '-jpeg', inheritedInput], fd, 4 * 1024 * 1024);
}
