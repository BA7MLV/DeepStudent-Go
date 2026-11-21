import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processSteps, processTitle } from '../apps/web/src/utils/responseProcess.ts';
import { displayToolResult, toolDisplay } from '../apps/web/src/utils/toolTrace.ts';
import { webToolDetail } from '@wangke/contracts/web-search';

test('分析与重复工具按真实先后交错，连续工具不生成空分析', () => {
  const calls = [
    { name: 'grep', status: 'done', reasoningOffset: 2 },
    { name: 'grep', status: 'done', reasoningOffset: 4 },
    { name: 'read', status: 'done', reasoningOffset: 4 },
  ];
  const steps = processSteps('初想复查结论', calls);
  assert.deepEqual(steps.map((step) => step.kind === 'reasoning' ? step.text : step.call.name),
    ['初想', 'grep', '复查', 'grep', 'read', '结论']);
  assert.equal(new Set(steps.map((step) => step.key)).size, steps.length);
});

test('历史记录不猜交错顺序，仍完整显示分析与所有工具', () => {
  const calls = [{ name: 'grep', status: 'done' }, { name: 'read', status: 'done' }];
  assert.deepEqual(processSteps('旧分析', calls).map((step) => step.kind), ['reasoning', 'tool', 'tool']);
  assert.deepEqual(processSteps('', []), []);
  assert.equal(processSteps('只有分析', [])[0].text, '只有分析');
});

test('异常偏移夹在有效范围内，不重复或丢失正文', () => {
  const steps = processSteps('完整分析', [
    { name: 'read', status: 'done', reasoningOffset: 100 },
    { name: 'read', status: 'done', reasoningOffset: -1 },
  ]);
  assert.equal(steps.filter((step) => step.kind === 'reasoning').map((step) => step.text).join(''), '完整分析');
});

test('执行阶段决定标题，不用正文是否为空来猜正在思考', () => {
  const calls = [{ name: 'search_material', detail: '傅里叶', status: 'running' }];
  assert.equal(processTitle({ streaming: true, phase: 'tool', calls }), '正在检索材料：傅里叶');
  assert.equal(processTitle({ streaming: true, phase: 'thinking', calls }), '正在思考');
  assert.equal(processTitle({ streaming: true, phase: 'answering', calls }), '正在组织回答');
  assert.equal(processTitle({ streaming: false, phase: 'thinking', calls }), '思考过程');
  assert.equal(processTitle({ streaming: true, phase: 'preparing', calls: [] }), '正在思考');
  assert.equal(processTitle({ streaming: true, phase: 'preparing', calls: [], hint: '正在转写' }), '正在转写');
});

test('确认和失败场景不会伪装成成功或继续思考', () => {
  assert.equal(processTitle({ streaming: true, calls: [], waiting: true }), '等待你的确认');
  assert.equal(processTitle({ streaming: true, phase: 'tool', calls: [{ name: 'ask_user', status: 'running' }] }), '等待你的回答');
  assert.equal(processTitle({ streaming: false, calls: [{ name: 'ask_user', status: 'running' }], waiting: true }), '等待你的回答');
  assert.equal(processTitle({ streaming: true, calls: [{ name: 'propose_folder_plan', status: 'running' }], waiting: true }), '等待你的确认');
  assert.equal(processTitle({ streaming: false, calls: [{ name: 'read', status: 'error' }] }), '思考过程');
});

test('联网工具的实时标题和历史记录只显示网址或搜索词', () => {
  const url = 'https://www.qsl.qa';
  const title = (name, detail) => processTitle({ streaming: true, phase: 'tool', calls: [{ name, detail, status: 'running' }] });
  assert.equal(title('webfetch', webToolDetail('webfetch', { url })), `正在读取网页：${url}`);
  assert.equal(title('webfetch', JSON.stringify({ url })), `正在读取网页：${url}`);
  assert.equal(title('webfetch', '{"url":"https://www.qsl.qa'), '正在读取网页…');
  assert.equal(title('webfetch', '{"url":{"url":"https://www.qsl.qa"}}'), '正在读取网页…');
  assert.equal(title('websearch', '{"query":"世界杯赛程","limit":4}'), '正在搜索网页：世界杯赛程');
  assert.deepEqual(toolDisplay('webfetch', JSON.stringify({ url })), { label: '读取网页', detail: url });
});

test('网页读取结果不显示原始 JSON，保留正常错误提示', () => {
  const raw = JSON.stringify({ kind: 'web_fetch', title: 'Qatar Stars League', content: 'Article body' });
  assert.equal(displayToolResult('webfetch', raw), 'Qatar Stars League');
  assert.equal(displayToolResult('webfetch', raw.slice(0, -1)), undefined);
  assert.equal(displayToolResult('webfetch', '工具执行失败：web_fetch_failed'), '工具执行失败：web_fetch_failed');
});

test('Shell 调用使用终端名称和执行目的，不直接显示工具参数 JSON', () => {
  const detail = JSON.stringify({ command: 'printf 42', description: '计算结果' });
  assert.deepEqual(toolDisplay('shell', detail), { label: 'Shell', detail: '计算结果' });
  assert.deepEqual(toolDisplay('bash', '{"command":"printf'), { label: 'Shell', detail: undefined });
  assert.equal(processTitle({ streaming: true, phase: 'tool', calls: [{ name: 'shell', detail: '计算结果', status: 'running' }] }), 'Shell · 计算结果');
});
