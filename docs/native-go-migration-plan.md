# Native Go/MyGo migration plan

## Scope and boundary

The MyGo desktop shell can become a Go-only native surface without removing
the React/WebView build. The WebView remains the Pages/static-preview and
fallback surface until the native shell covers the same product paths. No
runtime JavaScript is required by the native window; Vite/TypeScript stays as
build glue and as the compatibility client.

## Current frontend inventory

| Area | Current implementation | Native status |
| --- | --- | --- |
| Chat messages | `App.tsx` + assistant-ui | Native shell already has `ui.List`, Markdown AST and `ui.RichText` |
| HTTP/SSE | `go-runtime.ts` (reconnect, replay, tool events) | Go `internal/api` already has SSE, replay and cancellation; add a small native client |
| Composer text | assistant-ui `ComposerPrimitive` | `ui.TextInput` and `ui.PrimaryButton` are available |
| Voice | `MediaRecorder`, `getUserMedia`, Web Audio analyser, Canvas | No microphone/audio-input API in the current Go/MyGo dependencies; keep WebView for now |
| Attachments | browser `File`/`FormData` and drag/drop | MyGo `Dialog.Open`/`OnFileDrop` plus existing Go `/attachments` API can replace it |
| Resources | IndexedDB, FileReader, browser selection | Requires a Go resources table/API before a durable native page |
| Theme/navigation | React state + localStorage + CSS | Native state and `ui.Theme`/sidebar/buttons are direct migrations |
| Settings | React modal, provider metadata preview | Native shell exposes credential-free provider/model/base URL/API-env editing through the in-memory Go config API |

## Phase 1: smallest shippable native slice

1. Keep the existing native `chat` page and Markdown block renderer.
2. Add a stable native `sessionID` and `messageID`; hydrate sessions/messages
   from the existing `/api/v1/sessions` routes and send runs with those IDs.
3. Move the SSE loop into a small Go client with the browser adapter's
   semantics: terminal events, reconnect using `Last-Event-ID`, cancellation,
   and bounded scanner buffers.
4. Keep text-only composer on `ui.TextInput`; show a disabled attachment affordance
   until the attachment slice is enabled.
5. Finish native theme toggle, sidebar navigation, and runtime/provider status.
   Provider metadata edits stay in memory for the next run and never expose or
   persist credential values.

Phase 1 acceptance:

- Launching the native shell shows the last session and messages after restart.
- A text prompt is persisted once, streams Markdown blocks, and reconnects from
  the last SSE event without duplicate output.
- Headings, paragraphs, fenced code (colored spans), tables, lists and quotes
  render with native controls.
- No browser media API or JavaScript is executed by the native window.

## Phase 2: attachments and resources

- Use `mygo.Dialog.Open` and native file-drop paths to import Markdown/TXT.
- Store resource metadata and text in a Go SQLite table; keep blobs in the
  existing content-addressed attachment store.
- Add list/search/preview/excerpt routes and send a bounded excerpt in the chat
  prompt. Add native table/list views after the API contract is stable.

## Phase 3: voice and parity

- Keep the WebView voice experience until a platform-tested pure-Go microphone
  capture path is available. MyGo's current UI APIs provide pointer gestures,
  but not microphone capture or an audio analyser.
- If a pure-Go capture module is introduced, make it a separate platform
  package with permission/error tests; then port long-press, cancel-on-slide,
  elapsed time and the waveform state into native UI.

## Deliberately deferred

- A one-shot rewrite of all 915 lines of `App.tsx` and 290 lines of CSS.
- Liquid Glass/glass plugin and terminal/headless features: unrelated to the
  first native chat slice and would add platform/visual regression surface.
- Durable cross-restart provider config persistence and credential-manager
  integration remain deferred. The local API accepts only endpoint, model and
  environment-variable names and keeps edits in memory.
