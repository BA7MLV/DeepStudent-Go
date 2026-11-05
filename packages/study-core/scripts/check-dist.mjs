/** Exercise production ESM without tsx or a bundler masking invalid imports. */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { unzipSync } from 'fflate';

const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));

test('all study-core JavaScript exports load in native Node.js', async t => {
  const entries = Object.entries(pkg.exports).filter(([, target]) => target.default?.endsWith('.js'));
  assert.ok(entries.length > 0);
  for (const [entry] of entries) {
    await t.test(entry, async () => {
      await import(`${pkg.name}/${entry.slice(2)}`);
    });
  }
});

test('compiled handout exports format transcripts and produce a valid DOCX', async () => {
  const { buildHandoutDocx, segmentsToTranscript } = await import('@wangke/study-core/handout/docx');
  assert.equal(segmentsToTranscript([{ start: 65, text: '字幕内容' }]), '[1:05] 字幕内容');
  const blob = await buildHandoutDocx({
    title: '讲义回归测试',
    courseName: '测试课程',
    date: '2026年11月4日',
    summary: '测试摘要',
    sections: [{ heading: '测试章节', blocks: [{ type: 'para', text: '测试正文' }] }],
    images: new Map(),
  });
  assert.equal(blob.type, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  assert.ok(files['[Content_Types].xml']);
  const xml = new TextDecoder().decode(files['word/document.xml']);
  for (const text of ['讲义回归测试', '测试章节', '测试正文']) assert.ok(xml.includes(text), text);
});
