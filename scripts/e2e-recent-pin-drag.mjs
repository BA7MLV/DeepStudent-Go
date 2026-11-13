import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// 独立浏览器上下文，不读写日常浏览器中的会话。
// 优先日常浏览器里的 Chrome；环境里没有时退回 Playwright 自带的 Chromium。
const browser = await chromium.launch({ channel: 'chrome', headless: true }).catch(() => chromium.launch({ headless: true }));
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(process.env.BASE_URL || 'http://localhost:5173');
  await page.getByTestId('course-chat-page').waitFor();
  await page.evaluate(async () => {
    const { db } = await import('/src/store/db.ts');
    const { useCourseChat } = await import('/src/store/courseChat.ts');
    await useCourseChat.getState().bootstrap();
    const sessions = [
      { id: 901, title: '普通会话', createdAt: 200, pinned: false },
      { id: 902, title: '置顶会话', createdAt: 100, pinned: true },
    ].map((row) => ({ ...row, videoId: '__library_assistant__' }));
    await db.chatSessions.bulkPut(sessions);
    await db.chats.bulkAdd(sessions.map((row) => ({
      sessionId: row.id, videoId: row.videoId, role: 'user', content: row.title, createdAt: row.createdAt,
    })));
    useCourseChat.setState({ sessions, runningIds: [], awaitingIds: [] });
  });
  await page.getByTestId('chat-recent-902').waitFor();

  // 置顶会话有专门的小节标题，未置顶会话仍归在「最近」下。
  assert.equal(await page.getByTestId('recent-section-label').textContent(), '置顶');
  const rows = page.locator('[data-testid^="chat-recent-"][role="option"]');
  assert.deepEqual(await rows.evaluateAll((els) => els.map((el) => el.dataset.testid)), ['chat-recent-902', 'chat-recent-901']);

  const pinnedOf = (id) => page.evaluate(async (sessionId) => {
    const { db } = await import('/src/store/db.ts');
    return (await db.chatSessions.get(sessionId)).pinned;
  }, id);

  // 长按已置顶的行：投放区显示「取消置顶」，拖入后该会话取消置顶。
  assert.equal(await page.getByTestId('recent-drop-zone').count(), 0);
  const pinnedRow = page.getByTestId('chat-recent-902');
  const zone = page.getByTestId('recent-drop-zone');
  await pinnedRow.hover();
  await page.mouse.down();
  await page.waitForTimeout(450);
  await zone.waitFor();
  assert.equal(await zone.textContent(), '取消置顶');
  const zoneBox = await zone.boundingBox();
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="recent-drop-zone"]') === null);
  assert.equal(await pinnedOf(902), false);
  // 拖放不该顺手把用户切去那个会话。
  assert.notEqual(await page.getByTestId('chat-recent-902').getAttribute('aria-selected'), 'true');

  // 长按未置顶的行：同一块投放区切换为「置顶」，拖入后该会话置顶。
  const plainRow = page.getByTestId('chat-recent-901');
  await plainRow.hover();
  await page.mouse.down();
  await page.waitForTimeout(450);
  await zone.waitFor();
  assert.equal(await zone.textContent(), '置顶');
  const nextZoneBox = await zone.boundingBox();
  await page.mouse.move(nextZoneBox.x + nextZoneBox.width / 2, nextZoneBox.y + nextZoneBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="recent-drop-zone"]') === null);
  assert.equal(await pinnedOf(901), true);

  // 短按（不足长按时长）不进入拖拽，也不该弹投放区。
  await page.getByTestId('chat-recent-901').hover();
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  assert.equal(await zone.count(), 0);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log('e2e-recent-pin-drag passed');
