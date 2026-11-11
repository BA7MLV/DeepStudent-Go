# Chat attachment references

## Contract

- `serverId`: immutable uploaded **original**, used for download, model vision and existing resource-library archival.
- `previewServerId?: string`, `width?: number`, `height?: number`: authenticated preview file ID and EXIF-oriented original dimensions.
- `POST /api/v1/files` now returns those three fields for supported raster images in addition to the existing file DTO. One original upload is sufficient: the server generates a WebP preview (640×640 inside, no enlargement, first animation frame). Original bytes are never transcoded. Client-created draft previews remain allowed but are not authoritative.
- Original and preview use the existing `GET /api/v1/files/:id`: account authentication precedes ETag/304, `private, no-cache`, byte ranges and download disposition are preserved. No new public URL/storage stack.
- Chat task admission and execution rebuild attachment metadata from owned `files` records, discard inline `dataUrl`, ignore untrusted preview/dimensions, and preserve extracted text/descriptions. Raster originals are limited to 32 MB each / 64 MB total per task. Text attachment limits remain in place.
- Persistent model traces/checkpoints use `image_url.url = attachment-file:<id>`. Actual model requests alone expand owned references to original data URLs, checking bytes/size/SHA-256. Continuation, history and resumed-agent rounds use the same boundary. Missing, foreign or corrupt images fail explicitly; they are not silently dropped.
- `DELETE /api/v1/files/:id` returns `409 file_in_use` for IDs referenced by retained records or submitted task inputs, including internal trace URLs and a preview's original. Unsubmitted drafts can be deleted; deleting an unreferenced original also removes its generated preview. Existing archival receipts/resource copies are unchanged.
- Task delivery is distinct from execution: `full/session` UI inputs remove historical inline visual bytes recursively (including QA `images/chatImages`); `activity` Chat/QA inputs contain identity/action only, projected in SQLite before Node. Executors receive untouched complete stored inputs. Receipt retries look up the owner/nonce first and compare user semantics (`serverId`, extraction, text, options), not mutable preview/dimensions or current file/plugin availability. New operations still perform all ownership/vision validation.

## Explicit migration (not automatic)

Authenticated, origin-checked POSTs only; no read/projection invokes a migration:

1. `/api/v1/files/migrate-chat-attachments?afterRevision=0`: at most 20 retained Chat rows, returns `migrated`, `failed`, `raced`, `nextRevision`.
2. `/api/v1/files/migrate-task-attachments?afterId=`: at most 20 **terminal chat** task inputs, returns analogous counts and `nextId`. Active/queued task inputs and live checkpoints are deliberately not rewritten under executors; run again after terminal completion.

Pass the returned cursor to continue past failed rows. Restart at zero/empty to retry failures/races. Each inline image is installed under an owner-scoped deterministic operation ID, format/pixel-validated, read back and hash-verified; preview bytes are verified too. Only then is the Chat row replaced through the ordinary records journal after exact value+revision comparison inside the transaction. Terminal input updates compare original input and status. A concurrent edit wins; malformed/missing originals leave the whole source record untouched. Existing `serverId` originals are verified and **preserved** even when the old `dataUrl` is a lossy thumbnail. Imported trace-only images also get durable owned file references.

The batch API does not erase historical change-log events, command receipts, database backups or arbitrary image strings embedded in prose. It does not garbage-collect installed blobs after a failed/raced migration (intentional crash-safe retention). Nothing was run against production. Operational rollout must explicitly run bounded batches and account for retained full-history/export data; no automatic background migration has been enabled.

## Local evidence

- `npm run build --workspace=@wangke/study-core`: 61 native export/DOCX checks.
- `node apps/api/scripts/build-runtime.mjs`: rebuild native task runtime before the runner test (otherwise it tests stale dist).
- `npx tsx scripts/test-chat-attachment-references.mjs`: original/preview identity and bounds, normalization, owner isolation, exact model bytes, corruption, deletion guard, safe migration, CAS edit race, retry/idempotency, retained failure, terminal-vs-active task migration.
- That migration test includes 20 permanently bad first rows followed by a valid image; `nextRevision` advances past the failed batch and the successor migrates, while bad source rows remain exact and retryable.
- `npx tsx scripts/test-task-attachment-projections.mjs`: safe full/activity/session DTOs, original reference retention, QA executor's complete private image input, completed nonce replay without original/session/plugin availability, altered semantic conflict, new-operation ownership validation.
- `npx tsx scripts/test-chat-attachment-files.mjs`: real isolated Fastify upload/download/preview authentication, ETag auth-before-304, ranges, original byte equality, committed deletion rejection and draft preview cascade.
- `npx tsx scripts/test-server-chat-attachments.mjs`: real native runner with offline model transport; mixed TXT/PDF/DOCX/images, attachment-only turn, persistence without Base64, history replay with/without trace, continuation, fork/retry, ownership and invalid-input checks.
- `npm run typecheck --workspace=@wangke/api`.

No paid model, deployment, production writes, commit or push.

Independent acceptance was run without editing its red assertions: `npx tsx scripts/e2e-data-delivery-acceptance.mjs` passed 11/11 twice (`data-delivery-acceptance-yCKBst/evidence.json`, final rerun `data-delivery-acceptance-NOd7kq/evidence.json` under the approved temporary root), including the two audited backend regressions. `npx tsx scripts/test-chat-resource-attachments.mjs` also passed the existing per-session archival, same-name/account isolation, draft, idempotency, deletion and restart checks. This is local evidence, not production performance.

The separate existing QA message display contract (`images[].thumb`, rather than Chat `attachments[]`) is not converted into frontend reference rendering here. QA task UI delivery is byte-free and executor vision is preserved, but complete historical QA screenshot migration/display needs coordinated frontend support; do not simply delete thumbnail fields. This boundary was reported to the coordinating session.
