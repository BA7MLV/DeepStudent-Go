import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const web = await createServer({
  root: fileURLToPath(new URL('../apps/web', import.meta.url)),
  server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
});
let browser;
try {
  await web.listen();
  browser = await chromium.launch();
  const origin = `http://127.0.0.1:${web.httpServer.address().port}`;
  for (const width of [320, 390, 768, 1440]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/api/v1/**', route => route.fulfill({ status: 404, json: {} }));
    await page.route('https://models.dev/**', route => route.fulfill({ json: {} }));
    await page.goto(origin);
    await page.getByRole('textbox', { name: '给 AI 助手发送消息' }).waitFor();
    await page.evaluate(async () => {
      const { useSettings } = await import('/src/store/settings.ts');
      const provider = useSettings.getState().providers[0];
      const model = 'layout-test/a-very-long-model-name-that-must-not-push-controls-outside-the-settings-card';
      useSettings.getState().update({
        savedModels: [{ providerId: provider.id, model, name: '', slots: ['chat', 'vision', 'asr', 'decision'] }],
        llmModel: { providerId: provider.id, model },
        asrModel: { providerId: provider.id, model },
        visionModel: { providerId: '', model: '' },
        decisionModel: { providerId: '', model: '' },
      });
      const { openSettings } = await import('/src/components/settingsDialogStore.ts');
      openSettings('models');
    });
    await page.getByTestId('card-models').waitFor();
    const assertLayout = async expected => {
      const rows = await page.locator('[data-model-field]').evaluateAll(elements => elements.map(element => {
        const trigger = element.querySelector('.model-slot__trigger');
        if (!trigger) return null;
        const bounds = element.getBoundingClientRect();
        const button = trigger.getBoundingClientRect();
        const style = getComputedStyle(element);
        const clear = element.querySelector('.model-slot__clear');
        return {
          left: Math.abs(button.left - bounds.left - parseFloat(style.paddingLeft)),
          right: Math.abs(bounds.right - button.right - parseFloat(style.paddingRight)),
          height: button.height,
          overflow: element.scrollWidth > element.clientWidth,
          actionBelow: !clear || clear.getBoundingClientRect().top >= button.bottom,
          hintVisible: getComputedStyle(element.querySelector('[id^="model-hint-"]')).whiteSpace === 'normal',
        };
      }).filter(Boolean));
      assert.equal(rows.length, expected);
      for (const row of rows) {
        assert.ok(row.left < 2 && row.right < 2, `${width}px: selectors fill their container`);
        assert.ok(row.height >= 63, `${width}px: empty and selected controls keep a touch-sized minimum`);
        assert.equal(row.overflow, false, `${width}px: long model names do not overflow`);
        assert.equal(row.actionBelow, true, `${width}px: clearing is secondary to selection`);
        assert.equal(row.hintVisible, true, `${width}px: hints wrap instead of truncating`);
      }
    };
    await assertLayout(3);
    const trigger = page.getByTestId('model-button-llmModel');
    await trigger.scrollIntoViewIfNeeded();
    await trigger.click();
    await page.getByTestId('model-search-llmModel').waitFor();
    await page.getByTestId('model-search-llmModel').locator('input').press('Escape');
    await page.getByTestId('model-search-llmModel').waitFor({ state: 'hidden' });
    await page.locator('.model-slot__auto [data-slot="checkbox-content"]').click();
    assert.equal(await page.getByRole('checkbox', { name: '自动：优先主模型，否则使用读图模型', exact: true }).isChecked(), false);
    await page.getByTestId('model-button-visionModel').waitFor();
    await assertLayout(4);
    assert.deepEqual(errors, []);
    console.log(`PASS ${width}px: full-width alignment, wrapping, picker, and automatic vision`);
    await context.close();
  }
} finally {
  await browser?.close();
  await web.close();
}
