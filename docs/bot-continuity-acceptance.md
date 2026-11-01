# Bot continuity acceptance

Date: 2026-11-01

Baseline: `4c1e5e4b881c61e1c90764254e728148eb28982c`

Implementation: single BotRunner/main model path; no router, coordinator, spawn or review model.

## Delivered

- R1: migration 29 adds `run_inputs`, `run_questions`, and `run_waits`. Explicit run/question targets are owner/thread checked; nonce retries retain one message/run; terminal targets return a conflict instead of reviving. Follow-up source text and attachment references are atomically recorded, then consumed once into the replayable run context. Normal unreferenced messages retain the existing new-run behavior.
- R2: `study_task.wait(taskIds)` is limited to tasks owned by the current parent run. `waiting_event` releases the Bot active slot; the scheduler scans durable `cloud_tasks` terminal states and restores the original run once, including failed/cancelled/interrupted outcomes. Waiting admission remains attributed to the parent run and is included in the usage state allow-list.
- R3: foreground `study_task.create` jobs are completion dependencies: ordinary replies, `send_message(complete=true)`, and `finish_turn` are blocked before any visible message/message_event is written while a required child is unfinished. `question` and `approval` are interaction waits, not completion claims, so they remain visible and create separate precise identities even with foreground work pending. `background=true` is explicit for “started” delivery. During an async tool batch, new explicit run input is checked at each tool boundary and before final delivery; completed results are retained, queued stale calls receive interrupted results, inputs are consumed atomically, and the same run re-plans without stale message/event delivery. Thread details expose run/question identities; Web offers precise Answer and “Add to current task” actions (separate from approval), preserves the draft while clearing expired targets, and shows durable background waiting without hiding a real running task. Waiting runs remain stoppable and lifecycle state is refreshed through a compact state endpoint. Existing artifact/file ownership, existence, readability, supported-format checks, and gateway outbox status distinctions remain enforced by the service/tool paths.

## Commands and results

Passed:

```text
npm run test:bot
npm run test:bot:hardening
npm run test:tool-parallel
npm run test:memory-context
npm run test:tasks
npm run test:gateway
npm run test:gateway:chunking
npm run test:bot-ui
npm run build
npx tsc -p apps/api/tsconfig.json --noEmit
npx tsc -p apps/web/tsconfig.json --noEmit
npx tsx scripts/test-bot-r3-completion.mjs
npx tsx --test scripts/test-bot-parallel.mjs
npm run test:bot:r3:e2e
git diff --check -- apps/api/src/server.ts apps/api/src/agent/runner.ts apps/api/src/agent/study.ts apps/web/src/api/serverClient.ts apps/web/src/pages/BotWorkspace.tsx
```

`scripts/test-bot-r3-completion.mjs` uses isolated SQLite/mock runners and asserts the three premature exits, explicit background delivery, visible question/approval with separate waiting identities, and tool-time input replacement for `send_message`, `finish_turn`, and file delivery. The expanded external probe also passes with question/approval visible and zero unread inputs. `scripts/e2e-bot-r3.mjs` uses an isolated real API/Vite/Playwright stack; its first question is produced by the mock runner rather than directly inserted, and it passes question answer→original run, ordinary-question/approval separation, run supplement, expired-target draft preservation, waiting stop, desktop interaction and 390px mobile interaction. Final clean waiting screenshots: `test-results/bot-r3/desktop-waiting.png`, `test-results/bot-r3/mobile-waiting.png`; intentional failure evidence: `test-results/bot-r3/expired-target.png`.

The new `scripts/test-bot-continuity.mjs` passed: explicit target append, durable input receipt, nonce idempotency, and terminal fence.

### Follow-up independent probe (2026-11-01)

- Re-ran `./node_modules/.bin/tsx /private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/probe-bot-r3-completion.mts`: three completion markers remain invisible; question/approval are visible with one model request and `waiting_user`; tool-time input has no stale marker, two requests, zero unread inputs, and the original run queues its controlled wait.
- Formal R3 tests additionally verify that a real question answer resumes the original runner, an approval ID cannot be answered as a question or grant authorization, the revised requirement appears in the next model request, completed shell/read results survive, every stale call has one ordered tool result, no extra run is created, and unexecuted send/finish/file calls are marked interrupted. Two concurrently admitted reads are drained before the stale delivery is skipped. Outbox assertions check no stale payload; these isolated tests do not exercise live gateway transport.
- `scripts/test-bot-parallel.mjs`: seven tests passed, including out-of-order results, serial barriers, approval resumption, cancellation and crash-recovery partial results. The new follow-up wire assertions use OpenAI Chat; existing conversation regression retains three-protocol coverage, not a claim that this new race fixture independently ran all three wire protocols.
- Final browser evidence is captured only after the successful supplement request settles, a reload/state fetch displays normal background waiting, and the composer is enabled with no sending spinner. The intentionally expired target is saved separately. API/Web typechecks, build and `git diff --check` passed after these changes; build retains existing CSS/chunk warnings.

`npm run test:migration` is blocked by an existing script path mismatch: it generates imports for `/src/store/db` and `/src/store/migration`, which do not exist in this repository. The API migration fixtures inside `npm run test:bot:hardening` passed all fresh/v12/main/gateway upgrade and restart cases with the new watermark 29.

## Evidence limits

- The previous independent findings were reproduced and fixed: premature `send_message`/`finish_turn` text is blocked before messages/events; question/approval are not falsely treated as completion; and tool-time follow-ups prevent stale final delivery while preserving tool transcript pairing and consuming the same-run input. No real model or external channel was used.
- No real model request, cost, or quality claim was made. The required isolated provider, pricing authorization, and evaluation configuration were not available. Simulation/fixture results are software correctness evidence only, not a model-quality or cost improvement claim.
- IM correlation is only supported where the channel supplies a mapped reference. Without one, messages continue through ordinary new-message semantics; this change does not guess the latest question.
- No deployment, production migration, external delivery, or real-channel send was performed.
