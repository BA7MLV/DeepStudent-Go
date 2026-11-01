import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import postcss from 'postcss';

test('sidebar controls keep muted text and icons across interaction states', async () => {
  const css = postcss.parse(await readFile('apps/web/src/ui/layout.css', 'utf8'));
  const base = css.nodes.find(node => node.selector === '.sidebar-control');
  assert.ok(base.nodes.some(node => node.prop === 'color' && node.value === 'var(--muted)'));
  let states = 0;
  css.walkRules(rule => {
    if (!rule.selector.startsWith('.sidebar-control:')) return;
    states++;
    rule.walkDecls('color', decl => assert.equal(decl.value, 'var(--muted)', rule.selector));
  });
  assert.equal(states, 4, 'hover, selected, selected hover and pressed states are covered');
});

test('sidebar settings icon keeps its muted color on hover and press', async () => {
  const css = postcss.parse(await readFile('apps/web/src/components/sidebar-account.css', 'utf8'));
  let states = 0;
  css.walkRules(rule => {
    if (!rule.selector.startsWith('.sidebar-account__settings[data-testid]')) return;
    rule.walkDecls('color', decl => {
      states++;
      assert.equal(decl.value, 'var(--muted)', rule.selector);
    });
  });
  assert.equal(states, 2, 'default and interactive colors are covered');
});
