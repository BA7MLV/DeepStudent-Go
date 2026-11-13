import type { ClientLearningEdit } from '@wangke/contracts/client-runtime';
import type { CloudMutation } from '@wangke/contracts/cloud';
import { CloudRecords } from '../cloud/records.js';
import { cardReviewMutation } from '../learning/card-review.js';
import { clearStudyTimeMutations } from '../learning/clear-study-time.js';

const schemas = {
  conversationMessage: ['chats', 'id taskId videoId sessionId role content createdAt modelTrace modelRequests explicitSkillIds images attachments reasoning reasoningMs tools responseSegments quiz ask folderPlan resume interrupted interruptReason widget widgets legacyHtmlWorks widgetState widgetStates'],
  conversationSession: ['chatSessions', 'id videoId title createdAt contextCourseIds courseReferenceEnabled webSearchEnabled projectFolderId skillIds pinnedSkillIds mcpServerIds pinned archived promptCacheKey contextCheckpoint contextOmissions defaultModel'],
  skillDefinition: ['skills', 'id name description body enabled builtin updatedAt mcpRequired'],
  skillReference: ['skillRefs', 'id skillId path body'],
  materialAnnotation: ['materialInk', 'id materialId surface tool color width height points createdAt renderer nib opacity smoothing input anchor rects'],
  handoutDocument: ['handouts', 'id videoId createdAt title blob outlineJson sectionsJson usedSkills readPos'],
} as const;

/** Supported client edits are conversation documents, explicit skill packages,
 * annotations, card decisions, reading position and additive study time. No
 * resource identity, derived products or server task authority is writable. */
export function clientLearningMutations(records: CloudRecords, owner: string, edits: ClientLearningEdit[]): CloudMutation[] {
  if (edits.some(edit => edit.kind === 'clearStudyTime' || edit.kind === 'clearStudySnapshot') && edits.length !== 1) throw new Error('study_clear_must_be_separate');
  // Validate dependent documents against prior edits in the same original
  // transaction (e.g. a newly created session followed by its first message).
  // This is only a validation view; CloudRecords applies everything atomically.
  const pending = new Map<string, Record<string, any> | null>();
  const identity = (table: string, key: string | number) => JSON.stringify([table, key]);
  const get = (owner: string, table: string, key: string | number) => pending.has(identity(table, key)) ? pending.get(identity(table, key))! : records.get(owner, table, key);
  const compile = (edit: ClientLearningEdit): CloudMutation | CloudMutation[] => {
    if (!edit.mutationId || edit.mutationId.length > 200) throw new Error('invalid_learning_operation');
    const mutation = (table: string, key: string | number, before: any, after: any): CloudMutation => ({ id: edit.mutationId, table, key, before, after, baseRevision: edit.baseRevision });
    const course = (id: string) => {
      const row = get(owner, 'videos', id);
      if (!row || row.fileDeleted) throw new Error('learning_course_denied');
    };
    if (edit.kind === 'studyTime') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(edit.date) || !Number.isFinite(edit.seconds) || edit.seconds < 0 || edit.seconds > 86400 || !Number.isFinite(edit.updatedAt)) throw new Error('invalid_study_delta');
      // CloudRecords' additive create semantics are idempotent by mutation ID.
      return mutation('studyDays', edit.date, null, { date: edit.date, seconds: edit.seconds, updatedAt: edit.updatedAt });
    }
    if (edit.kind === 'clearStudyTime') return clearStudyTimeMutations(records, owner, edit);
    // The domain verifies the signed aggregate baseline inside its transaction.
    // Retain the existing complete-set validation and mutation/receipt semantics.
    if (edit.kind === 'clearStudySnapshot') return clearStudyTimeMutations(records, owner, {
      kind: 'clearStudyTime', mutationId: edit.mutationId, expected: records.studyDays(owner) as { date: string; seconds: number; updatedAt: number }[],
    });
    if (edit.kind === 'reviewCard') {
      return cardReviewMutation({ get }, owner, edit);
    }
    if (edit.kind === 'handoutReading') {
      const current = get(owner, 'handouts', edit.handoutId);
      course(edit.courseId);
      if (!current || current.videoId !== edit.courseId || !edit.position || edit.position.anchor.length > 200 || !Number.isFinite(edit.position.offset)) throw new Error('learning_handout_denied');
      return mutation('handouts', edit.handoutId, current, { ...current, readPos: edit.position });
    }
    const [table, fields] = schemas[edit.kind];
    const row = (edit.value ?? edit.expected) as unknown as Record<string, any>;
    if (!row) throw new Error('invalid_learning_document');
    const key = row.id;
    const current = get(owner, table, key);
    for (const value of [edit.expected, edit.value, current]) {
      if (!value) continue;
      const item = value as unknown as Record<string, any>;
      if (item.id !== key || Object.keys(item).some(field => !fields.split(' ').includes(field))) throw new Error('invalid_learning_schema');
      if (table === 'materialInk') course(item.materialId);
      if (table === 'handouts') {
        course(item.videoId);
        if (!current || item.videoId !== current.videoId || !item.blob || !records.ownedFile(owner, item.blob.$file)) throw new Error('learning_handout_denied');
      }
      if (table === 'chats') {
        const session = get(owner, 'chatSessions', item.sessionId);
        if (!session || session.videoId !== item.videoId) throw new Error('learning_session_denied');
        if (item.taskId && item.taskId !== current?.taskId) throw new Error('task_authority_not_client_writable');
      }
      if (table === 'skillRefs' && !get(owner, 'skills', item.skillId)) throw new Error('learning_skill_denied');
    }
    return mutation(table, key, edit.expected, edit.value);
  };
  return edits.flatMap(edit => {
    const compiled = compile(edit);
    const mutations = Array.isArray(compiled) ? compiled : [compiled];
    for (const mutation of mutations) pending.set(identity(mutation.table, mutation.key), mutation.after);
    return mutations;
  });
}
