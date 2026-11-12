import assert from 'node:assert/strict';
import dns from 'node:dns';
import { syncBuiltinESMExports } from 'node:module';
import Fastify from 'fastify';
import { linkIconHost, linkIconOrigin } from '../packages/contracts/src/web-links.ts';
import { websiteChip, linkText, standaloneLink } from '../apps/web/src/components/markdown/links.ts';
import { websiteBrand } from '../apps/web/src/components/markdown/websiteBrands.ts';
import { LinkIcons, registerLinkIconRoutes } from '../apps/api/src/web-links/icons.ts';

assert.equal(linkIconHost('WWW.GitHub.COM.'), 'www.github.com');
for (const value of [undefined, [], 'localhost', '127.0.0.1', '[::1]', 'x.local', 'x.internal', 'x.onion', 'x.test', 'https://github.com', 'github.com/path', 'user@github.com', 'github.com?token=secret', 'github.com:8080', 'x..com', '-x.com', 'a'.repeat(64) + '.com']) {
  assert.equal(linkIconHost(value), null, String(value));
}
assert.equal(linkIconOrigin('https://WWW.GitHub.COM/'), 'https://www.github.com');
assert.equal(linkIconOrigin('http://example.org'), 'http://example.org');
for (const value of [undefined, [], 'github.com', 'https://github.com/path', 'https://github.com?token=secret', 'https://github.com#part', 'https://user:pass@github.com', 'ftp://github.com', 'https://github.com:8080', 'http://127.0.0.1', 'http://[::ffff:127.0.0.1]', 'https://x.local']) {
  assert.equal(linkIconOrigin(value), null, String(value));
}
for (const [host, brand] of [['github.com', 'github'], ['WWW.GITHUB.COM.', 'github'], ['www.bilibili.com', 'bilibili'], ['b23.tv', 'bilibili'], ['zhuanlan.zhihu.com', 'zhihu'], ['mp.weixin.qq.com', 'wechat'], ['www.notion.so', 'notion'], ['chatgpt.com', 'openai']]) {
  assert.equal(websiteBrand(host)?.id, brand);
}
for (const host of ['github.com.evil.org', 'fakegithub.com', 'example.org', 'weixin.qq.com.evil.org']) assert.equal(websiteBrand(host), null);
const bare = websiteChip('https://www.github.com/org/repo?tab=readme#intro', 'https://www.github.com/org/repo?tab=readme#intro', false);
assert.equal(bare.host, 'www.github.com');
assert.equal(bare.label, 'github.com/org/repo?tab=readme#intro');
assert.equal(bare.bare, true);
assert.equal(bare.iconOrigin, 'https://www.github.com', 'only origin reaches the backend');
assert.equal(websiteChip('https://example.org:8080/doc', 'Docs', true)?.iconOrigin, null, 'custom ports never trigger remote fetching');
assert.equal(websiteChip('http://github.com/foo', 'github.com/foo', false)?.bare, true);
assert.equal(websiteChip('https://github.com', '参考文档', false), null, 'descriptive prose is not a chip');
assert.equal(websiteChip('https://github.com', '参考文档', true)?.label, '参考文档');
for (const href of ['#source-image/course/image', '#heading', '/library', 'mailto:a@example.com', 'javascript:alert(1)', 'file:///doc.md', 'https://user:secret@example.com', 'http://127.0.0.1', 'https://example.org/file.pdf?download=1', 'https://example.org/image.png', 'https://example.org/file.md']) {
  assert.equal(websiteChip(href, href, true), null, href);
}
assert.equal(websiteChip('https://app.example.org/help', 'https://app.example.org/help', true, ['https://app.example.org']), null);
const node = { type: 'tag', name: 'a', children: [{ type: 'tag', name: 'strong', children: [{ type: 'text', data: 'GitHub' }] }] };
node.parent = { type: 'tag', name: 'p', children: [node, { type: 'text', data: '\n ' }] };
assert.equal(linkText(node), 'GitHub');
assert.equal(standaloneLink(node), true);
node.parent.children.push({ type: 'text', data: '正文' });
assert.equal(standaloneLink(node), false);
assert.equal(linkText({ type: 'tag', name: 'a', children: [{ type: 'tag', name: 'img', children: [] }] }), null);

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3b8AAAAASUVORK5CYII=', 'base64');
let requests = 0;
const icons = new LinkIcons(async (url, init) => {
  requests++;
  assert.equal(url, 'https://github.com/favicon.ico');
  assert.equal(init.redirect, 'manual');
  assert.equal(init.credentials, 'omit');
  assert.ok(init.signal);
  assert.ok(init.dispatcher, 'connection-time public DNS guard is mandatory');
  assert.equal(init.headers.cookie, undefined);
  assert.equal(init.headers.authorization, undefined);
  assert.equal(init.headers.referer, undefined);
  return new Response(png, { headers: { 'content-type': 'image/png' } });
});
const results = await Promise.all(Array.from({ length: 5 }, () => icons.get('https://github.com')));
assert.equal(requests, 1, 'simultaneous origin requests are deduplicated');
assert.deepEqual(results[0].bytes, png);
assert.equal(results[0].type, 'image/png');
await icons.get('https://github.com');
await icons.get('http://127.0.0.1');
assert.equal(requests, 1, 'cache hit and invalid input do not fetch');

for (const response of [
  () => new Response('<svg onload="alert(1)"/>', { headers: { 'content-type': 'image/svg+xml' } }),
  () => new Response('<html>upstream error</html>', { headers: { 'content-type': 'image/x-icon' } }),
  () => new Response(png, { headers: { 'content-length': '1000000' } }),
  () => new Response(Buffer.alloc(65537)),
  () => new Response(null, { status: 302, headers: { location: 'http://localhost/private' } }),
  () => new Response(null, { status: 404 }),
]) {
  let attempts = 0;
  const failed = new LinkIcons(async () => { attempts++; return response(); });
  assert.equal(await failed.get('https://example.org'), null);
  assert.equal(await failed.get('https://example.org'), null);
  assert.equal(attempts, 1, 'failures are negatively cached');
}
const throwing = new LinkIcons(async () => { throw new Error('network unavailable'); });
assert.equal(await throwing.get('https://example.org'), null);
const ico = Buffer.from([0, 0, 1, 0, 1, 0, 0, 0]);
assert.equal((await new LinkIcons(async () => new Response(ico)).get('https://example.org')).type, 'image/x-icon');

// Each redirect is revalidated before any request, including credentials,
// local/private destinations, unsafe ports, and HTTPS downgrade attempts.
for (const location of ['http://localhost/private', 'https://127.0.0.1/favicon.ico', 'https://[::1]/', 'https://x.internal/', 'https://metadata.google.internal/', 'https://169.254.169.254/', 'https://user:pass@example.org/', 'https://example.org:8080/', 'file:///etc/passwd', 'http://example.org/icon.ico']) {
  let attempts = 0;
  const redirect = new LinkIcons(async () => { attempts++; return new Response(null, { status: 302, headers: { location } }); });
  assert.equal(await redirect.get('https://example.org'), null, location);
  assert.equal(attempts, 1, 'unsafe redirect is never fetched');
}
const hops = [];
const redirected = new LinkIcons(async (url, init) => {
  hops.push(url);
  assert.ok(init.dispatcher);
  assert.equal(init.redirect, 'manual');
  return hops.length === 1
    ? new Response(null, { status: 302, headers: { location: 'https://cdn.example.org/icons/logo.ico' } })
    : hops.length === 2 ? new Response(null, { status: 307, headers: { location: './small.ico' } }) : new Response(png);
});
assert.deepEqual((await redirected.get('https://example.org')).bytes, png);
assert.deepEqual(hops, ['https://example.org/favicon.ico', 'https://cdn.example.org/icons/logo.ico', 'https://cdn.example.org/icons/small.ico']);
let loops = 0;
assert.equal(await new LinkIcons(async () => { loops++; return new Response(null, { status: 302, headers: { location: '/favicon.ico' } }); }).get('https://example.org'), null);
assert.equal(loops, 4, 'redirect count is bounded');

// Exercise the real fetch dispatcher with controlled DNS answers. No socket
// should be opened, even for mixed public/private or mapped IPv6 records.
const originalLookup = dns.lookup;
try {
  for (const addresses of [[{ address: '127.0.0.1', family: 4 }], [{ address: '::1', family: 6 }], [{ address: '::ffff:10.0.0.1', family: 6 }], [{ address: '1.1.1.1', family: 4 }, { address: '192.168.1.1', family: 4 }]]) {
    let lookups = 0;
    dns.lookup = (_host, _options, callback) => { lookups++; queueMicrotask(() => callback(null, addresses)); };
    syncBuiltinESMExports();
    assert.equal(await new LinkIcons().get('https://rebinding.example.org'), null);
    assert.ok(lookups > 0, 'DNS is guarded on the actual connection, not just a preflight');
  }
} finally { dns.lookup = originalLookup; syncBuiltinESMExports(); }

let cachedRequests = 0;
const evicting = new LinkIcons(async () => { cachedRequests++; return new Response(png); });
for (let i = 0; i <= 256; i++) await evicting.get(`https://site${i}.org`);
await evicting.get('https://site256.org');
assert.equal(cachedRequests, 257);
await evicting.get('https://site0.org');
assert.equal(cachedRequests, 258, 'oldest cache entries are evicted');
const originalNow = Date.now;
try {
  let now = originalNow(), calls = 0;
  Date.now = () => now;
  const expiring = new LinkIcons(async () => { calls++; return new Response(null, { status: 404 }); });
  await expiring.get('https://example.org');
  now += 300001;
  await expiring.get('https://example.org');
  assert.equal(calls, 2, 'negative cache expires');
} finally { Date.now = originalNow; }
let release;
const barrier = new Promise(resolve => { release = resolve; });
const bounded = new LinkIcons(async () => { await barrier; return new Response(png); });
const active = Array.from({ length: 8 }, (_, i) => bounded.get(`https://site${i}.org`));
assert.equal(await bounded.get('https://overflow.org'), null, 'bounded upstream concurrency');
release(); await Promise.all(active);

const app = Fastify();
let upstream = 0;
registerLinkIconRoutes(app, {
  requireAuth(request, reply) { if (request.headers.authorization === 'Bearer test') return { id: 'test' }; reply.code(401).send(); return null; },
  checkOrigin(request, reply) { if (!request.headers.origin || request.headers.origin === 'https://app.example.org') return true; reply.code(403).send(); return false; },
  fetch: async () => { upstream++; return new Response(png); },
});
try {
  const url = '/api/v1/link-icons?origin=https%3A%2F%2Fgithub.com';
  assert.equal((await app.inject({ url })).statusCode, 401);
  const headers = { authorization: 'Bearer test' };
  assert.equal((await app.inject({ url, headers: { ...headers, origin: 'https://evil.example.org' } })).statusCode, 403);
  assert.equal(upstream, 0);
  for (const origin of ['http://127.0.0.1', 'https://github.com/path?token=secret', '127.0.0.1', 'https://example.org:8080']) {
    assert.equal((await app.inject({ url: `/api/v1/link-icons?origin=${encodeURIComponent(origin)}`, headers })).statusCode, 204);
  }
  assert.equal(upstream, 0);
  const response = await app.inject({ url, headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['content-type'], 'image/png');
  assert.equal(response.headers['cache-control'], 'private, max-age=86400');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.deepEqual(response.rawPayload, png);
  await app.inject({ url, headers });
  assert.equal(upstream, 1);
} finally { await app.close(); }
console.log('Link chips: presentation, local/file exclusions, bundled brands, origin privacy, redirect/DNS safety, binary validation, bounds, deduplication, cache and route authorization passed.');
