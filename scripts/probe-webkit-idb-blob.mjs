/** Isolated platform diagnostic: no application modules or server database. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createRequire } from 'node:module';
import { chromium, webkit } from 'playwright';

const directory = fs.mkdtempSync('/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/idb-blob-probe-');
const require = createRequire(import.meta.url);
const isolatedTemp = path.join(directory, 'tmp');
fs.mkdirSync(isolatedTemp, { mode: 0o700 });
const writable = file => {
  const stat = fs.statSync(file), probe = path.join(file, `write-probe-${process.pid}`);
  fs.writeFileSync(probe, 'test', { flag: 'wx' });
  const read = fs.readFileSync(probe, 'utf8'); fs.unlinkSync(probe);
  return { path: file, realpath: fs.realpathSync(file), mode: (stat.mode & 0o777).toString(8), uid: stat.uid, writable: read === 'test' };
};
const metadata = { node: process.version, platform: os.platform(), release: os.release(), arch: os.arch(),
  playwright: require('playwright/package.json').version, executable: webkit.executablePath(),
  executableRealpath: fs.realpathSync(webkit.executablePath()),
  manifest: JSON.parse(fs.readFileSync(path.join(path.dirname(require.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8')),
  directories: [os.tmpdir(), directory, isolatedTemp].map(writable) };
const results = {};
const scenarios = process.env.IDB_PROBE_MATRIX ? [
  { name: 'chromium', engine: chromium }, { name: 'webkit', engine: webkit },
  { name: 'webkit-isolated-temp', engine: webkit, isolated: true },
  { name: 'webkit-persistent', engine: webkit, persistent: true, isolated: true },
  ...(process.env.IDB_PROBE_EXECUTABLE ? [{ name: 'webkit-existing-alternate', engine: webkit, persistent: true, isolated: true, executablePath: process.env.IDB_PROBE_EXECUTABLE }] : []),
] : [{ name: 'chromium', engine: chromium }, { name: 'webkit', engine: webkit }];
for (const { name, engine, persistent, isolated, executablePath } of scenarios) {
  let browser, context;
  try {
    const options = { headless: true, ...(executablePath ? { executablePath } : {}), ...(isolated ? { env: { ...process.env, TMPDIR: isolatedTemp } } : {}) };
    if (persistent) {
      const profile = path.join(directory, name); fs.mkdirSync(profile, { mode: 0o700 });
      metadata.directories.push(writable(profile));
      context = await engine.launchPersistentContext(profile, options);
    } else { browser = await engine.launch(options); context = await browser.newContext(); }
    const page = await context.newPage();
    const logs = [];
    page.on('console', message => logs.push({ kind: message.type(), text: message.text() }));
    page.on('pageerror', error => logs.push({ kind: 'pageerror', text: error.message }));
    await page.route('http://127.0.0.1/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Native IndexedDB Blob probe</title>' }));
    await page.goto('http://127.0.0.1/native-idb-probe');
    results[name] = await page.evaluate(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('native-blob-probe', 1);
        request.onupgradeneeded = () => request.result.createObjectStore('bytes');
        request.onerror = () => reject(request.error); request.onsuccess = () => resolve(request.result);
      });
      const roundtrip = async (key, value) => {
        await new Promise((resolve, reject) => {
          const transaction = database.transaction('bytes', 'readwrite');
          transaction.objectStore('bytes').put(value, key);
          transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
        });
        return new Promise((resolve, reject) => {
          const request = database.transaction('bytes').objectStore('bytes').get(key);
          request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
        });
      };
      try {
        const string = await roundtrip('control-string', 'string-control');
        const bytes = Array.from(new Uint8Array(await roundtrip('control-bytes', new Uint8Array([1, 2, 3]).buffer)));
        try {
          const blob = await roundtrip('original', new Blob(['test']));
          const file = await roundtrip('file', new File(['file-test'], 'test.txt', { type: 'text/plain' }));
          return { stored: true, text: await blob.text(), fileText: await file.text(), string, bytes, userAgent: navigator.userAgent };
        } catch (error) { return { stored: false, name: error.name, message: error.message, string, bytes, userAgent: navigator.userAgent }; }
      } catch (error) { return { stored: false, controlFailure: true, name: error.name, message: error.message }; }
      finally { database.close(); }
    });
    results[name].version = (browser ?? context.browser()).version();
    results[name].logs = logs;
  } catch (error) { results[name] = { stored: false, launchError: error.message }; }
  finally { await context?.close(); await browser?.close(); }
}
fs.writeFileSync(path.join(directory, 'evidence.json'), JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(directory, 'environment.json'), JSON.stringify(metadata, null, 2));
console.log(JSON.stringify({ directory, results }, null, 2));
// The matrix deliberately retains the private-session failure as a control.
const required = process.env.IDB_PROBE_MATRIX ? ['chromium', 'webkit-persistent'] : ['chromium', 'webkit'];
if (required.some(name => !results[name]?.stored || results[name].text !== 'test')) process.exitCode = 1;
