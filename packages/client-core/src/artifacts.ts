import type { ClientLearningEdit, RuntimeRecordMutation } from '@wangke/contracts/client-runtime';

export function clientLearningEdits(changes: RuntimeRecordMutation[]): ClientLearningEdit[] {
  return changes.map(change => {
    const identity = { mutationId: change.id, ...(change.baseRevision === undefined ? {} : { baseRevision: change.baseRevision }) };
    const names = { chats: 'conversationMessage', chatSessions: 'conversationSession', skills: 'skillDefinition', skillRefs: 'skillReference', materialInk: 'materialAnnotation' } as const;
    const kind = names[change.table as keyof typeof names];
    if (kind) return { ...identity, kind, expected: change.before, value: change.after } as ClientLearningEdit;
    const changed = [...new Set([...Object.keys(change.before ?? {}), ...Object.keys(change.after ?? {})])].filter(field => JSON.stringify(change.before?.[field]) !== JSON.stringify(change.after?.[field]));
    if (change.table === 'studyDays' && change.after && changed.every(field => ['date', 'seconds', 'updatedAt'].includes(field))) return { ...identity, kind: 'studyTime', date: String(change.key), seconds: Number(change.after.seconds) - Number(change.before?.seconds ?? 0), updatedAt: Number(change.after.updatedAt) };
    if (change.table === 'cards' && change.before && change.after && changed.every(field => field === 'status')) return { ...identity, kind: 'reviewCard', courseId: change.after.videoId, cardId: change.key, expected: change.before.status, status: change.after.status } as ClientLearningEdit;
    if (change.table === 'handouts' && change.before && change.after && changed.every(field => field === 'readPos')) return { ...identity, kind: 'handoutReading', courseId: change.after.videoId, handoutId: change.key, position: change.after.readPos } as ClientLearningEdit;
    if (change.table === 'handouts' && change.before && change.after) return { ...identity, kind: 'handoutDocument', expected: change.before, value: change.after } as unknown as ClientLearningEdit;
    throw new Error('domain_command_required');
  });
}
