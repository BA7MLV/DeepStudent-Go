import { isDeepStrictEqual } from 'node:util';
import type { LearningProductCommand, ExecutorArtifactChange } from '@wangke/contracts/client-runtime';
import { CloudConflict, CloudRecords } from '../cloud/records.js';

const definitions = {
  transcriptSegment: ['segments', 'transcribe', 'id videoId idx start end text status cues'],
  subtitleTrack: ['subtitleTracks', 'transcribe', 'id videoId lang lanDoc primary cues'],
  materialBlock: ['materialBlocks', 'material', 'id materialId idx unit unitLabel text kind'],
  slideFrame: ['frames', 'handout', 'id videoId ts blob kind caption'],
  // runHandout explicitly rebuilds its cover from the newly produced slides.
  // It shares only these closed cover products, never a generic write permit.
  courseCover: ['covers', 'cover handout', 'videoId blob w h ts source createdAt'],
  handoutDocument: ['handouts', 'handout handoutEdit', 'id videoId createdAt title blob outlineJson sectionsJson usedSkills readPos'],
  candidateCard: ['cards', 'cards', 'id videoId q a time status createdAt'],
  courseComment: ['comments', 'comments', 'id videoId time author role text parentId createdAt'],
  courseDanmaku: ['danmakus', 'danmaku', 'id videoId time text'],
  conversationMessage: ['chats', 'chat qa', 'id taskId videoId sessionId role content createdAt modelTrace modelRequests explicitSkillIds images attachments reasoning reasoningMs tools responseSegments quiz ask folderPlan resume interrupted interruptReason widget widgets legacyHtmlWorks widgetState widgetStates'],
  conversationSession: ['chatSessions', 'chat qa', 'id videoId title createdAt contextCourseIds projectFolderId skillIds pinnedSkillIds mcpServerIds pinned archived promptCacheKey contextCheckpoint contextOmissions'],
} as const;
const states: Record<string, string[]> = { transcribe: ['status', 'transcriptionPaused'], material: ['unitCount', 'scanned', 'empty'], cover: ['coverState', 'dominantColor'], handout: ['coverState', 'dominantColor'] };

/** The executor can only publish this task's declared products. A consumed tool
 * permit is NOT an escape hatch. File/organization tools use separate domains. */
export function taskProductMutations(records: CloudRecords, owner: string, task: { kind: string; input: string; id: string }, products: LearningProductCommand[], continuation?: { id: number; taskId?: string }): ExecutorArtifactChange[] {
  const input = JSON.parse(task.input);
  const sessions = new Map<number, Record<string, any> | null>();
  const fileReferences = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    if ('$file' in value && (typeof value.$file !== 'string' || !records.ownedFile(owner, value.$file))) throw new Error('artifact_file_denied');
    for (const child of Object.values(value)) fileReferences(child);
  };
  return products.map(product => {
    const id = product.mutationId;
    if (!id || id.length > 200) throw new Error('invalid_artifact_identity');
    if (product.kind === 'courseDerivation') {
      if (!input.videoId || product.courseId !== input.videoId) throw new Error('artifact_resource_denied');
      const fields = [...new Set([...Object.keys(product.expected), ...Object.keys(product.value)])];
      if (fields.some(field => !states[task.kind]?.includes(field))) throw new Error('artifact_state_denied');
      const current = records.get(owner, 'videos', product.courseId);
      if (!current || current.fileDeleted) throw new Error('artifact_resource_denied');
      const after = { ...current };
      for (const field of fields) {
        if (!isDeepStrictEqual(current[field], product.expected[field as keyof typeof product.expected]) && !isDeepStrictEqual(current[field], product.value[field as keyof typeof product.value])) throw new CloudConflict('videos', product.courseId, [field]);
        if (Object.hasOwn(product.value, field)) after[field] = product.value[field as keyof typeof product.value];
        else delete after[field];
      }
      return { id, table: 'videos', key: product.courseId, before: current, after, baseRevision: product.baseRevision };
    }
    const definition = definitions[product.kind];
    if (!definition || !definition[1].split(' ').includes(task.kind)) throw new Error('artifact_kind_denied');
    const [table, , fields] = definition;
    const keyField = table === 'covers' ? 'videoId' : 'id';
    const row = product.value ?? product.expected;
    if (!row) throw new Error('invalid_artifact_product');
    const key = (row as unknown as Record<string, any>)[keyField];
    const current = records.get(owner, table, key);
    for (const value of [product.expected, product.value, current]) {
      if (!value) continue;
      const item = value as unknown as Record<string, any>;
      if (Object.keys(item).some(field => !fields.split(' ').includes(field)) || item[keyField] !== key) throw new Error('artifact_schema_denied');
      if (table === 'chats' || table === 'chatSessions') {
        if (!input.sessionId || (table === 'chats' ? item.sessionId : item.id) !== input.sessionId) throw new Error('artifact_session_denied');
        const session = sessions.has(input.sessionId) ? sessions.get(input.sessionId) : records.get(owner, 'chatSessions', input.sessionId);
        if (table === 'chats' && (!session || item.videoId !== session.videoId)) throw new Error('artifact_session_denied');
        if (table === 'chats' && item.taskId && item.taskId !== task.id && !(continuation && continuation.id === item.id && continuation.taskId === item.taskId)) throw new Error('artifact_task_denied');
      } else {
        const course = input.videoId && records.get(owner, 'videos', input.videoId);
        if (!course || course.fileDeleted || (item.videoId ?? item.materialId) !== input.videoId) throw new Error('artifact_resource_denied');
      }
      fileReferences(item);
    }
    if (table === 'chatSessions') sessions.set(key, product.value as Record<string, any> | null);
    return { id, table, key, before: product.expected as any, after: product.value as any, baseRevision: product.baseRevision, permissionId: product.permissionId };
  });
}
