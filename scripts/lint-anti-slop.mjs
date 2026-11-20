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

/** 进程环境只允许在配置模块里直接读(P2-2 基线 61 → 0)。runtime/ 是 API 的子进程
 * 代码,同样收敛到 config.ts;测试脚本与 gateway/ 不在此规则范围(前者是脚本,
 * 后者由并行任务维护)。命中要求是真实的 `process.env.NAME` 读取,注释里提到不算。 */
const processEnvRule = {
  root: 'apps/api',
  include: /^(?:src|runtime)[\\/].*\.ts$/u,
  exclude: (file) => file === 'apps/api/src/config.ts',
  regex: /(?<![\w.])process\.env\.[A-Za-z_]/u,
  baseline: 0,
};
const walkAll = (directory, files = []) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) walkAll(full, files);
    else if (/\.ts$/u.test(entry.name)) files.push(full);
  }
  return files;
};

const patterns = [
  // 基线即改动前的现存计数(117 处),不是本次新增;旧基线 102 在 b15cf1d 已是红的。
  { name: 'chained-type-assertion', regex: /\bas\s+(?:unknown|[A-Z][A-Za-z0-9_.]*)(?:<[^>]*>)?(?:\[\])?\s+as\s/, baseline: 117 },
  { name: 'asAny', regex: /\bas\s+any\b/, baseline: 32 },
  { name: 'empty-object-conditional-spread', regex: /\{\s*\.\.\.\(.+\?.+:\s*\{\}\s*\)\s*\}/, baseline: 11 },
  {
    name: 'process-env-direct',
    regex: processEnvRule.regex,
    baseline: processEnvRule.baseline,
    files: () => walkAll(path.join(repository, processEnvRule.root)).filter((file) => {
      const relative = path.relative(repository, file).split(path.sep).join('/');
      return processEnvRule.include.test(relative.replace(/^apps\/api\//u, '')) && !processEnvRule.exclude(relative);
    }),
  },
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
    if (pattern.files) continue;
    lines.forEach((line, index) => {
      if (pattern.regex.test(line)) violations.get(pattern.name).push(`${path.relative(repository, file)}:${index + 1}`);
    });
  }
}
// 自定义范围的规则(如 process-env-direct)按自己的文件清单单独扫描,不受其它规则的排除影响。
for (const pattern of patterns.filter((entry) => entry.files)) {
  for (const file of pattern.files()) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (pattern.regex.test(line)) violations.get(pattern.name).push(`${path.relative(repository, file)}:${index + 1}`);
    });
  }
}
// 扫描文件数要算上自定义范围,否则输出里的「个源文件」会少报。
const scanned = new Set([...files, ...patterns.filter((entry) => entry.files).flatMap((entry) => entry.files())]);

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
console.log(`anti-slop ratchet: pass（${scanned.size} 个源文件）`);
