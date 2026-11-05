import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { ClientLearningEdit } from '@wangke/contracts/client-runtime';
import type { CloudMutation } from '@wangke/contracts/cloud';
import { CloudConflict, type CloudRecords } from '../cloud/records.js';

/** Must run inside the command receipt transaction: the complete set comparison
 * rejects newly added dates as well as edits, before any deletion is committed. */
export function clearStudyTimeMutations(records: Pick<CloudRecords, 'studyDays'>, owner: string,
  input: Extract<ClientLearningEdit, { kind: 'clearStudyTime' }>): CloudMutation[] {
  if (!Array.isArray(input.expected) || input.expected.length > 20000) throw new Error('invalid_study_snapshot');
  const dates = new Set<string>();
  for (const row of input.expected) {
    if (!row || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)
      || !Number.isFinite(row.seconds) || row.seconds < 0 || !Number.isFinite(row.updatedAt)
      || Object.keys(row).some(key => !['date', 'seconds', 'updatedAt'].includes(key)) || dates.has(row.date)) {
      throw new Error('invalid_study_snapshot');
    }
    dates.add(row.date);
  }
  const current = records.studyDays(owner);
  const expected = [...input.expected].sort((a, b) => a.date.localeCompare(b.date));
  current.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  if (!isDeepStrictEqual(current, expected)) throw new CloudConflict('studyDays', '*', ['snapshot']);
  return expected.map(row => ({
    id: createHash('sha256').update(JSON.stringify(['clearStudyTime', input.mutationId, row.date])).digest('hex'),
    table: 'studyDays', key: row.date, before: row, after: null,
  }));
}
