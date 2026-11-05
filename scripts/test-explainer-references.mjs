// Every runnable example in the 交互式讲解 references must pass the real
// show_widget validation and follow the progressive-rendering source order the
// skill teaches: <style> first, static first frame in markup, one <script> last.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateWidgetArgs } from '../packages/study-core/src/harness/widget.ts';

const dir = new URL('../packages/study-core/assets/builtin/interactive-explainer/references/', import.meta.url);
const runnable = {
  'explore.md': { libs: undefined, root: 'quadratic-explorer' },
  'stepper.md': { libs: undefined, root: 'binary-search-stepper' },
  'simulation.md': { libs: undefined, root: 'projectile-sim' },
  'manipulate.md': { libs: undefined, root: 'unit-circle' },
  'chart.md': { libs: ['chart.js'], root: 'interest-chart' },
  'practice.md': { libs: undefined, root: 'curve-practice' },
};

for (const [file, { libs, root }] of Object.entries(runnable)) {
  const text = fs.readFileSync(new URL(file, dir), 'utf8');
  const html = text.match(/```html\n([\s\S]*?)\n```/)?.[1];
  assert.ok(html, `${file}: missing runnable html block`);
  const checked = validateWidgetArgs({ format: 'html', code: html, ...(libs ? { libs } : {}) });
  assert.ok(checked.ok, `${file}: ${JSON.stringify(checked)}`);
  assert.ok(html.includes(`id="${root}"`), `${file}: unique root id`);

  // Progressive order: optional leading style, markup, then exactly one trailing script.
  const scripts = [...html.matchAll(/<script\b/g)];
  assert.equal(scripts.length, 1, `${file}: exactly one script`);
  assert.ok(/<\/script>\s*$/.test(html), `${file}: script is the last element`);
  const styleAt = html.indexOf('<style'), markupAt = html.search(/<(section|div)\b/);
  if (styleAt >= 0) assert.ok(styleAt < markupAt, `${file}: style precedes markup`);
  // Scoped CSS: every selector in the leading style block targets the root.
  const css = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? '';
  for (const rule of css.split('}').map((r) => r.split('{')[0].trim()).filter(Boolean))
    for (const selector of rule.split(',')) assert.ok(selector.trim().startsWith(`#${root}`), `${file}: unscoped selector ${selector}`);

  // Static first frame: markup carries sizes and default readouts before scripts run.
  const markup = html.slice(0, scripts[0].index);
  for (const svg of markup.match(/<svg\b[^>]*>/g) ?? [])
    assert.match(svg, /viewBox="[^"]+"/, `${file}: svg has a viewBox in markup`);
  for (const out of markup.match(/<output\b[^>]*>[^<]*<\/output>/g) ?? [])
    assert.ok(!/<output\b[^>]*><\/output>/.test(out), `${file}: <output> has a default value in markup`);
  assert.ok(!/100vh/.test(html), `${file}: no 100vh`);
  // Motion: no autoplay loops; animation only from requestAnimationFrame after a user action.
  assert.ok(!/setInterval\s*\(/.test(html), `${file}: no setInterval`);
}

// Simulation must honour the motion policy it documents.
const simulation = fs.readFileSync(new URL('simulation.md', dir), 'utf8');
for (const needle of ['prefers-reduced-motion', 'visibilitychange', 'IntersectionObserver', 'requestAnimationFrame'])
  assert.ok(simulation.includes(needle), `simulation.md: ${needle}`);
// Manipulation must be keyboard operable.
const manipulate = fs.readFileSync(new URL('manipulate.md', dir), 'utf8');
for (const needle of ['role="slider"', 'tabindex="0"', 'aria-valuetext', 'setPointerCapture', 'touch-action: none'])
  assert.ok(manipulate.includes(needle), `manipulate.md: ${needle}`);

console.log(`PASS: ${Object.keys(runnable).length} reference examples pass show_widget validation with progressive source order, scoped CSS, static first frames and motion/keyboard rules.`);
