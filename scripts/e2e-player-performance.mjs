// BASE_URL=http://localhost:5173 TEST_FILE=/path/to/90s.mp4 node scripts/e2e-player-performance.mjs
// 独立浏览器数据库；DevTools hook 只计实际执行过的组件，不把祖先提交误计成渲染。
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

if (!process.env.TEST_FILE) throw new Error('需要 TEST_FILE（至少 60 秒）');
const base = process.env.BASE_URL || 'http://localhost:5173';
const file = (await readFile(process.env.TEST_FILE)).toString('base64');
const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
await page.addInitScript(() => {
  window.__playerRenders = {};
  const committed = new WeakMap();
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    supportsFiber: true, renderers: new Map(),
    inject(renderer) { this.renderers.set(1, renderer); return 1; },
    onCommitFiberRoot(_id, root) {
      const visit = fiber => {
        if (!fiber) return;
        const name = fiber.type?.displayName || fiber.type?.name;
        // 被 bailout 直接复用的子树可能仍留着上次的 PerformedWork 标记。
        const previous = committed.get(fiber);
        if (name && previous !== fiber && (fiber.flags & 1)) window.__playerRenders[name] = (window.__playerRenders[name] || 0) + 1;
        committed.set(fiber, fiber);
        if (fiber.alternate) committed.set(fiber.alternate, fiber);
        visit(fiber.child);
        visit(fiber.sibling);
      };
      visit(root.current);
    },
    onCommitFiberUnmount() {},
  };
});

try {
  await page.goto(`${base}/#/library`);
  await page.evaluate(async file => {
    const { db } = await import('/src/store/db.ts');
    const { saveVideoFile } = await import('/src/store/fileStore.ts');
    const blob = new Blob([Uint8Array.from(atob(file), c => c.charCodeAt(0))], { type: 'video/mp4' });
    await saveVideoFile('player-performance-test', blob);
    await db.videos.put({ id: 'player-performance-test', name: '播放器性能测试', mimeType: 'video/mp4', size: blob.size, createdAt: Date.now() });
    await db.segments.bulkAdd(Array.from({ length: 200 }, (_, idx) => ({
      videoId: 'player-performance-test', idx, start: idx * .4, end: (idx + 1) * .4,
      text: `第 ${idx + 1} 句性能测试字幕。`, status: 1,
    })));
  }, file);
  await page.goto(`${base}/#/player/player-performance-test`);
  await page.waitForFunction(() => document.querySelector('[data-media-provider] video')?.readyState >= 2);
  // 首次展开让骨架可见性门控完成，再收起测量后台开销。
  await page.getByTestId('study-assistant-toggle').click();
  await page.waitForFunction(() => document.querySelectorAll('[data-testid="subs-row"]').length === 200);
  await page.getByTestId('study-assistant-close').click();
  assert.ok(await page.evaluate(() => window.__playerRenders.PlayerResource > 0), '渲染计数器已连接 React');

  async function sample() {
    await page.locator('[data-media-provider] video').evaluate(async video => {
      video.currentTime = 10;
      await video.play();
    });
    // 等初次 play / seek 的状态提交结束，再采样稳定播放，不把初始化算入进度开销。
    await page.waitForTimeout(500);
    await page.evaluate(() => { window.__playerRenders = {}; });
    await page.waitForTimeout(3000);
    const counts = await page.evaluate(() => window.__playerRenders);
    await page.locator('[data-media-provider] video').evaluate(video => video.pause());
    return Object.fromEntries(['PlayerResource', 'SubtitlePanel', 'CueRow', 'ChatPanel', 'DefaultVideoLayout'].map(name => [name, counts[name] || 0]));
  }

  const closed = await sample();
  await page.getByTestId('study-assistant-toggle').click();
  await page.getByTestId('panel-slot-subs').waitFor({ state: 'visible' });
  const open = await sample();
  await page.getByTestId('panel-tab-chat').click();
  const otherTab = await sample();
  await page.getByTestId('panel-tab-subs').click();
  console.log(JSON.stringify({ sampleSeconds: 3, assistantClosed: closed, assistantOpen: open, assistantOtherTab: otherTab }, null, 2));
  if (!process.env.BASELINE) {
    assert.equal(closed.PlayerResource, 0, '播放进度不重新渲染整页');
    assert.equal(closed.SubtitlePanel, 0, '收起的字幕面板不跟随进度渲染');
    assert.equal(open.PlayerResource, 0, '字幕高亮更新不影响整页');
    assert.equal(open.ChatPanel, 0, '字幕高亮更新不影响问答面板');
    assert.equal(open.DefaultVideoLayout, 0, '字幕高亮更新不重建控制栏');
    assert.ok(open.SubtitlePanel > 0 && open.SubtitlePanel <= 10, '只在字幕句子改变时更新高亮');
    assert.ok(open.CueRow > 0 && open.CueRow <= open.SubtitlePanel * 2, '只重新渲染换句的两条字幕行');
    assert.equal(otherTab.SubtitlePanel, 0, '切换到问答后字幕面板取消进度订阅');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-media-provider] video').evaluate(video => { video.currentTime = 24.1; });
    await page.waitForFunction(() => document.querySelector('[data-testid="subs-row"].sub-item--active')?.textContent?.includes('61'));
    await page.getByTestId('subs-row').nth(30).click();
    await page.waitForFunction(() => Math.abs(document.querySelector('[data-media-provider] video').currentTime - 12.01) < .1);
  }
  assert.deepEqual(errors, []);
} catch (error) {
  console.error('运行错误:', errors);
  throw error;
} finally {
  await browser.close();
}
