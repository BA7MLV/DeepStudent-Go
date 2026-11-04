import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readWidgetAnswerFeedback } from '../apps/web/src/harness/widgetProtocol.ts';
import { buildWidgetDocument, WIDGET_MSG } from '../apps/web/src/harness/widgetRuntime.ts';
import { quizAnswerFeedback } from '../apps/web/src/harness/quizFeedback.ts';

const base = { version: 1, requestId: 'host-submission', status: 'correct', answer: 0,
  correctAnswer: 0, explanation: '参考解释', grading: 'host', authoritative: true, timestamp: 1 };
assert.deepEqual(readWidgetAnswerFeedback(base), base);
for (const patch of [{ version: 2 }, { requestId: '' }, { timestamp: -1 }, { timestamp: Infinity },
  { grading: 'ai' }, { authoritative: false }, { answer: undefined }, { answer: NaN }, { extra: true },
  { explanation: 'x'.repeat(16001) }, { answer: '图'.repeat(12000) }]) {
  assert.equal(readWidgetAnswerFeedback({ ...base, ...patch }), null, JSON.stringify(patch).slice(0, 80));
}
const cycle = []; cycle.push(cycle);
assert.equal(readWidgetAnswerFeedback({ ...base, answer: cycle }), null);
const q = { stem: '选 A', options: ['A', 'B'], answer: 0, explanation: '因为 A' };
assert.equal(quizAnswerFeedback(q, -1), null);
assert.equal(quizAnswerFeedback(q, 0).status, 'correct');
assert.equal(quizAnswerFeedback(q, 1).status, 'incorrect');
assert.equal(quizAnswerFeedback({ ...q, answerSource: 'ai' }, 0).status, 'pending');
assert.equal(quizAnswerFeedback({ ...q, type: 'freeform', answer: '参考' }, { answer: '我的答案', selfGrade: true }).authoritative, false);
assert.deepEqual(quizAnswerFeedback(q, 1), quizAnswerFeedback(q, JSON.parse('1')), 'restored picks reconstruct identical feedback');

const doc = await buildWidgetDocument({ html: '<p>legacy</p>' }, { instance: 'test', answerFeedback: base });
const handlers = new Map(), events = [];
const parent = { postMessage() {} };
const context = { parent, TextEncoder, setTimeout, clearTimeout, requestAnimationFrame: () => 1,
  ResizeObserver: class { observe() {} }, MutationObserver: class { observe() {} },
  CustomEvent: class { constructor(type, init) { this.type = type; this.detail = init?.detail; } },
  document: { body: null, documentElement: { classList: { toggle() {} }, setAttribute() {}, style: { setProperty() {} } }, addEventListener() {} },
  window: { addEventListener(type, fn) { handlers.set(type, fn); }, dispatchEvent(e) { events.push(e); } }, navigator: {} };
vm.runInNewContext(doc.match(/<script>([\s\S]*?)<\/script>/)[1], context);
const api = context.window.__wbw;
assert.equal(api.answerFeedback.status, 'correct');
const emit = (value, source = parent, instance = 'test', isTrusted = true) => handlers.get('message')({ isTrusted, source, data: { instance, __wbw: WIDGET_MSG.answerFeedback, payload: value } });
const snapshot = api.answerFeedback; snapshot.status = 'incorrect';
assert.equal(api.answerFeedback.status, 'correct', 'getter returns a copy');
emit(base); emit({ ...base, timestamp: 0 }); emit({ ...base, requestId: 'stale' });
emit({ ...base, timestamp: 2, status: 'incorrect' }, {});
emit({ ...base, timestamp: 2, status: 'incorrect' }, parent, 'old');
emit({ ...base, timestamp: 2, grading: 'ai' });
emit({ ...base, status: 'incorrect' }); // conflicting duplicate timestamp
emit({ ...base, timestamp: 2, status: 'incorrect' }, parent, 'test', false);
assert.equal(events.filter(e => e.type === 'wbw:feedbackchange').length, 0);
emit({ ...base, timestamp: 2, status: 'partial' });
assert.equal(api.answerFeedback.status, 'partial');
assert.equal(events.filter(e => e.type === 'wbw:feedbackchange').length, 1);
console.log('PASS: feedback bounds/types/authority, host grading/restoration, runtime initialization, read-only API, deduplication, stale/foreign/invalid envelopes and partial updates');
