# Resource command recovery

## User-facing behavior

- Normal pages do not mount the command-inspection list or show internal operation IDs.
- Reading position, playback, duration, and reading-view changes are durable replacement state. Unsent updates of the same kind/course coalesce (400 ms debounce, 1 s maximum delay). New-protocol progress also supersedes older network attempts within the same database scope, with per-field sequence fences protecting the server; this exception never applies to documents, uploads or historical evidence.
- New commands reconcile durable receipts before sending. A lost response is not treated as a failed write. Retries retain the original operation ID, payload and database scope; transient failures use jittered exponential backoff, up to six attempts per connection opportunity.
- Reconnection, explicit confirmation, or a fresh signed-in page can resume paused transient work. Validation/permission failures and conflicts do not participate in automatic retries.
- A single business-language notice summarizes document/file failures. Settings → Data provides details, retained drafts, export, and explicit conflict comparison/merge. A merged save is a new version-checked command; the original draft is archived only after success.
- Completed browser journals retain compact receipts, never another copy of a successful document/Blob. Up to 500 receipts / seven days are retained locally. Pending, uncertain, conflicted, and archived user-authored originals are not garbage-collected.

## Server guarantees

- SQL-only facts and completed receipts commit atomically. A per-browser-stream sequence fence prevents delayed older progress from overwriting a newer update from the same stream. Across independent devices, server arrival order remains the conflict policy for progress.
- Filesystem commands persist admission before execution. Domain metadata and the final receipt share one SQL transaction. An external write-ahead undo journal records file identities, fingerprints and backups before each filesystem effect; files and affected directories are flushed before success.
- Startup and receipt inspection can roll back an interrupted journal, then permit the same original request to resume. Rollback is restartable, including revision aliases needed because rename/link changes filesystem ctime. Only unchanged identities may be restored. External changes leave the operation uncertain and all evidence retained.
- A committed receipt is authoritative even if journal cleanup was interrupted. Server deduplication receipts are not removed by the browser retention policy.
- Binary uploads have a receive lease and validate size/hash before entering the same journaled commit. Incomplete receives release the lease; boot releases abandoned new-protocol receive leases. A committed upload is not transferred again after a lost response.
- Journal storage must share the workspace filesystem and stays outside sandbox mounts. Linux paths retain pinned/no-follow parent resolution. The macOS development fallback requires idle workspaces.
- Bound executor commands can be rolled back but are not automatically redispatched at startup; recovery cannot borrow expired capabilities.

## Conservative compatibility

- Historical commands without a durable workflow/scope can be automatically retired using a completed receipt, but missing receipts do not authorize replay. Unknown old deletions and imports remain preserved for explicit review.
- Existing create-only library import/blob workflows retain their separate compatibility protocol; they are not silently upgraded into generic file retries.
- A database-scope fence protects queued commands whose original server scope is known. Scope is cached locally before subsequent offline edits. It is not a substitute for deployment-level backup/restore generation management: restoring the scope together with a database snapshot restores that identity too.

## Verification

- `npm run test:resources:recovery`: real child-process exits before/after file effects and SQL commit; interrupted rollback; move/remove/create identity and metadata; external-edit preservation; ordered progress; browser offline coalescing, lost save/upload responses, stable IDs, conflict merge, permanent failures, legacy preservation and scope fences.
- `npm run test:server-only:app`: full application routes/settings, including 39 retained historical commands, demand-only recovery and no command flood.
- `npm run test:history-recovery:demand`: offline preservation/export and explicit-only loading.
- `npx tsx scripts/test-client-runtime.mjs`, `npx tsx scripts/test-resource-folders.mjs`, web/API typechecks, and `npm run check:boundaries`.
- The older `scripts/e2e-preference-commands.mjs` currently cannot start: its existing fixture imports missing `apps/web/src/cloud/executor-runtime.ts`. Its resource assertions were aligned with automatic confirmation while retaining historical export/archive coverage, but the whole legacy suite remains blocked by that missing module.
