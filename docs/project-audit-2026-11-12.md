# Project audit — 2026-11-12

## Scope and limits

Repository-wide inventory, architecture/configuration review, dependency audit, build/type checks, a broad test-script sweep, and targeted reproductions. This is not a claim that every source line was read or every defect found: the project has approximately 2,513 tracked files and over 75,000 lines of Web source alone.

Existing uncommitted API/model/image/UI work was preserved. No production data, remote deployment, live IM account, or paid model was used. Nothing was committed or pushed. Legacy code was not deleted merely because a test or import appeared obsolete.

## Verified issues fixed

1. **Sandbox admission race** — `infra/sandbox/broker.mjs` checked capacity/scope/execution ID before awaiting quota inspection, but only reserved them afterward. Concurrent requests could pass the same guard. Reservations now precede the asynchronous check and are released on quota rejection, failure, or cancellation. Regression coverage uses the real broker with a controlled fake Docker, covering duplicate scope/ID, the eight-request limit, cancellation, and retry after quota errors. A structured listening event exposes the actual ephemeral test port.
2. **Wrong PWA build manifest** — `apps/web/vite.config.ts` always read the default `dist` manifest. A custom output directory could build successfully while precaching an old entry. Manifest lookup now follows resolved root/output/manifest settings. Relative and absolute output directories and a custom manifest filename are covered.
3. **PDF fonts copied outside build output** — the PDF asset plugin treated `build.outDir` as absolute, although it may be relative to Vite's root. It now resolves against `config.root`; the build fixture checks fonts, CMaps, and licenses in each output directory. The audit's accidentally generated root-level `relative-output/` fixture was inspected and removed.
4. **Adaptive pool lost failures or stopped incorrectly** — `packages/study-core/src/utils/concurrency.ts` tested the truthiness of the first error and did not normalize synchronous callback throws. It now preserves falsy rejection reasons and applies the same scheduling policy to synchronous exceptions. Three tests cover first-error preservation, collecting failures, fail-fast, and concurrency bounds.
5. **Restore root-directory guard bypass** — `scripts/restore.sh` rejected literal `/` but not `/./`, traversal, or symlinks resolving to root. It now rechecks the canonical path. The regression uses mutation-blocking command stubs and never performs a real restore.
6. **Critical DOMPurify advisory** — upgraded Web's DOMPurify from 3.4.15 to 3.4.17, including its lockfile entry. No unrelated package upgrades were made. Browser HTML sanitization checks passed afterward.

Housekeeping: ignored generated `*.tsbuildinfo`, corrected an obsolete static-mode comment, and added npm commands for the four new regression scripts. Existing package-script additions were retained.

## Validation

- Final `npm run build`: **passed**, all five build tasks executed without cache hits; includes source-boundary and package/type checks.
- New regression suite: **6 passed**, zero failures.
- `check:i18n`, `check:remote`, `test:boundaries`: **passed**. The i18n checker still records 1,773 CJK strings across 539 files; passing the ratchet is not full localization.
- `test:install`: **17 passed**.
- Authenticated full-app browser check (`scripts/e2e-server-only-app.mjs`): **passed**, including lazy routes/settings and demand-only recovery.
- Browser HTML material/sanitization check (`scripts/test-material-html.mjs`): **12 passed**.
- API SIGTERM/SIGINT test: **passed** on isolated rerun. Its sweep failure was caused by the audit runner's temporary-directory layout, not a confirmed application defect.
- Initial broad sweep: **274 scripts attempted: 196 passed, 76 failed, 2 timed out**. These are script exit results, not individual assertions or 78 confirmed product bugs. Most failures were not rerun after this audit's fixes; selected browser scripts were run separately.
- Swift tests remain blocked by the local toolchain's `no such module 'XCTest'`; this is not evidence of passing native tests.

Repeat the new regressions from the repository root:

```sh
npm run test:concurrency
npm run test:pwa:build-directory
npm run test:sandbox:admission
npm run test:restore:safety
```

## Review next, in priority order

### High: API admission/error contract

`scripts/test-api.mjs:95` reproduces HTTP 500 when submitting a Bot message without a configured model. `apps/api/src/agent/service.ts:99` freezes the model inside the acceptance transaction, and `model_not_configured` now escapes synchronously. The old test expects an accepted message followed by a failed run. Decide whether missing/invalid model configuration should reject admission with a stable client error or create a durable failed attempt, then align REST/typed clients/IM and tests. Do not silently restore the old behavior merely to obtain a green test.

`scripts/test-server-question-extraction.mjs:87` also reproduces a generic “Resource operation could not be completed” where the test expects actionable conflict guidance. Review `apps/api/runtime/material-actions.ts` and resource error projection before changing wording or weakening conflict checks.

### High: remaining dependency advisories

After the DOMPurify patch, `npm audit` reports **19 affected package entries: 4 high, 9 moderate, 6 low; zero critical**. Entries overlap through dependency chains and do not establish exploitability in this deployment.

- High: `vite`, `brace-expansion`, `follow-redirects`, `source-map-js`.
- Moderate: `ajv`, `esbuild`, `fast-uri`, `glob`, `minimatch`, `react-router`, `react-router-dom`, `vite-plugin-pwa`, `workbox-build`.
- Low: `@ant-design/x-markdown`, `@rollup/plugin-node-resolve`, `deepmerge`, `katex`, `mermaid`, `serialize-javascript`.

Review reachable runtime issues separately from build/dev-server advisories. Vite, esbuild, Router, and PWA tooling remediation offered by npm includes major-version changes; coordinate those with build, routing, and service-worker regressions. Some transitive fixes and the AJV update are non-major, but were not compatibility-tested here. Keep development servers off untrusted networks while evaluating the Vite/esbuild advisories. Do not run an indiscriminate forced audit fix.

### High: test suite no longer tracks the architecture

Numerous tests import removed browser-worker/model/executor APIs (`cloud/workerAuth`, `harness/resources`, `harness/ankiCard`, `pipelines/subtitleSource`, `chatOnce`, `createExecutorRuntime`). Other mocks omit `freezeModel`, execution `effects`, account lifecycle, or current upload admission receipts. Update fixtures to current server-owned execution and authenticated commands; do not reintroduce retired interfaces or relax production permissions. There is no backward-compatibility requirement for retired protocols.

Release/drain/recovery coverage deserves early repair: some tests cannot start, and `test-release-recovery.mjs:96` expects `queued` where the current worker fence produces `interrupted`. Confirm that intended semantic before changing the assertion.

`test-chat-optimistic-send.mjs` and `test-gateway-photos.mjs` hit the sweep's 90-second process limit. `test-task-delegation.mjs` completed with three fixture timeouts. They require independent reruns/triage; these results alone do not prove deadlocks or justify increasing timeouts.

### Medium: backup/restore assurance

The root-path patch is narrow, not a complete archive-security review. `scripts/restore.sh` extracts before checking symlinks and verifies an archive-provided checksum manifest; review link/hardlink/special-entry handling, manifest path restrictions, and malformed-listing failure propagation before treating untrusted archives as safe. `scripts/backup.sh` copies live data without quiescing writers when no Compose file is supplied. Both scripts depend on GNU-style utilities such as `sha256sum`; supported Linux/macOS behavior needs explicit validation. Prefer the managed release backup/restore transaction for managed installs.

### Medium: performance and maintainability

- Final Web build has a 1,704.80 kB entry JS chunk (505.11 kB gzip), a 498.56 kB Library chunk, and a 557.59 kB Player chunk. PWA shell precache is 8 entries / 2,236.90 KiB. These are generated artifact sizes, not measured transfer or interaction regressions. Use bundle attribution and cold/warm browser timings before splitting dependencies.
- Large modules mix unrelated state and workflows: `apps/web/src/pages/Library.tsx` (2,805 lines), `components/ChatPanel.tsx` (1,685), `components/settings/ModelsModule.tsx` (1,322), `apps/api/runtime/node.ts` (1,247), `pages/CourseChat.tsx` (1,179), and `apps/api/src/agent/runner.ts` (1,138). Extract coherent responsibilities only with behavioral coverage; avoid a broad mechanical rewrite during concurrent work.
- UI typography/grid tests fail on additional hardcoded break/spacing/radius values. Confirm design intent rather than deleting the constraints or adding blanket exemptions.
- `withAdaptiveRetry` still assumes caught values have a readable `status`; null/undefined rejection handling merits a separate regression review. Only the pool behavior was changed here.

### Low: deletion/cleanup candidates, not approved removals

- `apps/web/src/pages/Projects.tsx` and `pages/projects-home.css`: no route/import reference was found outside the module's own CSS import. Confirm no generated/external entry point before removing.
- Checked-in `scripts/.tmp-debug-swipe.mjs` and `scripts/.tmp-shot.mjs`: review whether they should be maintained diagnostics or deleted.
- `scripts/e2e-all.mjs` and several old pipeline tests contain historical static-mode assumptions/selectors/skips. Consolidate current acceptance coverage before retiring them.
- Wake-lock calls remain in `Library.tsx`; their necessity depends on which import work still runs locally. They were not proven dead and were not removed.

## Broad-sweep failure inventory

Logs preserve full assertions. This list records the original sweep, including the API-signals environmental failure subsequently cleared on rerun.

```text
test-agent-instructions.mjs
test-agent-loop.mjs
test-anki-cards.mjs
test-api-signals.mjs
test-api.mjs
test-artifact-edit.mjs
test-auto-subtitles.mjs
test-bilibili-userscript.mjs
test-board-plugins.mjs
test-bootstrap-link.mjs
test-bot-continuity.mjs
test-bot-conversation.mjs
test-bot-default-workspace.mjs
test-bot-domain.mjs
test-bot-migrations.mjs
test-bot-network.mjs
test-bot-resource-access.mjs
test-bot-resources.mjs
test-bot-workspace-files.mjs
test-browser-worker.mjs
test-chat-followup.mjs
test-chat-frames.mjs
test-chat-optimistic-send.mjs [90-second timeout]
test-create-mode.mjs
test-db-schema.mjs
test-dsml.mjs
test-executor-interactions.mjs
test-executor-runtime.mjs
test-file-names.mjs
test-gateway-management.mjs
test-gateway-photos.mjs [90-second timeout]
test-gateway-review.mjs
test-gateway-workers.mjs
test-gateway.mjs
test-handout-file.mjs
test-i18n.mjs
test-ilink.mjs
test-image-upload.mjs
test-jev.mjs
test-lazy-session.mjs
test-learning-products.mjs
test-library-folders.mjs
test-material-images.mjs
test-memory-context.mjs
test-message-hygiene.mjs
test-migration.mjs
test-model-discovery.test.ts
test-model-metadata.mjs
test-model-once-response.mjs
test-model-overrides.mjs
test-plugin-projects.mjs
test-plugin-shared-state.mjs
test-projects.mjs
test-providers.mjs
test-qa-runner.mjs
test-question-bank.mjs
test-quiz.mjs
test-release-drain.mjs
test-release-recovery.mjs
test-release-staging.mjs
test-resource-compat.mjs
test-resource-tools.mjs
test-runtime-identities.mjs
test-sandbox-output.mjs
test-server-context-compression-consumption.mjs
test-server-context-compression.mjs
test-server-drain.mjs
test-server-question-extraction.mjs
test-session-queue-boundaries.mjs
test-skill-catalog.mjs
test-task-delegation.mjs
test-typography.mjs
test-ui-radii.mjs
test-vision-routing.mjs
test-web-search.mjs
test-wechat-replies.mjs
test-widget-state.mjs
test-wrongbook.mjs
```

Additional triage examples: Bilibili userscript tests lack timers/URL globals and expect an obsolete response API; the VM failure is not a reproduced browser defect. Sandbox-output's fake Docker does not support startup image inspection. Quiz SSR tests lack `getServerSnapshot`. Model/provider assertions may reflect current routing redesign. Malformed JSON, project identity, gateway delivery, widget protocol, and model attachment failures remain unclassified until their fixtures and runtime paths are checked.

## Sweep exclusions

The runner selected root `scripts/test-*` JavaScript/TypeScript entries, omitted directly detected browser tests and known real-environment tests, sanitized credential/deployment environment variables, and ran four processes concurrently with 90 seconds per script. It did not exhaust nested/package tests, all `e2e-*` scripts, Python tests, native/device matrices, live Docker/Linux, or paid-model evaluations. Some selected wrappers transitively launched browser tests; this was not a perfectly isolated unit-test suite.

These 20 scripts were excluded from that sweep; `test-material-html.mjs` was subsequently run separately and passed:

```text
test-bootstrap-e2e.mjs
test-cloud-e2e.mjs
test-cloud-models-e2e.mjs
test-document-fold.mjs
test-file-store.mjs
test-html-answer-dom.mjs
test-material-html.mjs
test-model-list-source-e2e.mjs
test-model-picker-layout.mjs
test-nav-unread-motion.mjs
test-pdf-fit.mjs
test-projects-e2e.mjs
test-reader-position.mjs
test-route-preload.mjs
test-sandbox.mjs
test-study-tracker-lifecycle.mjs
test-telegram-thanos.mjs
test-vps-old-page.mjs
test-vps-separation.mjs
test-web-server-only-adapters.mjs
```

## Local evidence

Machine-local temporary evidence is under `/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/` and is not checked in:

- `project-audit-tests/results.json` and per-script `.log` files: complete sweep outcomes.
- `run-project-audit.mjs`: selection/exclusion rules and execution harness.
- `project-audit-dependencies.json`, `project-audit-dependencies-after.json`: before/after npm audit output.
- `project-audit-final-build.log`: final full build.
- `project-audit-app.log`, `project-audit-html.log`: browser results.

Temporary evidence may expire. This report intentionally retains the findings and failed/skipped inventory in the repository.
