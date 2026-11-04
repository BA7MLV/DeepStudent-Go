import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// Offline packaging of the audited DSH closure, not a whole-product license scan.
const root = path.resolve(import.meta.dirname, '..');
const directory = path.join(root, 'licenses/client-runtime');
const bundlePath = path.join(directory, 'THIRD_PARTY_NOTICES.txt');
const manifestPath = path.join(directory, 'provenance.json');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const args = process.argv.slice(2);
if (args[0] === '--refresh') {
  const reportBytes = fs.readFileSync(path.resolve(args[1]));
  const report = JSON.parse(reportBytes);
  const s = report.summary;
  if (!s.identityAndSources || s.reconstruction !== true || !s.closureLegalFiles
    || s.buildOnlyProtocolCopy !== true || s.missingEdges || s.closureSecurityEntries !== 0
    || report.reference !== 'f3803c96974ad4a94195fb97e5c637e9c2a3afe3') throw new Error('Audit gates must pass before refreshing notices');
  if (hash(fs.readFileSync(path.join(root, 'package-lock.json'))) !== report.lockSha256) throw new Error('Audit lock is stale');
  const notices = new Map();
  for (const pkg of [...report.closure, ...report.embedded]) for (const file of pkg.legal) {
    if (hash(file.text) !== file.sha256) throw new Error('Legal text hash mismatch');
    const item = notices.get(file.sha256) ?? { owners: [], text: file.text };
    item.owners.push(`${pkg.name}@${pkg.version}: ${file.path}`);
    notices.set(file.sha256, item);
  }
  const bundle = 'DSH client-runtime dependency notices\nIncludes build-time generator notices; not a license inventory of the entire application.\n\n'
    + [...notices.values()].map(item => `${item.owners.join('\n')}\n\n${item.text}`).join('\n\n---\n\n');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(bundlePath, bundle);
  fs.writeFileSync(manifestPath, JSON.stringify({ reference: report.reference, releaseTag: report.releaseTag,
    archive: report.archive, auditSha256: hash(reportBytes), auditedLockSha256: report.lockSha256,
    noticesSha256: hash(bundle), summary: s,
    packages: report.closure.map(({ directory, name, version, integrity }) => ({ directory, name, version, integrity })),
    embedded: report.embedded.map(({ name, version, legal }) => ({ name, version, legal: legal.map(({ path, sha256 }) => ({ path, sha256 })) })),
  }, null, 2) + '\n');
} else {
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const bundle = fs.readFileSync(bundlePath);
  if (hash(bundle) !== manifest.noticesSha256) throw new Error('Notices changed without audited refresh');
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json')));
  // Pruned Docker locks legitimately omit Web/build-only dependencies.
  for (const pkg of manifest.packages) {
    const entry = lock.packages[pkg.directory];
    if (entry && (entry.version !== pkg.version || entry.integrity !== pkg.integrity)) throw new Error(`Stale notices: ${pkg.directory}`);
  }
  for (const [directory, entry] of Object.entries(lock.packages)) {
    if (!/node_modules\/(?:@deepseek-ai\/[^/]+|zod)$/.test(directory)) continue;
    if (!manifest.packages.some(pkg => pkg.directory === directory && pkg.version === entry.version && pkg.integrity === entry.integrity)) throw new Error(`Unaudited runtime dependency: ${directory}`);
  }
  if (args[0] !== '--check') {
    if (!args.length) throw new Error('Usage: build-client-runtime-licenses.mjs OUTPUT_DIR... | --check | --refresh AUDIT_JSON');
    for (const destination of args) {
      const output = path.resolve(destination);
      fs.mkdirSync(output, { recursive: true });
      fs.copyFileSync(bundlePath, path.join(output, 'THIRD_PARTY_NOTICES.txt'));
      fs.copyFileSync(manifestPath, path.join(output, 'client-runtime-provenance.json'));
    }
  }
}
console.log('Client-runtime notices verified' + (args[0] === '--check' ? '' : ' and packaged'));
