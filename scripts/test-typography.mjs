import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import postcss from 'postcss';
import { updateOverflowTitle } from '../apps/web/src/ui/overflowTitle.ts';
import { formatSize } from '../apps/web/src/utils/format.ts';

test('overflow hints are conditional and remeasured after resize/content changes', () => {
  const el = { scrollWidth: 200, clientWidth: 100, scrollHeight: 20, clientHeight: 20,
    textContent: '完整名称', title: '', removeAttribute(name) { delete this[name]; } };
  updateOverflowTitle({ currentTarget: el });
  assert.equal(el.title, '完整名称');
  el.clientWidth = 220;
  updateOverflowTitle({ currentTarget: el });
  assert.equal(el.title, undefined);
  el.scrollHeight = 60;
  el.textContent = '多行截断后的完整名称';
  updateOverflowTitle({ currentTarget: el });
  assert.equal(el.title, el.textContent);
  el.scrollHeight = 20;
  el.scrollWidth = 220;
  updateOverflowTitle({ currentTarget: el });
  assert.equal(el.title, undefined, 'equal widths are not truncation');
});

test('file size values stay attached to units without changing visible copy', () => {
  assert.equal(formatSize(1024), '1\u00a0KB');
  assert.equal(formatSize(1024 ** 2), '1.0\u00a0MB');
  assert.equal(formatSize(1024 ** 3), '1.0\u00a0GB');
});

test('global text enhancements change text properties only and remain overridable', async () => {
  const ast = postcss.parse(await readFile('apps/web/src/theme.css', 'utf8'));
  const base = ast.nodes.find(node => node.type === 'atrule' && node.name === 'layer' && node.params === 'base');
  assert.ok(base);
  const allowed = new Set(['text-wrap', 'font-variant-numeric', 'white-space', 'text-autospace', 'text-spacing-trim']);
  base.walkDecls(decl => {
    assert.ok(allowed.has(decl.prop), `${decl.prop} is not a text-only enhancement`);
    assert.equal(decl.important, undefined);
    if (decl.prop === 'text-autospace' && decl.value === 'normal') {
      assert.match(decl.parent.selector, /:lang\(zh\)/);
      assert.match(decl.parent.selector, /\.x-markdown/);
    }
    if (decl.prop === 'text-spacing-trim') assert.equal(decl.value, 'normal', 'no automatic punctuation compression');
    if (decl.prop === 'text-wrap') {
      assert.doesNotMatch(decl.parent.selector, /\b(?:h[1-6]|p|li|dd)\b(?=\s*[,\)])/);
      assert.match(decl.parent.selector, /\.(?:card__|modal__|empty-state__|ui-field__)/);
    }
  });
  assert.ok(base.nodes.some(node => node.selector?.includes('pre *') && node.selector.includes('.font-mono *')));
});

test('shared Markdown keeps one ordinary wrapping algorithm for stream and history', async () => {
  const ast = postcss.parse(await readFile('apps/web/src/components/markdown/markdown.css', 'utf8'));
  const rules = [];
  ast.walkDecls('text-wrap-style', decl => {
    assert.equal(decl.value, 'auto');
    rules.push(decl.parent.selector);
  });
  assert.ok(rules.includes('.x-markdown'));
  assert.ok(rules.some(selector => selector.includes('h1, h2') && selector.includes('.md-embedded-ui')));
  ast.walkDecls(decl => assert.ok(!['pretty', 'balance'].includes(decl.value)));
});

test('React-owned code blocks override the library without losing literal whitespace', async () => {
  const ast = postcss.parse(await readFile('apps/web/src/components/code-block.css', 'utf8'));
  const rule = ast.nodes.find(node => node.selector?.includes('.x-markdown .code-block__source code'));
  assert.ok(rule);
  const declarations = Object.fromEntries(rule.nodes.map(node => [node.prop, node.value]));
  assert.equal(declarations['white-space'], 'pre');
  assert.equal(declarations['overflow-wrap'], 'normal');
  assert.equal(declarations['word-break'], 'normal');
});

// These are deliberate source/identifier views, not natural-language prose.
const sourceBreakAll = {
  'components/ArtifactEditor.tsx': 2,
  'components/HtmlAnswer.tsx': 1,
  'components/WidgetBlock.tsx': 3,
  'cloud/BotSettings.tsx': 1,
  'cloud/GatewaySettings.tsx': 2,
};
async function sourceFiles(directory) {
  return (await Promise.all((await readdir(directory, { withFileTypes: true })).map(entry => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : /\.(?:css|tsx?|jsx?)$/.test(file) ? [file] : [];
  }))).flat();
}

test('natural-language UI does not force arbitrary word/line breaks', async () => {
  const root = path.resolve('apps/web/src');
  const actual = {};
  for (const file of await sourceFiles(root)) {
    const text = await readFile(file, 'utf8');
    assert.doesNotMatch(text, /line-break\s*:\s*anywhere|lineBreak\s*:\s*['"]anywhere/);
    assert.doesNotMatch(text, /word-break\s*:\s*break-all|wordBreak\s*:\s*['"]break-all/);
    const count = [...text.matchAll(/\bbreak-all\b/g)].length;
    if (count) actual[path.relative(root, file)] = count;
  }
  assert.deepEqual(actual, sourceBreakAll);
});
