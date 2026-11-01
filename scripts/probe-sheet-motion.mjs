/** BASE_URL=http://localhost:4181 node scripts/probe-sheet-motion.mjs */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.BASE_URL || 'http://localhost:4173';
const browser = await chromium.launch({ channel: 'chrome', headless: true });

// Sample actual painted positions, not just the presence of transition CSS.
// HeroUI animates a child while React Aria measures its wrapper: the CSS can
// look correct even when entry never runs or exit gets unmounted too early.
async function trace(page, action) {
  return page.evaluate(async (action) => {
    const frames = [];
    const start = performance.now();
    let removedAt = null;
    if (action === 'open') location.hash = '/settings';
    else document.querySelector('[data-slot="drawer-close-trigger"]').click();
    await new Promise((resolve) => {
      function sample() {
        const dialog = document.querySelector('[data-testid="settings-modal"]');
        const time = performance.now() - start;
        if (dialog) {
          const rect = dialog.getBoundingClientRect();
          const style = getComputedStyle(dialog);
          frames.push({
            time,
            top: rect.top,
            height: rect.height,
            duration: parseFloat(style.getPropertyValue(action === 'open'
              ? '--drawer-enter-duration' : '--drawer-exit-duration')),
            transition: style.transitionDuration,
          });
        } else if (action === 'close' && removedAt === null) removedAt = time;
        if (time < 800) requestAnimationFrame(sample);
        else resolve();
      }
      requestAnimationFrame(sample);
    });
    return { frames, removedAt, viewport: innerHeight };
  }, action);
}

try {
  for (const reducedMotion of ['no-preference', 'reduce']) {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion });
    await page.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
    await page.goto(`${base}/#/`);
    await page.waitForSelector('[data-testid="nav-rail-open"]');

    for (let cycle = 1; cycle <= 2; cycle++) {
      const entry = await trace(page, 'open');
      assert(entry.frames.length > 2, 'settings must render');
      const first = entry.frames[0];
      const last = entry.frames.at(-1);
      assert(Math.abs(last.top + last.height - entry.viewport) < 2, 'sheet stays attached to bottom');
      if (reducedMotion === 'reduce') {
        assert.equal(last.transition, '0s');
        assert(entry.frames.every((frame) => Math.abs(frame.top - last.top) < 2), 'reduced motion: no slide');
      } else {
        assert(first.top - last.top > last.height * 0.6, 'sheet must rise from below, not appear in place');
        assert(entry.frames.some((frame) => frame.top > last.top + 5 && frame.top < first.top - 5), 'entry has intermediate painted frames');
        for (let i = 1; i < entry.frames.length; i++) {
          assert(entry.frames[i].top <= entry.frames[i - 1].top + 2, 'entry moves upwards only');
        }
      }

      const exit = await trace(page, 'close');
      assert.notEqual(exit.removedAt, null, 'exit must remove the overlay');
      if (reducedMotion === 'no-preference') {
        assert(exit.frames.length > 2, 'exit must animate before unmounting');
        assert(exit.frames.at(-1).top > entry.viewport - 10, 'exit reaches bottom edge');
        assert(exit.removedAt >= exit.frames[0].duration - 40, 'backdrop must wait for the full sheet exit');
      }
      assert.equal(await page.locator('[data-slot="drawer-backdrop"]').count(), 0, 'no blocking overlay remains');
      console.log(`✓ settings ${reducedMotion}, open/close ${cycle}`);
    }
    // An actual click after dismissal catches transparent blocking overlays.
    await page.locator('[data-testid="nav-rail-open"]').click({ timeout: 3000 });
    await page.close();
  }

  const desktop = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  await desktop.route('**/api/v1/cloud/status', (route) => route.fulfill({ json: { cloud: false } }));
  await desktop.goto(`${base}/#/settings`);
  await desktop.waitForSelector('[data-testid="settings-modal"]');
  assert.equal(await desktop.locator('[data-slot="modal-container"]').count(), 1, 'desktop remains a centered modal');
  assert.equal(await desktop.locator('.drawer__content--bottom').count(), 0);
  console.log('✓ desktop settings remains a modal');
} finally {
  await browser.close();
}
