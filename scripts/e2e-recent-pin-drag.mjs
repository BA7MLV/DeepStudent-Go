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
      { id: 901, title: '置顶一', createdAt: 10, pinned: true, pinnedOrder: 0 },
      { id: 902, title: '置顶二', createdAt: 20, pinned: true, pinnedOrder: 1 },
      { id: 903, title: '最近会话', createdAt: 30, pinned: false },
      { id: 904, title: '旧会话', createdAt: 5, pinned: false },
    ].map((row) => ({ ...row, videoId: '__library_assistant__' }));
    await db.chatSessions.bulkPut(sessions);
    await db.chats.bulkAdd(sessions.map((row) => ({
      sessionId: row.id, videoId: row.videoId, role: 'user', content: row.title, createdAt: row.createdAt,
    })));
    useCourseChat.setState({ sessions, runningIds: [], awaitingIds: [] });
  });
  await page.getByTestId('chat-recent-901').waitFor();

  const rows = page.locator('[data-testid^="chat-recent-"][role="option"]');
  const ids = () => rows.evaluateAll((els) => els.map((el) => el.dataset.testid));
  const rowOf = (id) => page.getByTestId(`chat-recent-${id}`);
  const zone = page.getByTestId('recent-drop-zone');
  const sessionRow = (id) => page.evaluate(async (sessionId) => {
    const { db } = await import('/src/store/db.ts');
    const row = await db.chatSessions.get(sessionId);
    return { pinned: !!row.pinned, pinnedOrder: row.pinnedOrder };
  }, id);
  // 长按 350ms 后拖到目标点松手。
  const dragTo = async (id, x, y) => {
    await rowOf(id).hover();
    await page.mouse.down();
    await page.waitForTimeout(450);
    await zone.waitFor();
    await page.mouse.move(x, y, { steps: 8 });
    await page.mouse.up();
    await page.waitForFunction(() => document.querySelector('[data-testid="recent-drop-zone"]') === null);
  };
  const pointBelow = async (id) => {
    const box = await rowOf(id).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height - 1 };
  };

  // 置顶会话有专门的小节，未置顶会话仍归在「最近」下。
  assert.equal(await page.getByTestId('recent-pinned-section').textContent(), '置顶');
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-902', 'chat-recent-903', 'chat-recent-904']);

  // 置顶列表内拖动换顺序：把「置顶一」拖到「置顶二」下方。
  const below902 = await pointBelow(902);
  await dragTo(901, below902.x, below902.y);
  assert.deepEqual(await ids(), ['chat-recent-902', 'chat-recent-901', 'chat-recent-903', 'chat-recent-904']);
  assert.deepEqual(await sessionRow(902), { pinned: true, pinnedOrder: 0 });
  assert.deepEqual(await sessionRow(901), { pinned: true, pinnedOrder: 1 });

  // 取消置顶的投放区在置顶小节最下方：拖「置顶二」进去即取消置顶。
  assert.equal(await zone.count(), 0);
  await rowOf(902).hover();
  await page.mouse.down();
  await page.waitForTimeout(450);
  await zone.waitFor();
  assert.equal(await zone.textContent(), '取消置顶');
  const zoneBox = await zone.boundingBox();
  await page.mouse.move(zoneBox.x + zoneBox.width / 2, zoneBox.y + zoneBox.height / 2, { steps: 8 });
  await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('[data-testid="recent-drop-zone"]') === null);
  assert.deepEqual(await sessionRow(902), { pinned: false, pinnedOrder: undefined });
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-903', 'chat-recent-902', 'chat-recent-904']);
  // 拖放不该顺手把用户切去那个会话。
  assert.notEqual(await rowOf(902).getAttribute('aria-selected'), 'true');

  // 最近会话拖进置顶区：「最近会话」拖到「置顶一」下方 = 置顶并插到那里。
  const below901 = await pointBelow(901);
  await dragTo(903, below901.x, below901.y);
  assert.deepEqual(await sessionRow(903), { pinned: true, pinnedOrder: 1 });
  assert.deepEqual(await ids(), ['chat-recent-901', 'chat-recent-903', 'chat-recent-902', 'chat-recent-904']);

  // 短按（不足长按时长）不进入拖拽，也不该弹投放区。
  await rowOf(903).hover();
  await page.mouse.down();
  await page.waitForTimeout(100);
  await page.mouse.up();
  assert.equal(await zone.count(), 0);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
console.log('e2e-recent-pin-drag passed');
