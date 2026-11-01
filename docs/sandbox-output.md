# Sandbox output and lifecycle

The broker controls Docker; the API controls result storage and model context.
Preview truncation must never be confused with execution failure or cleanup.

## Execution and transport

- `POST /execute` negotiates streaming with `Accept: application/x-ndjson`.
  Stdout/stderr frames carry base64 bytes; one terminal `result` or `error` frame
  ends the stream. HTTP 200 alone does **not** mean execution succeeded. EOF
  without the terminal result is a protocol failure, not a successful command.
- Both pipes are consumed concurrently. HTTP backpressure pauses both pipes;
  the API awaits disk writes before reading further. Memory does not grow with
  the command's total output. UTF-8 split across frames is decoded incrementally.
- Each stream has an 8 KiB head/tail preview. Exceeding this budget does not
  stop the command. `stdoutTruncated`/`stderrTruncated` describe the preview.
- A separate 16 MiB combined stdout/stderr hard budget stops output floods.
  The result explicitly carries `terminationReason=output_limit_exceeded`,
  `output.complete=false`, and the available partial output. Commands can have
  already changed workspace files: do not automatically replay them.
- JSON-only clients receive marked previews and metadata. A new API accepts an
  older JSON-only broker during a rolling upgrade, but cannot recover output
  that an old broker has already discarded. Upgrade both API and broker.
- `/files/read` remains a separate, binary-safe transfer with its own 20 MiB cap.

## Artifacts

The API initially buffers at most 8 KiB per stream, then spills larger output to
private files next to the database (`<database filename>.outputs/`). This
directory is on the existing API data mount, is not mounted in sandbox containers,
and requires no broker write access to `/data` or new shared Docker volume.

SQLite stores ownership, run/step association, a short preview, size, expiration,
and character count—not the full shell output. Existing inline artifacts are
unchanged. `artifact_read` uses the same owner checks, UTF-16 character offsets,
token budget and `nextOffset` pagination for either kind of artifact. UTF-16LE
storage permits bounded random reads without loading or re-decoding the whole
file. Binary results should use `/files/read`, not shell text output.

Large shell artifacts expire after seven days. The existing per-owner artifact
budget remains 50 MiB of original UTF-8 output / 1,000 artifacts; concurrent shell
captures reserve quota before writing. UTF-16LE files can occupy up to twice the
original byte budget. Model previews remain available if storage is full or
unavailable; `outputStorageError` says the full output was **not** saved. This
does not turn an otherwise successful command into a failed execution.

The Bot runtime performs cleanup at most once a minute, independently of the IM
gateway. It deletes expired metadata, orphaned published files (including after
thread/account deletion), and abandoned staging files older than one hour.
Database backups that need historical shell outputs must include the sibling
`.outputs` directory; database-only copies retain previews, not full logs.

## Cleanup and errors

- Explicit removals are coalesced per container. A Docker `--rm` race returning
  “removal already in progress” is retried, with a bounded deadline, until removal
  succeeds or the container is confirmed absent. Other Docker errors are not
  silently ignored.
- A cleanup failure retains the broker scope lock and API's durable project
  execution lease. Background retry / cancellation / startup recovery releases
  them only after confirmed removal. A successful `docker rm` or “no such
  container” is confirmation; “removal in progress” is not.
- Busy, authentication/configuration, invalid request, startup, transport, and
  cleanup failures retain distinct codes and user notices. Output-budget
  termination is a command result, not `sandbox_unavailable`.
- Broker diagnostics record execution IDs, output byte counts, termination and
  cleanup status, not commands, output bodies, credentials or tokens.

## Verification

`npm run test:sandbox-output` runs the real broker, streaming transport and API
artifact pipeline with a fixture Docker executable and real child-process pipes.
It covers the 217 KB regression, head/tail previews, removal races, cleanup scope
locking, backpressure, output floods, Unicode pagination, restart, owner isolation,
quota degradation, expiration, protocol errors and the real Bot runner.

`npm run test:sandbox` additionally exercises actual Docker isolation, binary
transfers, command cancellation and deadlines; it needs a running Docker daemon
and the sandbox image.
