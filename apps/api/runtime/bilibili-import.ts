import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fetchPlayStreams } from '@wangke/study-core/bilibili/api';
import { resolveBiliTarget } from '@wangke/study-core/bilibili/target';
import { pageLabel, pageVideoTitle } from '@wangke/study-core/bilibili/pages';
import { biliVideoSource } from '@wangke/study-core/bilibili/source';
import { fetchBiliSubtitleList, fetchSubtitleCues } from '@wangke/study-core/bilibili/dmview';
import { buildBundle, pickPrimary, cuesToSegments, type SubtitleBundle } from '@wangke/study-core/bilibili/subtitle';
import { biliNetwork, biliMediaResponse } from '../src/bilibili/network.js';
import { biliCookie } from '../src/bilibili/credentials.js';
import { parseBiliImport } from '../src/bilibili/input.js';
import { commitTask, newRecordId, recordMutation, type TaskContext } from '../src/cloud/execution.js';
import { submitOwnerTask } from '../src/cloud/task-commands.js';
import { ProjectRepository } from '../src/projects/repository.js';
import { ResourceFiles } from '../src/projects/resources.js';
import { journaledResourceCommand } from '../src/realtime/resource-workflows.js';

/** Local descriptor inputs only. No URL, cookie, user argument or shell reaches
 * FFmpeg. MP4 is streamed to disk with an output cap, not accumulated in RAM. */
async function remux(context: TaskContext, video: string, audio: string | null, output: string, limit: number, signal: AbortSignal) {
  const fds = [fs.openSync(video, 'r'), ...(audio ? [fs.openSync(audio, 'r')] : [])];
  const fdPath = (n: number) => `${process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd'}/${n}`;
  const args = ['-nostdin', '-v', 'error', '-max_alloc', '134217728', '-threads', '1', '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-i', fdPath(3),
    ...(audio ? ['-protocol_whitelist', 'file,pipe', '-format_whitelist', 'mov', '-i', fdPath(4)] : []),
    '-map', '0:v:0', ...(audio ? ['-map', '1:a:0'] : []), '-c', 'copy', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1'];
  const binary = process.platform === 'linux' ? 'prlimit' : 'ffmpeg';
  const prefix = process.platform === 'linux' ? ['--as=1073741824', '--cpu=120', '--nofile=64', '--', 'ffmpeg'] : [];
  let child: ReturnType<typeof spawn> | undefined;
  const stop = () => { try { if (child?.pid) process.kill(-child.pid, 'SIGKILL'); } catch { child?.kill('SIGKILL'); } };
  const timer = setTimeout(stop, 120000);
  signal.addEventListener('abort', stop, { once: true });
  try {
    signal.throwIfAborted(); context.checkActive();
    child = spawn(binary, [...prefix, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe', ...fds], env: { PATH: process.env.PATH, LANG: 'C.UTF-8', HOME: '/nonexistent' } });
    const finished = new Promise<void>((resolve, reject) => {
      child!.on('error', reject);
      child!.on('close', code => code === 0 ? resolve() : reject(new Error('服务器视频合并失败或超时。')));
    });
    child.stderr!.resume();
    let size = 0;
    const writing = pipeline(child.stdout!, new Transform({ transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(size > limit ? new Error('视频合并后超过服务器单文件大小限制。') : null, chunk);
    } }), fs.createWriteStream(output, { flags: 'wx', mode: 0o600 }), { signal }).catch(error => { stop(); throw error; });
    await Promise.all([writing, finished]);
    signal.throwIfAborted(); context.checkActive();
    if (!size) throw new Error('服务器生成了空视频。');
  } finally { clearTimeout(timer); signal.removeEventListener('abort', stop); stop(); fds.forEach(fd => fs.closeSync(fd)); }
}

export async function serverBilibiliImport(context: TaskContext) {
  const input = parseBiliImport(context.task.input);
  const request = biliNetwork(context.fetch, biliCookie(context.store, context.configuration, context.owner), context.signal);
  context.report({ phase: 'resolve', done: 0, total: input.pages.length, message: '服务器正在解析 B 站视频…' });
  const target = await resolveBiliTarget({ request }, input.bvid);
  const selected = input.pages.map(wanted => target.pages.find(p => (p.bvid ?? target.bvid) === wanted.bvid && p.cid === wanted.cid));
  if (selected.some(p => !p)) throw new Error('视频分 P 或合集已变化，请重新解析后导入。');
  const resources = new ResourceFiles(new ProjectRepository(context.store, path.join(context.filesDir, 'projects')), context.filesDir);
  resources.migrate(context.owner);
  const destination = resources.videoImportDestination(context.owner, input.folderId);
  const configured = Number(process.env.MAX_FILE_BYTES ?? 512 * 1024 * 1024);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.min(512 * 1024 * 1024, Math.floor(configured))) : 512 * 1024 * 1024;
  const staging = path.join(context.filesDir, '.bilibili-imports');
  await fsp.mkdir(staging, { recursive: true, mode: 0o700 });
  const work = await fsp.mkdtemp(path.join(staging, `${context.task.id}-`));
  const imported: { courseId: string; name: string; page: number }[] = [];
  const warnings: string[] = [];
  try {
    for (const [index, page] of selected.entries()) {
      context.checkActive();
      const info = page!, label = `${pageLabel(info)} · ${index + 1}/${selected.length}`;
      const report = (phase: string, message: string, bytes?: number) => context.report({ phase, message, done: index, total: selected.length, ...(bytes === undefined ? {} : { bytes }), imported, warnings });
      report('download', `服务器下载 ${label}`);
      const streams = await fetchPlayStreams({ request }, info.bvid ?? target.bvid, info.cid);
      const video = path.join(work, 'video.m4s'), audio = streams.audioUrl ? path.join(work, 'audio.m4s') : null, output = path.join(work, 'output.mp4');
      const signal = AbortSignal.any([context.signal, AbortSignal.timeout(30 * 60 * 1000)]);
      let bytes = 0, lastReport = 0;
      const download = async (url: string, filename: string) => {
        const response = await biliMediaResponse(context.fetch, url, signal);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > limit - bytes) { await response.body?.cancel(); throw new Error('视频超过服务器单文件大小限制。'); }
        let received = 0;
        await pipeline(Readable.fromWeb(response.body as any), new Transform({ transform(chunk, _encoding, callback) {
          received += chunk.length; bytes += chunk.length;
          if (bytes > limit) { callback(new Error('视频超过服务器单文件大小限制。')); return; }
          try {
            context.checkActive();
            if (Date.now() - lastReport > 500) { lastReport = Date.now(); report('download', `服务器下载 ${label}（${(bytes / 1048576).toFixed(1)} MiB）`, bytes); }
            callback(null, chunk);
          } catch (error) { callback(error as Error); }
        } }), fs.createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal });
        if (!received || declared && received !== declared) throw new Error('B 站视频下载不完整。');
      };
      await download(streams.videoUrl, video);
      if (audio) await download(streams.audioUrl!, audio);
      report('merge', `服务器合并音视频 ${label}`);
      await remux(context, video, audio, output, limit, signal);
      let bundle: SubtitleBundle = { primary: null, tracks: [] };
      const source = biliVideoSource(target, info);
      if (input.langs.length) {
        report('subtitle', `服务器获取自带字幕 ${label}`);
        try {
          const items = (await fetchBiliSubtitleList(request, source.aid, source.cid)).filter(item => input.langs.includes(item.lan));
          const fetched: Parameters<typeof buildBundle>[0] = [];
          for (const item of items) {
            try { fetched.push({ item, cues: await fetchSubtitleCues(request, item.url) }); }
            catch { context.checkActive(); warnings.push(`${label}：${item.lanDoc} 字幕获取失败。`); }
          }
          bundle = buildBundle(fetched.filter(f => f.cues.length), pickPrimary(fetched.filter(f => f.cues.length).map(f => f.item)));
        } catch { context.checkActive(); warnings.push(`${label}：自带字幕不可用，将安排服务器转写。`); }
      }
      context.checkActive();
      const currentDestination = resources.videoImportDestination(context.owner, input.folderId);
      if (JSON.stringify(currentDestination) !== JSON.stringify(destination)) throw new Error('目标文件夹已移动，请核对已导入的视频后重新提交。');
      const operationId = `bili-${context.task.id}-${info.cid}`;
      const title = pageVideoTitle(target.title, target.pages, info.page);
      const size = fs.statSync(output).size;
      const command = { operationId, operation: { kind: 'upload' as const, projectId: destination.projectId, path: `${destination.directory ? `${destination.directory}/` : ''}${info.cid}.mp4`, size, sha256: '', contentType: 'video/mp4' } };
      // File journal and course/subtitle/follow-up tasks commit together. On a
      // crash, preserve the existing uncertain receipt instead of downloading twice.
      const receipt = journaledResourceCommand(resources, context.owner, command, operationId, '', () => {
        context.checkActive();
        const entry = resources.importServerVideo(context.owner, input.folderId, title, output), id = entry.courseId!;
        const course = context.records.get(context.owner, 'videos', id)!;
        commitTask(context, [recordMutation('videos', id, course, { ...course, duration: streams.duration || info.duration, biliSource: source, status: bundle.primary ? 'transcribed' : 'new', coverState: 'pending' }),
          ...cuesToSegments(bundle.primary?.cues ?? []).map(segment => { const key = newRecordId(); return recordMutation('segments', key, null, { ...segment, id: key, videoId: id }); }),
          ...bundle.tracks.map(track => { const key = newRecordId(); return recordMutation('subtitleTracks', key, null, { ...track, id: key, videoId: id }); }),
        ]);
        for (const kind of ['cover', ...(!bundle.primary ? ['transcribe'] : [])] as const) {
          try { submitOwnerTask(context.store, context.records, context.configuration, context.owner, { operationId: `${operationId}-${kind}`, kind: kind as 'cover' | 'transcribe', resource: `course:${id}`, input: { videoId: id, ...(kind === 'transcribe' && !input.langs.length ? { skipBiliSubtitles: true } : {}) } }); }
          catch { warnings.push(`${label}：${kind === 'cover' ? '封面' : '转写'}任务未能提交，可在课程中重试。`); }
        }
        return { courseId: id, name: entry.name, page: info.page };
      }) as { courseId: string; name: string; page: number };
      imported.push(receipt);
      context.report({ phase: 'saved', done: index + 1, total: selected.length, message: `已保存 ${label}`, imported, warnings });
      for (const filename of [video, audio, output]) if (filename) await fsp.rm(filename, { force: true });
    }
    return { imported, warnings };
  } finally { await fsp.rm(work, { recursive: true, force: true }); }
}
