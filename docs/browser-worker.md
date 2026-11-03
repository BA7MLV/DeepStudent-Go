# External browser worker

The API does not launch Chromium or FFmpeg. Node owns scheduling, model calls, text processing, and persistence. Media decoding/rendering runs in the user's authenticated browser.

Ordinary signed-in application pages automatically host a same-origin worker iframe. Web Locks elect one host per browser/account, and server leases coordinate devices. The iframe isolates task credentials and worker state from the interactive app. A standalone `?cloud-worker=1` tab is still supported but no longer required. Only the claimed task's scoped bearer token can report, authorize, mutate records, or complete it.

Browser leases expire after 30 seconds. A server restart or expired lease returns browser tasks to `queued`. Keep an app tab open while processing; closing/suspending all tabs pauses browser work until a tab can claim it again. Playwright and FFmpeg are development-only tools for E2E fixtures, not deployment dependencies.

Video uploads automatically prepare subtitles. Bilibili imports first reuse original subtitles; absent/unavailable originals fall back to browser audio extraction + VAD + the configured ASR model. ASR is a remote model call, not offline speech recognition, and may incur provider charges. Completed segments are checkpointed; failures and explicit cancellations retain a retry control. Cover generation also uses the browser and preserves user-selected covers.
