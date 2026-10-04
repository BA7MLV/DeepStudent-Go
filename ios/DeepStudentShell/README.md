# DeepStudent iOS shell experiment

This directory is an intentionally small SwiftUI shell for the DeepStudent-Go
runtime. It is a reviewable native-client spike, not a release target or a
claim that an iOS app has been built.

## Information architecture

- **Sessions** is the launch surface: compact pinned/recent rows, unread count,
  status, search, pull-to-refresh, and navigation into a chat-first detail
- **Session detail** keeps a dense timeline and bottom composer. Fixture sends
  stream assistant deltas so the interaction can be reviewed before a backend
  is available
- **Study** is a secondary shelf for flashcards, practice tasks, saved
  explanations, and templates
- **Settings** exposes fixture/live runtime choice, base URL, health/readiness
  diagnostics, and experiment flags

The compact interaction model is inspired by Telegram's native iOS density,
with original DeepStudent labels and behavior. It is not a Telegram clone.
`NavigationStack` is used on iPhone; `NavigationSplitView` is used for regular
widths such as iPad.

## Files

```text
App/DeepStudentShellApp.swift       SwiftUI app entry point
App/AppModel.swift                  Main-actor state and dependency injection
Domain/Models.swift                 Codable session, chat, run, and event models
Data/SessionRepository.swift        Repository seam for future history API
Data/FixtureData.swift              Deterministic offline sessions/messages
Data/RuntimeClient.swift             Go HTTP + SSE client and fixture client
Features/Root/RootView.swift         Adaptive NavigationStack/SplitView shell
Features/Sessions/*                 List, rows, detail timeline, composer
Features/Study/StudyView.swift       Study shelf cards and next-step prompt
Features/Settings/SettingsView.swift Runtime diagnostics and flags
Shared/UIComponents.swift            Status, connection, and empty-state views
```

## Runtime seam

`DeepStudentRuntimeClient` keeps views independent of transport. The live
`GoRuntimeClient` targets the existing local Go API:

1. `GET /healthz` and `GET /readyz`
2. `POST /api/v1/runs` with `session_id`, `prompt`, `model`, and `max_tokens`
3. Read the returned relative `events_url` as `text/event-stream`
4. Map `run.started`, `message.delta`, `run.completed`, and `run.error` into
   the timeline

The repository currently uses `FixtureSessionRepository` because the Go API
has no session list/history route yet. No provider key is stored in the app.
The shell surfaces stream errors as a failed message so a dropped connection is
recoverable and visible.

## Verification limits

This checkout does not include Xcode, an iOS SDK, or `xcodebuild`, so the files
have not been compiled or run here. There is deliberately no `.xcodeproj` or
signed app artifact. To review on macOS, create an iOS App target that includes
this directory's Swift files, choose iOS 17 or newer, and run the normal Xcode
build/tests. Add a real target only after the spike gates in the repository
README are met.
