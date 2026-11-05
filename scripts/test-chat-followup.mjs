#!/usr/bin/env node
/** The old A–H fixture ran a browser Agent loop. That executor is retired.
 * Equivalent business assertions now exercise the production store + real queue
 * policy/IndexedDB, with a free server-command carrier (not a local model). The
 * real typed HTTP/admission/two-tab matrix remains e2e-session-queue.mjs. */
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { indexedDB, IDBKeyRange } from 'fake-indexeddb';

Object.assign(globalThis, { indexedDB, IDBKeyRange, window: new EventTarget() });
const values = new Map();
globalThis.localStorage = globalThis.sessionStorage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) };
window.localStorage = localStorage;
const dir = mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/server-chat-followup-');
const root = resolve('apps/web/src');
writeFileSync(join(dir, 'entry.ts'), `export { useCourseChat, reflectCloudTasks, flushChatQueue } from '${root}/store/courseChat'; export { db } from '${root}/store/db';`);
const submitted = [], commands = [], cancelled = [];
globalThis.chatFixture = {
  submitted, commands, cancelled,
  submit: async request => {
    const task = { id: 'task-' + request.operationId, kind: request.kind, input: request.input, status: 'running', createdAt: new Date().toISOString() };
    submitted.push({ request, task }); return task;
  },
};
await build({ entryPoints: [join(dir, 'entry.ts')], outfile: join(dir, 'bundle.mjs'), bundle: true, format: 'esm', platform: 'node', logLevel: 'silent', loader: { '.md': 'text' }, external: ['@widget/chart-runtime?raw'], define: { 'process.env.NODE_ENV': '"test"' }, plugins: [{
  name: 'server-command-fixture', setup(build) {
    build.onResolve({ filter: /chat-server-execution$/ }, () => ({ path: 'server-carrier', namespace: 'fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: `
      export const createServerChatExecution = () => ({ receipt: async id => { const match = globalThis.chatFixture.submitted.find(item => item.request.operationId === id); return match ? {status:'accepted',task:match.task} : {status:'missing'}; }, submit: globalThis.chatFixture.submit });
      export const commandServerChat = async (id, action, answer) => { globalThis.chatFixture.commands.push({id,action,answer}); return true; };
      export const stopServerChat = async id => { globalThis.chatFixture.cancelled.push(id); };
    `, loader: 'ts' }));
    build.onResolve({ filter: /cloud\/tasks$/ }, () => ({ path: 'task-progress', namespace: 'task-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'task-fixture' }, () => ({ contents: 'export const syncTaskWidgets = async () => true; export const runCloudTask = async () => { throw new Error("unexpected_task"); };', loader: 'ts' }));
    build.onResolve({ filter: /client\/session$/ }, () => ({ path: 'follow-session', namespace: 'session-fixture' }));
    build.onResolve({ filter: /(?:store\/|\.\/)chatHistory$/ }, () => ({ path: 'history', namespace: 'history-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'history-fixture' }, () => ({ contents: `import {db} from '${root}/store/db'; export const readChatHistory=async id=>db.chats.where('sessionId').equals(id).toArray(); export const readChatPage=async id=>({rows:await readChatHistory(id),hasOlder:false});`, loader:'ts',resolveDir:root }));
    build.onLoad({ filter: /.*/, namespace: 'session-fixture' }, () => ({ contents: 'export const followServerSession = () => () => {};', loader: 'ts' }));
    // Server command fixture applies the acknowledged projection only. This is
    // deliberately a test double, never a production fallback on failed IO.
    build.onResolve({ filter: /(?:client\/|\.\/)learning$/ }, () => ({ path: 'learning', namespace: 'learning-fixture' }));
    build.onLoad({ filter: /.*/, namespace: 'learning-fixture' }, () => ({ contents: `
      import { db } from '${root}/store/db';
      let id=10000; export const learningId=()=>++id; export const learningEdit=input=>input;
      export const submitLearning=async edits=>{ for(const edit of edits){ const table=edit.kind==='conversationSession'?db.chatSessions:db.chats; if(edit.value) await table.put(edit.value); else await table.delete(edit.expected.id); } };
      export const editMessage=async(expected,value)=>submitLearning([{kind:'conversationMessage',expected,value}]);
      export const editSession=async(expected,value)=>submitLearning([{kind:'conversationSession',expected,value}]);
      export const drainLearning=async()=>{};
      export const saveSkillPackage=async()=>{throw new Error('unexpected_skill_write');};
    `, loader: 'ts', resolveDir: root }));
  },
}] });
const { useCourseChat, reflectCloudTasks, flushChatQueue, db } = await import(pathToFileURL(join(dir, 'bundle.mjs')));
const state = () => useCourseChat.getState();
const wait = async predicate => { for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('fixture_timeout'); };
const session = id => ({ id, videoId: '__library_assistant__', title: `Session ${id}`, createdAt: id });
await db.chatSessions.bulkPut([session(1), session(2)]);
await state().bootstrap(); await state().loadSession(1);

// A: queue admission, draft consumption, no local authoritative history, drain.
useCourseChat.setState({ loading: true, draft: 'next question' });
await state().send('next question'); await flushChatQueue();
assert.equal(submitted.length, 0); assert.equal(state().draft, ''); assert.equal(state().queued.length, 1); assert.equal(await db.chats.count(), 0);
useCourseChat.setState({ loading: false });
await reflectCloudTasks([]); await wait(() => submitted.length === 1);
assert.equal(submitted[0].request.input.text, 'next question'); assert.equal(await db.chats.count(), 0);
console.log('PASS A server queue gates, drain, composer consumption and server-only history');

// B/C/D/G: steer carries mode and original identity, including busy/idle sends.
const first = submitted[0].task;
await reflectCloudTasks([{ ...first, progress: { content: 'partial original' } }]);
assert.ok(state().messages.some(item => item.content === 'partial original'));
await state().steer('new direction');
assert.equal(submitted.at(-1).request.input.mode, 'steer');
await state().steer('another direction');
assert.equal(submitted.at(-1).request.input.text, 'another direction');
assert.ok(state().messages.some(item => item.content === 'partial original'), 'server partial projection is not erased on steer submission');
useCourseChat.setState({ loading: false }); await state().steer('idle steer');
assert.equal(submitted.at(-1).request.input.mode, 'steer');
state().enqueue('send this now'); await flushChatQueue(); const queueId = state().queued.at(-1).id;
await state().sendQueuedNow(queueId);
assert.equal(submitted.at(-1).request.operationId, queueId); assert.equal(submitted.at(-1).request.input.mode, 'steer');
console.log('PASS B/C/D/G steer mode, partial visibility, rapid messages and queued original identity');

// E: pending question wins over both steer and queue, responding is a command.
const count = submitted.length;
useCourseChat.setState({ pendingAsk: { messageKey: 'question', resolve: () => { throw new Error('local promise must not run'); } }, loading: true, draft: 'answer' });
await state().send('answer', 'steer');
assert.equal(submitted.length, count); assert.deepEqual(commands.at(-1), { id: 1, action: 'answerAsk', answer: 'answer' });
await state().answerAsk('picked'); await state().confirmPlan(); await state().cancelPlan();
assert.deepEqual(commands.slice(-3).map(item => item.action), ['answerAsk', 'confirmPlan', 'cancelPlan']);
console.log('PASS E question priority and server-only interactive-card commands');

// F/H: switching parks each view/queue while background task progress stays owned.
useCourseChat.setState({ pendingAsk: null, loading: true });
state().enqueue('parked pending'); await flushChatQueue();
await state().loadSession(2); assert.equal(state().messages.length, 0);
await state().send('second conversation');
const second = submitted.at(-1).task;
assert.equal(second.input.sessionId, 2, 'second conversation dispatch targets its own ID');
await reflectCloudTasks([{ ...first, progress: { content: 'first background stream' } }, { ...second, progress: { content: 'second foreground stream' } }]);
assert.ok(state().messages.some(item => item.content === 'second foreground stream'));
assert.ok(!state().messages.some(item => item.content === 'first background stream'));
await state().loadSession(1);
assert.ok(state().messages.some(item => item.content === 'first background stream')); assert.ok(state().queued.some(item => item.text === 'parked pending'));
await state().loadSession(2); state().stop(); await wait(() => cancelled.length > 0); assert.equal(cancelled.at(-1), 2);
console.log('PASS F/H session-owned queues/progress and targeted server cancellation');

// Continuation retains the same assistant row and never creates a user question.
useCourseChat.setState({ loading: false, messages: [{ key: 'partial', rowId: 50, role: 'ai', content: 'prefix', interrupted: true }] });
await state().retryMessage('partial');
assert.equal(submitted.at(-1).request.input.action, 'continue'); assert.equal(submitted.at(-1).request.input.rowId, 50);
assert.equal(state().messages.filter(item => item.role === 'user').length, 0);
// Compression tasks are commands, not answer-producing chat runs.
await reflectCloudTasks([{ ...first, id: 'compression', input: { sessionId: 2, action: 'compressContext' }, progress: { content: 'must never appear' } }]);
assert.ok(!state().messages.some(item => item.content === 'must never appear'));
console.log('PASS server continuation identity and compression/answer projection separation');

// Invalidated account late acceptance must not resurrect the old view.
let release; const gate = new Promise(resolve => { release = resolve; });
const submit = chatFixture.submit; chatFixture.submit = async request => { await gate; return submit(request); };
// The captured carrier holds its submit function; create a fresh binding after disposal.
window.dispatchEvent(new Event('wangke:bot-session-ended'));
useCourseChat.setState({ activeId: 2, loaded: true, messages: [], loading: false });
const sending = state().send('late accepted');
await new Promise(resolve => setTimeout(resolve, 20));
window.dispatchEvent(new Event('wangke:bot-session-ended')); release(); await sending;
assert.deepEqual(state().messages, []); assert.equal(state().ready, false);
console.log('PASS invalidated account fences delayed server acceptance');
await db.delete();
