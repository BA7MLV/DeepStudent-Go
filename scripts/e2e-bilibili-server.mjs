// Isolated real API + browser + FFmpeg; Bilibili network responses are fixtures.
// npm run test:bilibili:e2e builds the API runtime before running this scenario.
process.env.BILI_BROWSER = '1';
await import('./test-server-bilibili.mjs');
