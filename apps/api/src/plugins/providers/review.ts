import { REVIEW_PLUGIN } from '@wangke/contracts/learning-plugins';
import { materialResolver } from '../learning.js';
import { registerReviewPresentation } from '../practice.js';
import type { PluginService } from '../service.js';
import { CloudRecords } from '../../cloud/records.js';
import { learningCards } from '../learning-results.js';
import { readLearningMarkdown } from '../learning-files.js';
import { parseWrongbook } from '@wangke/study-core/wrongbook';

export const reviewProvider = {
  package: REVIEW_PLUGIN,
  setup(service: PluginService) {
    const { store } = service, records = new CloudRecords(store), resolveMaterial = materialResolver(service);
    registerReviewPresentation(service, resolveMaterial);
    service.register({ id: 'review.list', capability: 'learning', access: 'read', schema: { type: 'object', properties: { materialId: { type: 'string', minLength: 1, maxLength: 256 } }, required: [], additionalProperties: false }, run: (a, c) => {
      const id = resolveMaterial(a, c), cards = learningCards(store, c.owner, id);
      const notebook = records.get(c.owner, 'videos', 'wrongbook.md');
      const source = notebook ? readLearningMarkdown(store, service.learningOptions.filesDir, c.owner, 'wrongbook.md', service.learningOptions.resources) : undefined;
      const questions = source ? parseWrongbook(source.text).filter(q => q.source.courseId === id) : [];
      const now = Date.now();
      return { materialId: id, asOf: now, notebookRevision: source?.revision ?? null, cards: { total: cards.length, pending: cards.filter(q => q.status === 0).length, kept: cards.filter(q => q.status === 1).length },
        questions: questions.map(q => ({ id: q.id, stem: q.question.stem, source: q.source, status: q.status, due: q.card.due, dueNow: q.status !== 'mastered' && Date.parse(q.card.due) <= now, attempts: q.attempts.length, lastAttemptAt: q.attempts.at(-1)?.at ?? null })),
        due: questions.filter(q => q.status !== 'mastered' && Date.parse(q.card.due) <= now).length,
        completed: questions.filter(q => q.status === 'mastered').length, notebookMaterialId: notebook ? 'wrongbook.md' : null };
    } });
  },
};
