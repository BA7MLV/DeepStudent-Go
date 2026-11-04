import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// No installs or writes to the checkout/node_modules. Downloads and optional
// reconstruction live in a new scratch directory. This is not a security waiver.
const reference = 'f3803c96974ad4a94195fb97e5c637e9c2a3afe3';
const releaseTag = 'dsh-v0.2.2-alpha.2';
const previousReference = 'ce7073d51254c26cd63b22a60835b8f948deb447';
const args = process.argv.slice(2);
const output = args.shift();
if (!output) throw new Error('Usage: node scripts/audit-client-runtime-upstream.mjs OUTPUT [--rebuild-tools NODE_MODULES] [--audit-json NPM_AUDIT_JSON]');
const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const project = process.cwd();
const lockBytes = fs.readFileSync('package-lock.json');
const lock = JSON.parse(lockBytes);
const tempRoot = path.join(os.tmpdir(), 'opencode');
fs.mkdirSync(tempRoot, { recursive: true });
const scratch = fs.realpathSync(fs.mkdtempSync(path.join(tempRoot, 'dsh-provenance-')));
const cache = option('--cache-dir');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const walk = directory => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  if (entry.name === 'node_modules') return [];
  const file = path.join(directory, entry.name);
  return entry.isDirectory() ? walk(file) : entry.isFile() ? [file] : [];
}) : [];
const get = async url => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return Buffer.from(await response.arrayBuffer());
};
const archiveUrl = `https://codeload.github.com/deepseek-ai/deepseek-harness/tar.gz/${reference}`;
const archive = cache ? fs.readFileSync(path.join(cache, 'source.tgz')) : await get(archiveUrl);
if (hash(archive) !== '798cab9a2acbc886a40ad9f7916e52f9380fbd4b51b41f685f3ed681f77e0ccb') throw new Error('Fixed source archive digest changed; review instead of silently accepting it');
fs.writeFileSync(path.join(scratch, 'source.tgz'), archive);
execFileSync('tar', ['-xzf', path.join(scratch, 'source.tgz'), '-C', scratch]);
const sourceRoot = path.join(scratch, `deepseek-harness-${reference}`);
const sourceJson = file => JSON.parse(fs.readFileSync(path.join(sourceRoot, file), 'utf8'));
const installed = Object.entries(lock.packages).filter(([key]) => /^node_modules\/@deepseek-ai\/[^/]+$/.test(key));
const manifests = new Map(installed.map(([directory]) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  return [manifest.name, manifest];
}));
const versions = new Map([...manifests].map(([name, pkg]) => [name, pkg.version]));
for (const dir of ['include', 'loader']) {
  const pkg = sourceJson(`vendor/${dir}/package.json`);
  versions.set(pkg.name, pkg.version);
}
const normalize = value => {
  value = structuredClone(value);
  delete value.devDependencies;
  if (typeof value.bin === 'string') value.bin = { [value.name.split('/').at(-1)]: value.bin };
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(value[field] ?? {})) {
      if (!spec.startsWith('workspace:')) continue;
      const suffix = spec.slice(10);
      if (!versions.has(name)) throw new Error(`Unresolved workspace dependency ${name}`);
      value[field][name] = suffix === '*' ? versions.get(name) : ['~', '^'].includes(suffix) ? suffix + versions.get(name) : suffix;
    }
  }
  return value;
};
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, sorted(v)])) : value;
const equal = (a, b) => JSON.stringify(sorted(a)) === JSON.stringify(sorted(b));
const legal = directory => walk(directory).filter(file => /^(licen[cs]e|notice|copying|copyright)([.\-_]|$)|third.*notice/i.test(path.basename(file)))
  .map(file => ({ path: path.relative(directory, file), sha256: hash(fs.readFileSync(file)), text: fs.readFileSync(file, 'utf8') }));
const report = { reference, releaseTag, previousReference, checkedAt: new Date().toISOString(), scratch,
  lockSha256: hash(lockBytes),
  archive: { url: archiveUrl, sha256: hash(archive) },
  limitation: 'Tarball identity, source content, reconstruction and security are separate gates. A missing reconstruction is unknown, never a pass. Only //#region path comments may be ignored in reconstruction.',
  sourceNotices: ['LICENSE', 'THIRD_PARTY_NOTICES.md', 'vendor/README.md'].map(file => ({ path: file, sha256: hash(fs.readFileSync(path.join(sourceRoot, file))) })),
  packages: [], closure: [], embedded: [], missingEdges: [] };
for (const [directory, pinned] of installed) {
  const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const entry = { name: manifest.name, version: manifest.version, sourceDirectory: manifest.repository.directory,
    integrity: pinned.integrity, license: manifest.license, legal: legal(directory) };
  report.packages.push(entry);
  try {
    const original = sourceJson(`${entry.sourceDirectory}/package.json`);
    entry.manifestMatches = equal(normalize(manifest), normalize(original));
    const sources = walk(path.join(directory, 'src'));
    entry.shippedSources = sources.map(file => {
      const relative = path.relative(directory, file);
      const expected = path.join(sourceRoot, entry.sourceDirectory, relative);
      return { path: relative, sha256: hash(fs.readFileSync(file)), matches: fs.existsSync(expected) && fs.readFileSync(file).equals(fs.readFileSync(expected)) };
    });
    const localSourceLicense = path.join(sourceRoot, entry.sourceDirectory, 'LICENSE');
    const sourceLicense = fs.existsSync(localSourceLicense) ? localSourceLicense : path.join(sourceRoot, 'LICENSE');
    entry.sourceLicensePath = path.relative(sourceRoot, sourceLicense);
    entry.sourceLicenseMatches = fs.existsSync(sourceLicense) && fs.existsSync(path.join(directory, 'LICENSE'))
      && fs.readFileSync(sourceLicense).equals(fs.readFileSync(path.join(directory, 'LICENSE')));
    const metadata = JSON.parse(await get(`https://registry.npmjs.org/${encodeURIComponent(manifest.name)}/${manifest.version}`));
    entry.registryIntegrityMatches = metadata.dist?.integrity === pinned.integrity;
    entry.gitHead = metadata.gitHead ?? null;
    entry.attestations = metadata.dist?.attestations ?? null;
    entry.tarball = metadata.dist.tarball;
    const cachedTarball = cache && path.join(cache, manifest.name.split('/').at(-1), 'package.tgz');
    const bytes = cachedTarball && fs.existsSync(cachedTarball) ? fs.readFileSync(cachedTarball) : await get(entry.tarball);
    const [algorithm, digest] = pinned.integrity.split('-');
    entry.tarballIntegrityMatches = crypto.createHash(algorithm).update(bytes).digest('base64') === digest;
    if (!entry.tarballIntegrityMatches) throw new Error('Tarball integrity mismatch; refusing extraction');
    const dir = path.join(scratch, manifest.name.split('/').at(-1));
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'package.tgz'), bytes);
    execFileSync('tar', ['-xzf', path.join(dir, 'package.tgz'), '-C', dir]);
    entry.tarballFiles = walk(path.join(dir, 'package')).map(file => {
      const relative = path.relative(path.join(dir, 'package'), file);
      const local = path.join(directory, relative);
      return { path: relative, sha256: hash(fs.readFileSync(file)), installedMatches: fs.existsSync(local) && fs.readFileSync(file).equals(fs.readFileSync(local)) };
    });
  } catch (error) { entry.error = error.message; }
}

// Resolve the installed dependency graph, including required peers and actual
// static-linked imports that npm metadata omits. Do not include dev workspaces.
const resolvePackage = (from, name) => {
  let current = path.resolve(from);
  while (true) {
    const candidate = path.join(current, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return path.relative(project, candidate).split(path.sep).join('/');
    const parent = path.dirname(current);
    if (current === parent || current === project) return null;
    current = parent;
  }
};
const queue = installed.map(([directory]) => directory);
report.consumerEdges = [];
if (fs.existsSync('packages/remote-artifacts/package.json')) {
  for (const [name, range] of Object.entries(JSON.parse(fs.readFileSync('packages/remote-artifacts/package.json')).dependencies ?? {})) {
    const directory = resolvePackage('packages/remote-artifacts', name);
    report.consumerEdges.push({ from: 'packages/remote-artifacts', name, range, directory });
    if (directory) queue.push(directory);
    else report.missingEdges.push({ from: 'packages/remote-artifacts', name, range });
  }
}
const seen = new Set();
while (queue.length) {
  const directory = queue.shift();
  if (seen.has(directory)) continue;
  seen.add(directory);
  const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json')));
  const entry = { directory, name: pkg.name, version: pkg.version, license: pkg.license,
    resolved: lock.packages[directory]?.resolved, integrity: lock.packages[directory]?.integrity, repository: pkg.repository, legal: legal(directory), edges: [] };
  report.closure.push(entry);
  const edges = new Map(Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies, ...pkg.optionalDependencies }));
  // Store is statically linked with all bare imports external; renderer embeds shim.
  if (pkg.name === '@deepseek-ai/dsh-client-store') for (const n of ['zustand', 'immer']) edges.set(n, 'published JS import (omitted from dependencies)');
  if (pkg.name === '@deepseek-ai/dsh-client-ui-renderer') for (const name of ['react', 'react-dom']) edges.set(name, 'factory require (omitted from dependencies)');
  for (const [name, range] of edges) {
    const target = resolvePackage(directory, name);
    const optional = !!pkg.peerDependenciesMeta?.[name]?.optional || name in (pkg.optionalDependencies ?? {});
    entry.edges.push({ name, range, directory: target, optional });
    if (target) queue.push(target);
    else if (!optional) report.missingEdges.push({ from: directory, name, range });
  }
}
// The renderer contains use-sync-external-store 1.6.0, independently of the
// application's installed version. Its retained @license comments name it;
// the reconstructed factory verifies its bytes, not just this declaration.
{
  const metadata = JSON.parse(await get('https://registry.npmjs.org/use-sync-external-store/1.6.0'));
  const bytes = await get(metadata.dist.tarball);
  const [algorithm, digest] = metadata.dist.integrity.split('-');
  if (crypto.createHash(algorithm).update(bytes).digest('base64') !== digest) throw new Error('Embedded shim tarball integrity mismatch');
  const dir = path.join(scratch, 'embedded-shim');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'package.tgz'), bytes);
  execFileSync('tar', ['-xzf', path.join(dir, 'package.tgz'), '-C', dir]);
  report.embedded.push({ name: metadata.name, version: metadata.version, license: metadata.license, tarball: metadata.dist.tarball,
    integrity: metadata.dist.integrity, owner: '@deepseek-ai/dsh-client-ui-renderer/lib/client.js', legal: legal(path.join(dir, 'package')), directory: path.join(dir, 'package') });
  report.embedded.push({ name: '@deepseek-ai/dsh-util-crypto', version: sourceJson('packages/util/crypto/package.json').version,
    license: 'MIT', sourceDirectory: 'packages/util/crypto', owner: '@deepseek-ai/dsh-api-gateway/client', legal: legal(sourceRoot).filter(file => file.path === 'LICENSE') });
}
const auditFile = option('--audit-json');
if (auditFile) {
  const audit = JSON.parse(fs.readFileSync(auditFile));
  report.security = { inputSha256: hash(fs.readFileSync(auditFile)), affected: Object.values(audit.vulnerabilities ?? {})
    .filter(v => v.nodes?.some(node => seen.has(node))).map(v => ({ ...v, nodes: v.nodes.filter(node => seen.has(node)) })) };
}

async function reconstruct(toolsDirectory) {
  const tools = path.resolve(toolsDirectory);
  const buildRoot = path.join(scratch, 'rebuild');
  fs.cpSync(sourceRoot, buildRoot, { recursive: true });
  const ts = (await import(pathToFileURL(path.join(tools, 'typescript/lib/typescript.js')))).default;
  const { build } = await import(pathToFileURL(path.join(tools, 'tsdown/dist/index.mjs')));
  const resolvedRolldown = JSON.parse(fs.readFileSync(createRequire(path.join(tools, 'tsdown/package.json')).resolve('rolldown/package.json'))).version;
  if (ts.version !== '6.0.3' || resolvedRolldown !== '1.1.1') throw new Error(`Use TypeScript 6.0.3 and tsdown's actual Rolldown 1.1.1, got ${ts.version}/${resolvedRolldown}`);
  const buildPackages = [...manifests.values(), sourceJson('packages/util/crypto/package.json')];
  fs.mkdirSync(path.join(buildRoot, 'node_modules/@deepseek-ai'), { recursive: true });
  for (const name of fs.readdirSync(tools)) {
    if (name === '@deepseek-ai' || name === '.bin') continue;
    fs.symlinkSync(path.join(tools, name), path.join(buildRoot, 'node_modules', name));
  }
  for (const name of ['react', 'react-dom', 'ws', 'zod', 'zustand', '@standard-schema', '@jridgewell']) {
    const destination = path.join(buildRoot, 'node_modules', name);
    if (!fs.existsSync(destination)) fs.symlinkSync(path.join(project, 'node_modules', name), destination);
  }
  // Exact embedded source, not the application's possibly newer shim.
  const shimTarget = path.join(buildRoot, 'node_modules/use-sync-external-store');
  if (fs.lstatSync(shimTarget, { throwIfNoEntry: false })) fs.unlinkSync(shimTarget);
  fs.symlinkSync(report.embedded.find(pkg => pkg.name === 'use-sync-external-store').directory, shimTarget);
  const allSources = [];
  for (const pkg of buildPackages) {
    const dir = path.join(buildRoot, pkg.repository.directory);
    fs.symlinkSync(dir, path.join(buildRoot, 'node_modules', pkg.name));
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
    allSources.push(...walk(path.join(dir, 'src')).filter(file => /\.tsx?$/.test(file) && !file.endsWith('.d.ts')));
  }
  const config = ts.readConfigFile(path.join(buildRoot, 'tsconfig.base.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, buildRoot);
  const program = ts.createProgram(allSources, { ...parsed.options, jsx: ts.JsxEmit.ReactJSX, rootDir: buildRoot, outDir: buildRoot,
    composite: false, incremental: false, declaration: false, declarationMap: false, noEmitOnError: false });
  program.emit(undefined, (file, data, _bom, _errors, sources) => {
    const source = sources?.[0]?.fileName;
    if (!source || !allSources.includes(source)) return;
    const pkg = buildPackages.find(pkg => source.startsWith(path.join(buildRoot, pkg.repository.directory, 'src') + path.sep));
    const destination = path.join(buildRoot, pkg.repository.directory, 'lib/types', path.relative(path.join(buildRoot, pkg.repository.directory, 'src'), source).replace(/\.tsx?$/, file.endsWith('.map') ? '.js.map' : '.js'));
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    if (destination.endsWith('.map')) {
      const map = JSON.parse(data);
      map.sources = [path.relative(path.dirname(destination), source)];
      map.sourcesContent = [fs.readFileSync(source, 'utf8')];
      data = JSON.stringify(map);
    }
    fs.writeFileSync(destination, data);
  });
  // util-crypto is inlined into Gateway browser/Node-client artifacts.
  const first = ['@deepseek-ai/cosmokit', '@deepseek-ai/schemastery', '@deepseek-ai/cordis', '@deepseek-ai/dsh-brand', '@deepseek-ai/dsh-deque', '@deepseek-ai/dsh-timeout', '@deepseek-ai/dsh-typert-protocol', '@deepseek-ai/dsh-util-crypto'];
  const ordered = [...first.map(name => buildPackages.find(pkg => pkg.name === name)), ...buildPackages.filter(pkg => !first.includes(pkg.name))];
  for (const pkg of ordered) {
    const dir = path.join(buildRoot, pkg.repository.directory);
    process.chdir(dir);
    const file = path.join(dir, 'tsdown.config.ts');
    let configs = fs.existsSync(file) ? (await import(pathToFileURL(file))).default : {
      entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false };
    if (typeof configs === 'function') configs = configs({ env: { DSH_BUILD_FACE: 'client' } });
    for (const config of Array.isArray(configs) ? configs : [configs]) await build({ ...config, config: false, workspace: false, cwd: dir });
  }
  process.chdir(project);
  // Only strip bundler region *path comments*, never executable text or licenses.
  const canonical = text => text.replace(/^([\t ]*\/\/#region ).*$/gm, '$1<path>');
  for (const entry of report.packages) {
    entry.reconstruction = (entry.tarballFiles ?? []).filter(file => /\.(js|mjs|cjs)$/.test(file.path)).map(file => {
      const original = fs.readFileSync(path.join(project, 'node_modules', entry.name, file.path));
      const rebuilt = path.join(buildRoot, entry.sourceDirectory, file.path);
      const bytes = fs.existsSync(rebuilt) ? fs.readFileSync(rebuilt) : null;
      return { path: file.path, originalSha256: hash(original), rebuiltSha256: bytes && hash(bytes),
        byteEqual: bytes !== null && original.equals(bytes), regionPathCommentOnly: bytes !== null && !original.equals(bytes) && canonical(original.toString()) === canonical(bytes.toString()) };
    });
  }
  report.reconstruction = { buildRoot, tools, typescript: ts.version, tsdown: JSON.parse(fs.readFileSync(path.join(tools, 'tsdown/package.json'))).version,
    rolldown: resolvedRolldown,
    limitation: 'Content reconstruction, not an upstream signed build attestation or full upstream typecheck. Compiler diagnostics are not a release gate here. Configs and source are the fixed archive; manifests are the verified published production-dependency projection.' };
}
if (option('--rebuild-tools')) {
  try { await reconstruct(option('--rebuild-tools')); }
  catch (error) { process.chdir(project); report.reconstructionError = error.stack; }
}
const protocolCopy = 'packages/dsh-typert-protocol-source/src';
if (fs.existsSync(protocolCopy)) report.buildOnlyProtocolCopy = walk(protocolCopy).map(file => {
  const relative = path.relative(protocolCopy, file);
  const expected = path.join(sourceRoot, 'packages/typert/protocol/src', relative);
  return { path: relative, sha256: hash(fs.readFileSync(file)), matches: fs.existsSync(expected) && fs.readFileSync(file).equals(fs.readFileSync(expected)) };
});
report.summary = {
  packageCount: report.packages.length,
  identityAndSources: report.packages.every(p => !p.error && p.manifestMatches && p.registryIntegrityMatches && p.tarballIntegrityMatches && p.sourceLicenseMatches && p.shippedSources.every(f => f.matches) && p.tarballFiles.every(f => f.installedMatches)),
  reconstruction: report.reconstructionError ? false : report.reconstruction ? report.packages.every(p => p.reconstruction?.length && p.reconstruction.every(f => f.byteEqual || f.regionPathCommentOnly)) : null,
  closureLegalFiles: [...report.closure, ...report.embedded].every(p => p.legal.length > 0),
  missingEdges: report.missingEdges.length,
  closureSecurityEntries: report.security?.affected.length ?? null,
  buildOnlyProtocolCopy: report.buildOnlyProtocolCopy?.every(file => file.matches) ?? null,
};
fs.writeFileSync(path.resolve(project, output), `${JSON.stringify(report, null, 2)}\n`);
const notices = new Map();
for (const pkg of [...report.closure, ...report.embedded]) for (const file of pkg.legal) {
  const existing = notices.get(file.sha256) ?? { owners: [], text: file.text };
  existing.owners.push(`${pkg.name}@${pkg.version}: ${file.path}`);
  notices.set(file.sha256, existing);
}
fs.writeFileSync(path.resolve(project, `${output}.licenses.txt`), [...notices.values()].map(item => `${item.owners.join('\n')}\n\n${item.text}`).join('\n\n---\n\n'));
console.log(JSON.stringify({ ...report.summary, output, scratch }, null, 2));
// Exit 1 for genuine unresolved gates. Omitting reconstruction cannot turn this green.
if (!report.summary.identityAndSources || report.summary.reconstruction !== true || !report.summary.closureLegalFiles || report.summary.buildOnlyProtocolCopy === false || report.summary.missingEdges || report.security?.affected.length) process.exitCode = 1;
