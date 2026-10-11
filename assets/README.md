# DeepStudent app icon

`deepstudent-app-icon.png` is the official DeepStudent app icon copied from the
public upstream repository:

- Source: https://github.com/helixnow/deep-student/blob/main/public/app-icon.png
- Upstream license: AGPL-3.0 (https://github.com/helixnow/deep-student/blob/main/LICENSE)
- This redistributed copy remains under the upstream repository's AGPL-3.0 terms
- Retrieved: 2026-10-04
- SHA-256: `88d115bbaa33d98511b6eb48f2d80331190b9fa7d8ddf478c714a3662b8ec02b`

The source is a 1024×1024 RGBA PNG. MyGo v0.3.7 consumes the configured PNG
and generates the platform bundle resources during `mygo build`; on macOS it
renders the required `.icns` payloads itself, so no checked-in generated
`.icns` file is needed.
