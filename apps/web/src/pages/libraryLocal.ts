/**
 * 本地写入流程的「按需加载边界」。
 *
 * Library.tsx 里最近的文件读取（ResourceLibrary）已经负责了服务端目录；这个模块只在
 * 走旧本地数据库（课程表刷新、拖拽改文件夹、导入前的格式探测）时才被动态加载。
 * 它把那些按需模块集中一处，避免它们在资料库页面顶部被静态引入：
 *
 * - `probeDuration`：背后是 mediabunny（MKV/FLV 全靠它读时长），
 * - `detectMaterialFormat` / `isMaterialFile`：背后连带 docx/html 解析器与 DOMPurify，
 * - `startMaterialJob` / `startTranscription` / `cancelTranscription`：任务管线，
 * - `submitCloudTask`：云端任务提交。
 */
import { db, type FolderRow, type VideoRow } from '../store/db';

export type { FolderRow, VideoRow };

/** 列表读取：本地模式一次读回视频与文件夹 */
export function readVideoLibrary(): Promise<[VideoRow[], FolderRow[]]> {
  return Promise.all([
    db.videos.orderBy('createdAt').reverse().toArray(),
    db.folders.orderBy('createdAt').toArray(),
  ]);
}

/** 迁移旧版错题本材料：旧库里有 wrongbook.md 时才补一份资料 */
export async function ensureWrongbookMaterialIfPresent(): Promise<void> {
  const file = await db.files.get('wrongbook.md');
  if (!file) return;
  const { ensureWrongbookMaterial } = await import('../store/wrongbook');
  await ensureWrongbookMaterial();
}

const materialFiles = import('../materials/parse');

/** 可导入的文件 = 视频 或 阅读材料；会自动把材料解析器一起加载进来 */
export async function isMaterialFileNow(file: File): Promise<boolean> {
  return (await materialFiles).isMaterialFile(file);
}

export async function detectMaterialFormatNow(file: File): Promise<'pdf' | 'docx' | 'md' | 'html'> {
  return (await materialFiles).detectMaterialFormat(file);
}

export async function isLegacyDocFileNow(file: File): Promise<boolean> {
  return (await materialFiles).isLegacyDocFile(file);
}

/** 视频时长探测（mediabunny 只在这里被拉起） */
export async function probeDurationNow(file: Blob): Promise<number> {
  const { probeDuration } = await import('../utils/mediaDuration');
  return probeDuration(file);
}

export async function startMaterialJobNow(id: string, format: 'pdf' | 'docx' | 'md' | 'html') {
  const { startMaterialJob } = await import('../pipelines/materialJob');
  return startMaterialJob(id, format);
}

export function startTranscriptionNow(id: string): void {
  void import('../pipelines/transcribeQueue').then(({ startTranscription }) => startTranscription(id));
}

export function cancelTranscriptionNow(id: string): void {
  void import('../pipelines/transcribeQueue').then(({ cancelTranscription }) => cancelTranscription(id));
}

/** B 站整集转写走云端任务：不依赖本地转写队列，但在导入路径上才需要 */
export async function submitCloudTranscriptionNow(courseId: string): Promise<void> {
  const { submitCloudTask } = await import('../cloud/tasks');
  await submitCloudTask('transcribe', `course:${courseId}`, { videoId: courseId, skipBiliSubtitles: true });
}

export async function saveImportedSubtitlesNow(videoId: string, subtitles: Parameters<typeof import('../store/subtitles').saveImportedSubtitles>[1]): Promise<void> {
  const { saveImportedSubtitles } = await import('../store/subtitles');
  await saveImportedSubtitles(videoId, subtitles);
}
