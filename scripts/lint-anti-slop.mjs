/**
 * Anti-slop ratchet gate (X-style guardrail against agent-produced patterns).
 *
 * Three patterns are gated: chained type assertions (`as unknown as T` /
 * `as T as U`), `as any`, and conditional spreads of empty objects
 * (`{...(cond ? {k:v} : {})}`). Existing occurrences are legacy debt; the
 * gate only rejects NEW ones. When a fix lowers a count, commit the new
 * (lower) baseline together with the fix — the ratchet only tightens.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repository = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const roots = ['apps/web/src', 'apps/api/src'];
for (const entry of fs.readdirSync(path.join(repository, 'packages'))) {
  const source = path.join('packages', entry, 'src');
  if (fs.existsSync(path.join(repository, source))) roots.push(source);
}

const patterns = [
  { name: 'chained-type-assertion', regex: /\bas\s+(?:unknown|[A-Z][A-Za-z0-9_.]*)(?:<[^>]*>)?(?:\[\])?\s+as\s/, baseline: 102 },
  { name: 'as-any', regex: /\bas\s+any\b/, baseline: 148 },
  { name: 'empty-object-conditional-spread', regex: /\{\s*\.\.\.\(.+\?.+:\s*\{\}\s*\)\s*\}/, baseline: 11 },
];

const walk = (directory, files = []) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else if (/\.(ts|tsx)$/u.test(entry.name)) files.push(full);
  }
  return files;
};

const files = roots.flatMap((root) => walk(path.join(repository, root)));
const violations = new Map(patterns.map((pattern) => [pattern.name, []]));
for (const file of files) {
  const text = fs.readFileSync(file, 'utf8');
  const lines = text.split('\n');
  for (const pattern of patterns) {
    lines.forEach((line, index) => {
      if (pattern.regex.test(line)) violations.get(pattern.name).push(`${path.relative(repository, file)}:${index + 1}`);
    });
  }
}

let failed = false;
for (const pattern of patterns) {
  const found = violations.get(pattern.name);
  if (found.length > pattern.baseline) {
    failed = true;
    console.error(`✗ ${pattern.name}: ${found.length} 处（基线 ${pattern.baseline}）— 新增了反模式，请改为显式类型/校验：`);
    for (const location of found.slice(0, 10)) console.error(`    ${location}`);
    if (found.length > 10) console.error(`    …共 ${found.length} 处`);
  } else if (found.length < pattern.baseline) {
    console.log(`↘ ${pattern.name}: ${found.length} 处（基线 ${pattern.baseline}）— 请顺手把 scripts/lint-anti-slop.mjs 里的基线降到 ${found.length}`);
  } else {
    console.log(`✓ ${pattern.name}: ${found.length}/${pattern.baseline}`);
  }
}
if (failed) process.exit(1);
console.log(`anti-slop ratchet: pass（${files.length} 个源文件）`);
