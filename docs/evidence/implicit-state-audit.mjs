/** Read-only audit. Run from the repository root:
 * node --import tsx docs/evidence/implicit-state-audit.mjs > docs/evidence/implicit-state-audit.json
 * Success means these probes ran, NOT that the application is regression-free.
 * No servers, database connections, real providers, Docker or browser are used.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { chatTaskActive, chatTaskState } from '../../apps/web/src/store/chatTaskState.ts';
import { boardTaskTerminal } from '../../packages/contracts/src/board.ts';
import { createAccountLifecycle } from '../../apps/web/src/client/account-lifecycle.ts';
import { DurableCommands } from '../../packages/client-core/src/durable-commands.ts';
import { ModelCircuitBreaker } from '../../apps/api/src/agent/model-circuit-breaker.ts';
import { createDsmlRecoverer } from '../../packages/study-core/src/api/dsml.ts';
import { SileroTimeline } from '../../packages/study-core/src/media/vad.ts';

const root = path.resolve(import.meta.dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const roots = ['apps/web/src', 'apps/api/src', 'apps/api/runtime', 'apps/apple/WangkeKit/Sources', 'apps/ios',
  'packages/client-core/src', 'packages/contracts/src', 'packages/study-core/src', 'packages/remote-host/src', 'userscript', 'infra'];
const extensions = new Set(['.ts', '.tsx', '.swift', '.js', '.mjs', '.py', '.sh']);
function walk(directory) {
  if (!fs.existsSync(path.join(root, directory))) return [];
  return fs.readdirSync(path.join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const file = `${directory}/${entry.name}`;
    return entry.isDirectory() ? walk(file) : extensions.has(path.extname(file)) ? [file] : [];
  });
}
const supplemental = ['install.sh', 'apps/api/scripts/deployment-maintenance.mjs', 'apps/web/pwa-precache.ts',
  ...fs.readdirSync(path.join(root, 'scripts')).filter(name => /^release.*\.mjs$/.test(name)).map(name => `scripts/${name}`),
  ...fs.readdirSync(path.join(root, 'scripts/lib')).filter(name => /^release.*\.mjs$/.test(name)).map(name => `scripts/lib/${name}`)];
const rules = [
  ['state', /\b(?:state|status|phase|stage|mode)\b/],
  ['flags', /\b(?:loading|loaded|pending|busy|running|started|stopped|disposed|settled|closed|draining|speaking|redemption|passthrough|inBlock|inFence|inComment)\b/],
  ['lifetime', /AbortController|AbortSignal|generation|incarnation|lifetime|addEventListener|onTermination/],
  ['time-or-revision', /expires_at|used_at|revoked_at|approved_at|retryAt|nextAttemptAt|wake_at|baseRevision|cursor|epoch/],
];
const files = [...new Set([...roots.flatMap(walk), ...supplemental])].sort().map(file => {
  const source = read(file), lines = source.split('\n');
  const hits = lines.flatMap((line, index) => {
    const kinds = rules.filter(([, pattern]) => pattern.test(line)).map(([kind]) => kind);
    return kinds.length ? [{ line: index + 1, kinds }] : [];
  });
  return { path: file, sha256: crypto.createHash('sha256').update(source).digest('hex'), lines: lines.length, hits };
});

// Extract only literal lists from known source shapes. Do not execute app modules
// with startup effects. If their structure changes, fail rather than invent data.
function literalList(file, pattern) {
  const match = pattern.exec(read(file));
  assert.ok(match, `audit_source_shape_changed:${file}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]);
}
const serverActive = literalList('apps/api/src/cloud/tasks.ts', /const ACTIVE_TASK_STATUSES = new Set\(\[([^\]]+)\]/);
const resourceCancellable = literalList('apps/web/src/cloud/tasks.ts', /export async function cancelResourceTasks\([\s\S]*?\[([^\]]+)\]\.includes\(t.status\)/);
const activityActive = literalList('apps/web/src/cloud/activityStore.ts', /return ([^;]+);/);
const botStopVisible = literalList('apps/web/src/cloud/BotManagement.tsx', /\{\[([^\]]+)\]\.includes\(run.status\)/);
const statuses = ['queued', 'running', 'waiting_user', 'waiting_event', 'completed', 'failed', 'cancelled', 'interrupted'];
const matrix = statuses.map(status => ({ status,
  serverActive: serverActive.includes(status),
  chatActive: chatTaskActive({ status }),
  chatStreaming: chatTaskState({ content: '' }, { status, createdAt: '2026-11-10T00:00:00Z' }).streaming,
  activityActive: activityActive.includes(status),
  selectedForResourceCancel: resourceCancellable.includes(status),
  boardTerminal: boardTaskTerminal(status),
}));
const probes = [];
async function probe(name, check) {
  try { await check(); probes.push({ name, passed: true }); }
  catch (error) { probes.push({ name, passed: false, error: error.message }); }
}
let dsmlPartitionEvidence;
await probe('task predicate matrix evaluates all eight CloudTask statuses', () => {
  assert.equal(matrix.length, 8);
  assert.equal(boardTaskTerminal('waiting_event'), false);
  assert.equal(boardTaskTerminal('completed'), true);
});
await probe('account A -> B -> A never revives the first lifetime', async () => {
  const lifecycle = createAccountLifecycle();
  const first = lifecycle.acquire('A'); let releases = 0;
  first.own(() => { releases++; });
  lifecycle.acquire('B'); const second = lifecycle.acquire('A');
  assert.notEqual(first, second); assert.equal(first.current(), false); assert.equal(second.current(), true);
  assert.equal(first.signal.aborted, true); assert.equal(releases, 1);
  first.own(() => { releases++; }); assert.equal(releases, 2);
  lifecycle.invalidate(); await lifecycle.settled(); assert.equal(second.current(), false);
});
await probe('completed receipt acknowledges without resending', async () => {
  let sends = 0, acknowledged = 0;
  const journal = { list: async () => [{ operationId: 'op', request: {}, state: 'uncertain' }],
    save: async () => {}, remove: async () => {}, acknowledge: async () => { acknowledged++; } };
  const queue = new DurableCommands(journal, { receipt: async () => ({ status: 'completed', value: {} }),
    send: async () => { sends++; }, current: () => true, replaySafe: false });
  await queue.drain(); assert.equal(sends, 0); assert.equal(acknowledged, 1); queue.dispose();
});
await probe('uncertain non-idempotent operation is not automatically replayed', async () => {
  let sends = 0;
  const journal = { list: async () => [{ operationId: 'op', request: {}, state: 'uncertain' }], save: async () => {}, remove: async () => {} };
  const queue = new DurableCommands(journal, { receipt: async () => ({ status: 'missing' }),
    send: async () => { sends++; }, current: () => true, replaySafe: false });
  await assert.rejects(queue.drain(), /command_requires_reconciliation/); assert.equal(sends, 0); queue.dispose();
});
await probe('circuit cooldown admits only one concurrent half-open probe', () => {
  let now = 0; const circuit = new ModelCircuitBreaker(() => now, 10, 1000, 30, 1);
  circuit.failure('provider'); assert.equal(circuit.enter('provider'), false);
  now = 31; assert.equal(circuit.enter('provider'), true); assert.equal(circuit.enter('provider'), false);
  circuit.release('provider'); assert.equal(circuit.enter('provider'), true);
  circuit.success('provider'); assert.equal(circuit.enter('provider'), true);
});
await probe('DSML sample is invariant under every single split point', () => {
  const input = 'before <｜DSML｜tool_calls><｜DSML｜invoke name="read"><｜DSML｜parameter name="path" string="true">a.md</｜DSML｜parameter></｜DSML｜invoke></｜DSML｜tool_calls> after';
  const decode = chunks => {
    const parser = createDsmlRecoverer(), parts = [...chunks.flatMap(chunk => parser.push(chunk)), ...parser.flush()];
    const normalized = [];
    for (const part of parts) {
      if (part.kind === 'text' && normalized.at(-1)?.kind === 'text') normalized.at(-1).text += part.text;
      else if (part.kind !== 'text' || part.text) normalized.push({ ...part });
    }
    return normalized;
  };
  const baseline = decode([input]);
  assert.ok(baseline.some(part => part.kind === 'toolCall' && part.name === 'read'));
  const mismatchingSplits = [];
  let firstDifference;
  const calls = parts => parts.filter(part => part.kind === 'toolCall');
  for (let i = 0; i <= input.length; i++) {
    const actual = decode([input.slice(0, i), input.slice(i)]);
    assert.deepEqual(calls(actual), calls(baseline));
    if (JSON.stringify(actual) !== JSON.stringify(baseline)) {
      mismatchingSplits.push(i); firstDifference ??= { split: i, expected: baseline, actual };
    }
  }
  const characterChunks = decode([...input]);
  assert.deepEqual(calls(characterChunks), calls(baseline));
  dsmlPartitionEvidence = { input, mismatchingSplits, firstDifference, characterChunks,
    sampleToolCallsInvariant: true, textInvariant: mismatchingSplits.length === 0 && JSON.stringify(characterChunks) === JSON.stringify(baseline) };
  assert.ok(dsmlPartitionEvidence.textInvariant, 'DSML text differs across chunk boundaries; see dsmlPartitionEvidence');
});
await probe('VAD timeline preserves a minimal speech segment on finish', () => {
  const timeline = new SileroTimeline(); for (let i = 0; i < 8; i++) timeline.accept(1);
  const result = timeline.finish(); assert.equal(result.length, 1); assert.equal(result[0].start, 0); assert.ok(result[0].end > 0);
});

const catalog = read('docs/implicit-state-machines.md').split('\n').filter(line => /^\| M\d\d \|/.test(line)).map(line => {
  const [id, family, classification, ownerAndEvidence, transitions, recommendation, priority] = line.split('|').slice(1, -1).map(cell => cell.trim());
  const sources = [...ownerAndEvidence.matchAll(/`([^`]+)`/g)].map(match => match[1]);
  for (const file of sources) assert.ok(fs.existsSync(path.join(root, file.replace(/:\d+(?:-\d+)?$/, ''))), `missing_catalog_source:${file}`);
  assert.ok(id && family && classification && sources.length && transitions && recommendation && /^P[123]$/.test(priority), `invalid_catalog_row:${id}`);
  return { id, family, classification, ownerAndEvidence, sources, transitions, recommendation, priority };
});
assert.equal(new Set(catalog.map(item => item.id)).size, catalog.length);
assert.ok(catalog.length >= 50);
console.log(JSON.stringify({ format: 1, generatedAt: new Date().toISOString(),
  scope: { roots, supplemental, exclusions: ['dependencies', 'generated artifacts', 'build-only upstream protocol source', 'tests and fixtures (except these pure probes)', 'real databases and credentials'] },
  summary: { files: files.length, candidateFiles: files.filter(file => file.hits.length).length,
    clueLines: files.reduce((total, file) => total + file.hits.length, 0), families: catalog.length,
    probesPassed: probes.filter(probe => probe.passed).length, probesFailed: probes.filter(probe => !probe.passed).length },
  caveat: 'Keyword clues and workflow families are not an exhaustive count of independent state machines. Source-extracted predicates are not end-to-end executions.',
  taskPredicateMatrix: matrix, botStopVisibleStatuses: botStopVisible,
  findings: [{ id: 'F01', evidence: 'mixed: source-extracted server/cancel/activity plus executed pure chat selector',
    present: matrix.some(row => row.serverActive && !row.selectedForResourceCancel), status: 'waiting_event' },
  { id: 'F02', evidence: 'source-extracted BotManagement stop-button guard', present: !botStopVisible.includes('waiting_event'), status: 'waiting_event' },
  { id: 'F10', evidence: 'executed DSML parser across every single split point and character chunks', present: dsmlPartitionEvidence?.textInvariant === false }],
  probes, dsmlPartitionEvidence, catalog, files }, null, 2));
if (probes.some(probe => !probe.passed)) process.exitCode = 1;
