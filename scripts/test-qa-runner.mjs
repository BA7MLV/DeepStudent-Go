#!/usr/bin/env node
/** Compatibility entry: the browser QA executor and local model-history
 * checkpoints are retired, not mocked back into existence for this test.
 *
 * Retired coverage mapping (each target executes and failures propagate):
 * - Pair identity, tool receipts in the next request, saved-before-display,
 *   multiple works, provider errors/partial answers, stop, restart, late/deleted
 *   snapshots, video/material QA -> test-server-widgets + e2e-server-widgets.
 * - QA exact retained history, complete tool envelopes, image/continuation
 *   protection and persisted omission plans -> compression-consumption.
 * - Explicit conservative selector/baseline CAS -> context-compression.
 * - Skill activation/history -> server-skill-activation.
 * - Actual runQa sink/Panel, modelSelection, raw image/citation/default CAS ->
 *   e2e-server-chat-ui.
 * Old local usage/checkpoint writes, local round callbacks, present_quiz browser
 * delivery and the browser-only empty-answer/no-row rule are intentionally
 * retired: durable task progress/results and server plugin products are the
 * authority. Provider failure/empty-prefix behavior is checked in server widgets,
 * not by expecting obsolete browser callback/storage side effects.
 */
import { execFileSync } from 'node:child_process';

for (const script of [
  'test-server-widgets.mjs',
  'test-server-context-compression-consumption.mjs',
  'test-server-context-compression.mjs',
  'test-server-skill-activation.mjs',
  'e2e-server-chat-ui.mjs',
  'e2e-server-widgets.mjs',
]) {
  console.log(`QA coverage delegated to ${script}`);
  execFileSync(process.execPath, ['--import', 'tsx', new URL(script, import.meta.url).pathname], { stdio: 'inherit' });
}
console.log('PASS retired QA entry: production server execution/history and real browser result-chain coverage.');
