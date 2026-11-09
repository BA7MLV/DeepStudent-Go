import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../src/i18n/locales/', import.meta.url);

function flatten(value, prefix = '', result = {}) {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value), `Invalid namespace: ${prefix}`);
  for (const [key, entry] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof entry === 'string') {
      assert.ok(entry.trim(), `Empty translation: ${path}`);
      result[path] = entry;
    } else flatten(entry, path, result);
  }
  return result;
}

const pluralSuffix = /_(zero|one|two|few|many|other)$/;
const semanticKey = key => key.replace(pluralSuffix, '');
const parameters = value => [...value.matchAll(/\{\{\s*-?\s*([^},\s]+)[^}]*\}\}/g)].map(m => m[1]).sort();
const read = async (locale, file) => flatten(JSON.parse(await readFile(new URL(`${locale}/${file}`, root), 'utf8')));
const namespaces = (await readdir(new URL('zh-CN/', root))).filter(file => file.endsWith('.json')).sort();

for (const locale of ['zh-CN', 'en-US']) {
  const files = (await readdir(new URL(`${locale}/`, root))).filter(file => file.endsWith('.json')).sort();
  assert.deepEqual(files, namespaces, `${locale}: namespace mismatch`);
  for (const file of namespaces) {
    const base = await read('zh-CN', file);
    const target = await read(locale, file);
    const keys = value => [...new Set(Object.keys(value).map(semanticKey))].sort();
    assert.deepEqual(keys(target), keys(base), `${locale}/${file}: missing or extra semantic keys`);
    for (const [key, text] of Object.entries(target)) {
      const baseKey = Object.keys(base).find(candidate => semanticKey(candidate) === semanticKey(key));
      assert.deepEqual(parameters(text), parameters(base[baseKey]), `${locale}/${file}:${key}: interpolation mismatch`);
    }
    // 英文 one/other 与中文 other 的原始键集合不同，但每种语言都必须覆盖自己的复数规则。
    for (const key of keys(target)) {
      if (!Object.keys(target).some(candidate => pluralSuffix.test(candidate) && semanticKey(candidate) === key)) continue;
      for (const category of new Intl.PluralRules(locale).resolvedOptions().pluralCategories) {
        assert.ok(`${key}_${category}` in target, `${locale}/${file}: missing plural ${key}_${category}`);
      }
    }
  }
}
console.log(`i18n resources OK: ${namespaces.length} namespaces × 2 languages (${fileURLToPath(root)})`);

/*
 * 硬编码中文棘轮：扫描 src 里的字符串字面量与 JSX 属性中的 CJK 字符，按文件与
 * src/i18n/cjk-baseline.json 的基线比对。基线只允许向下改——新增硬编码中文会直接失败；
 * 迁移一批后请把对应文件的数字调小（清零的条目直接删除）。
 * 中文注释不在引号里，不会被计入。
 */
const cjk = /[\u{3400}-\u{4dbf}\u{4e00}-\u{9fff}\u{f900}-\u{faff}]/u;
const quoted = /(["'`])(?:\\.|(?!\1)[^\\\n])*?\1/g;
const srcRoot = new URL('../src/', import.meta.url);
const baselineUrl = new URL('../src/i18n/cjk-baseline.json', import.meta.url);
const skip = dir => dir.pathname.includes('/src/i18n/') || dir.pathname.endsWith('.test.') || dir.pathname.includes('/third-party/');
const files = [];
const walk = async dir => {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const next = new URL(`${entry.name}/`, dir);
    if (entry.isDirectory()) { if (!skip(next)) await walk(next); continue; }
    if (/\.[cm]?[jt]sx?$/.test(entry.name) && !skip(dir)) files.push(new URL(entry.name, dir));
  }
};
await walk(srcRoot);
const baseline = JSON.parse(await readFile(baselineUrl, 'utf8'));
let violations = 0;
const entries = [];
for (const file of files) {
  const relative = decodeURIComponent(file.pathname.split('/src/')[1]);
  const text = await readFile(file, 'utf8');
  let count = 0;
  for (const match of text.matchAll(quoted)) if (cjk.test(match[0])) count += 1;
  // JSX 属性采用 {...} 形式时不算字面量；裸属性值已包含在上面的引号匹配里。
  entries.push([relative, count]);
  const allowed = baseline[relative] ?? 0;
  if (count > allowed) { violations += 1; console.error(`cjk-baseline: ${relative} has ${count} hardcoded CJK strings, baseline allows ${allowed}. Migrate them to locale files or raise the number only if this is not user-facing.`); }
}
entries.sort((a, b) => b[1] - a[1]);
console.log(`cjk strings under src: ${entries.reduce((sum, [, count]) => sum + count, 0)} across ${files.length} files (ratchet vs src/i18n/cjk-baseline.json)`);
if (violations > 0) { console.error(`${violations} file(s) exceed the CJK baseline`); process.exitCode = 1; }
