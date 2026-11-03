// Compatibility entrypoint: manual refetch controls were replaced by automatic
// original-subtitle selection. The isolated E2E covers parent-frame Bilibili
// bridge reuse, skipping ASR, automatic browser ASR, failure, cancel and retry.
// Run with npx tsx; provide TEST_FILE with spoken audio outside macOS.
await import('./e2e-auto-subtitles.mjs');
