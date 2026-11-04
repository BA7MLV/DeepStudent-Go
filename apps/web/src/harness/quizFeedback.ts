import { canGradeQuizQuestion, gradeQuizAnswer, isQuizAnswered, quizPickAnswer, quizExplanation, type QuizQuestion, type QuizPick } from './quiz';
import { widgetRevision } from './widgetReading';
import { readWidgetAnswerFeedback, type WidgetAnswerFeedback } from './widgetProtocol';

/** Reconstructed from persisted host picks, never from generated HTML or AI prose. */
export function quizAnswerFeedback(q: QuizQuestion, pick: QuizPick): WidgetAnswerFeedback | null {
  if (!isQuizAnswered(pick)) return null;
  const answer = quizPickAnswer(pick);
  const result = canGradeQuizQuestion(q) ? gradeQuizAnswer(q, answer) : undefined;
  return readWidgetAnswerFeedback({ version: 1, requestId: `quiz:${widgetRevision(JSON.stringify([q.stem, q.type, q.options, q.source, answer]))}`,
    status: result === undefined ? 'pending' : result ? 'correct' : 'incorrect', answer,
    ...(q.answer != null ? { correctAnswer: q.answer } : {}),
    explanation: result === undefined ? `待核验；参考内容不计分。${quizExplanation(q)}` : quizExplanation(q),
    grading: result === undefined && q.answerSource === 'ai' ? 'ai' : 'host', authoritative: result !== undefined,
    // Existing picks have no submission time. Zero is explicitly an unknown historical time.
    timestamp: 0 });
}
