import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(process.env.BASE_URL || 'http://127.0.0.1:5188');
  const setup = async () => page.evaluate(async () => {
    const load = path => import(performance.getEntriesByType('resource').findLast(e => new URL(e.name).pathname === path)?.name ?? path);
    const React = (await load('/node_modules/.vite/deps/react.js')).default;
    const { createRoot } = (await load('/node_modules/.vite/deps/react-dom_client.js')).default;
    const { default: QuizCard } = await load('/src/components/QuizCard.tsx');
    const { default: WidgetBlock } = await load('/src/components/WidgetBlock.tsx');
    const host = document.createElement('main'); host.id = 'feedback-fixture';
    host.style.cssText = 'position:fixed;inset:0;overflow:auto;background:white;z-index:9999;padding:20px'; document.body.append(host);
    const root = createRoot(host);
    const html = `<button onclick="window.__wbw.submitAnswer(0).catch(e=>document.querySelector('output').textContent=e.message)">选图片 A 并提交</button><button onclick="window.__wbw.submitAnswer(1).catch(()=>{})">选图片 B 并提交</button><output></output><script>window.run=Math.random()</script>`;
    window.modelCalls = 0;
    let quizRun = 0;
    window.renderQuiz = (mode = 'verified') => {
      const key = ++quizRun;
      const q = { stem: '选择图片 A', options: ['图片 A', '图片 B'], answer: 0, explanation: '权威解释', presentation: { html }, ...(mode === 'ai' ? { answerSource: 'ai' } : {}) };
      const picks = JSON.parse(sessionStorage.getItem('feedback-picks') || '[-1]');
      const render = () => root.render(React.createElement(QuizCard, { key, quiz: { questions: [q] }, picks: [...picks],
        onAnswer(i, pick) { picks[i] = pick; sessionStorage.setItem('feedback-picks', JSON.stringify(picks)); render(); }, onReview() { window.modelCalls++; } }));
      render();
    };
    window.renderWidget = feedback => root.render(React.createElement(WidgetBlock, { payload: { html: '<p>旧 widget</p>' }, dark: false, answerFeedback: feedback }));
  });
  await setup();
  const frame = () => page.locator('#feedback-fixture iframe').contentFrame();
  page.on('dialog', d => d.accept());
  for (const [mode, choice, text] of [['verified', 'A', '回答正确'], ['verified', 'B', '回答错误'], ['ai', 'A', '待核验']]) {
    await page.evaluate(mode => { sessionStorage.removeItem('feedback-picks'); window.renderQuiz(mode); }, mode);
    await frame().getByText(`选图片 ${choice} 并提交`, { exact: true }).click();
    await frame().locator('#wbw-host-feedback').filter({ hasText: text }).waitFor();
    assert.match(await frame().locator('#wbw-host-feedback').innerText(), /参考答案/);
    assert.equal(await page.evaluate(() => window.modelCalls), 0);
    if (mode === 'verified' && choice === 'A') {
      await page.locator('#feedback-fixture').getByTestId('widget-more').click();
      const popupPromise = context.waitForEvent('page');
      await page.getByTestId('widget-open').click();
      const popup = await popupPromise;
      await popup.getByTestId('widget-frame').contentFrame().locator('#wbw-host-feedback').filter({ hasText: '回答正确' }).waitFor();
      assert.ok(!popup.url().includes('answer'), 'actual originating question sends feedback only through channel');
      await popup.reload();
      await popup.getByTestId('widget-frame').contentFrame().locator('#wbw-host-feedback').filter({ hasText: '回答正确' }).waitFor();
      await popup.close();
      await page.reload(); await setup(); await page.evaluate(() => window.renderQuiz());
      await frame().locator('#wbw-host-feedback').filter({ hasText: '回答正确' }).waitFor();
    }
  }
  await page.getByRole('button', { name: '请求 AI 参考批改（发送消息）' }).click();
  assert.equal(await page.evaluate(() => window.modelCalls), 1);
  assert.match(await frame().locator('#wbw-host-feedback').innerText(), /待核验/);
  await page.getByRole('button', { name: '使用标准作答界面' }).click();
  assert.equal(await page.locator('#feedback-fixture iframe').count(), 0);

  const feedback = { version: 1, requestId: 'preview-answer', answer: 1, correctAnswer: 0, explanation: '<img src=x onerror=alert(1)>', status: 'incorrect', grading: 'host', authoritative: true, timestamp: 1 };
  await page.evaluate(f => window.renderWidget(f), feedback);
  await frame().locator('#wbw-host-feedback').waitFor();
  const runFrame = await (await page.locator('#feedback-fixture iframe').elementHandle()).contentFrame();
  const instance = await page.locator('#feedback-fixture iframe').evaluate(el => JSON.parse(el.srcdoc.match(/var initial = ([^\n]+);/)[1]).instance);
  await runFrame.evaluate(({ instance, feedback }) => {
    window.dispatchEvent(new MessageEvent('message', { source: parent, data: {
      __wbw: 'wbw:answer-feedback', instance, payload: { ...feedback, status: 'correct', timestamp: 99 },
    } }));
  }, { instance, feedback });
  assert.match(await frame().locator('#wbw-host-feedback').innerText(), /回答错误/, 'synthetic parent MessageEvent cannot change feedback');
  assert.equal(await runFrame.locator('#wbw-host-feedback img').count(), 0, 'feedback is text, not executable HTML');
  await runFrame.evaluate(() => parent.postMessage({ __wbw: 'wbw:answer-feedback', payload: { status: 'correct' } }, '*'));
  await runFrame.evaluate(() => window.addEventListener('message', event => {
    if (event.data.__wbw === 'wbw:answer-feedback' && event.isTrusted)
      window.dispatchEvent(new MessageEvent('message', { source: parent, data: { ...event.data, payload: { ...event.data.payload, status: 'correct', timestamp: 999 } } }));
  }));
  assert.match(await frame().locator('#wbw-host-feedback').innerText(), /回答错误/);
  await page.evaluate(f => window.renderWidget({ ...f, explanation: 'x'.repeat(40000) }), feedback);
  assert.match(await frame().locator('#wbw-host-feedback').innerText(), /回答错误/);
  await page.evaluate(f => {
    const iframe = document.querySelector('#feedback-fixture iframe');
    const instance = JSON.parse(iframe.srcdoc.match(/var initial = ([^\n]+);/)[1]).instance;
    iframe.contentWindow.postMessage({ __wbw: 'wbw:answer-feedback', instance, payload: { ...f, grading: 'ai', authoritative: true, timestamp: 99 } }, '*');
  }, feedback);
  assert.match(await frame().locator('#wbw-host-feedback').innerText(), /回答错误/);
  await page.evaluate(f => window.renderWidget({ ...f, status: 'partial', timestamp: 2 }), feedback);
  await frame().locator('#wbw-host-feedback').filter({ hasText: '部分正确' }).waitFor();
  await page.evaluate(f => window.renderWidget({ ...f, status: 'review', grading: 'ai', authoritative: false, timestamp: 3 }), feedback);
  await frame().locator('#wbw-host-feedback').filter({ hasText: '参考批改（非权威）' }).waitFor();
  await page.getByTestId('widget-more').click();
  const url = await page.getByTestId('widget-open').getAttribute('href');
  assert.ok(!url.includes('incorrect') && !url.includes('explanation'));
  const preview = await page.context().newPage(); await preview.goto(url);
  await preview.getByTestId('widget-frame').contentFrame().locator('#wbw-host-feedback').filter({ hasText: '参考批改（非权威）' }).waitFor();
  await page.evaluate(f => window.renderWidget({ ...f, timestamp: 4 }), feedback);
  await preview.getByTestId('widget-frame').contentFrame().locator('#wbw-host-feedback').filter({ hasText: '回答错误' }).waitFor();
  await preview.reload();
  await preview.getByTestId('widget-frame').contentFrame().locator('#wbw-host-feedback').filter({ hasText: '回答错误' }).waitFor();
  console.log('PASS: real QuizCard submit correct/incorrect/pending, refresh restoration, AI-reference boundary, standard fallback, legacy HTML, invalid feedback, text-only output, BroadcastChannel preview and preview refresh');
} finally { await browser.close(); }
