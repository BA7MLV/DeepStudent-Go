import assert from 'node:assert/strict';
import { test } from 'node:test';
import { taskFailure } from '../apps/web/src/utils/taskFailure.ts';
import { displayChatError } from '../apps/web/src/utils/chatError.ts';
import i18n from '../apps/web/src/i18n/index.ts';

test('only explicit server evidence is a known rejection', () => {
  const failure = Object.assign(new Error('Domain request failed'), { code: 'client/domain', detail: { code: 'model_provider_not_found', admissionRejected: true } });
  assert.deepEqual(taskFailure(failure), { reason: 'model_provider_not_found', rejected: true });
  assert.deepEqual(taskFailure(Object.assign(new Error('Domain request failed'), { code: 'client/domain', detail: { code: 'model_provider_not_found' } })), { reason: 'model_provider_not_found', rejected: false });
  for (const error of [new Error('Failed to fetch'), new Error('Domain request failed'), new Error('client_account_changed'), null, 'unknown']) {
    assert.equal(taskFailure(error).rejected, false);
  }
});

test('task errors show localized explanations and preserve useful provider details', async () => {
  try {
    await i18n.changeLanguage('zh-CN');
    assert.equal(displayChatError('model_provider_not_found'), '所选模型的供应商已不可用，请在模型设置中检查配置。');
    assert.equal(displayChatError('task_fallback_not_supported'), '当前任务不支持多模型自动切换，请在模型设置中改用单一模型后重试。');
    assert.equal(displayChatError('Domain request failed'), '服务器暂时无法处理这次请求，消息和附件仍保留，请稍后重试。');
    assert.equal(displayChatError('client api: clientRuntime/taskAdmission failed: client_account_changed'), '登录状态或连接已更新，请刷新页面后重试。');
    assert.equal(displayChatError('client api: clientRuntime/submitTask failed: Failed to fetch'), displayChatError('Failed to fetch'));
    assert.equal(displayChatError('This operation was aborted'), '请求已中断，消息和附件仍保留，请稍后重试。');
    await i18n.changeLanguage('en-US');
    assert.equal(displayChatError('model_provider_not_found'), 'The selected model provider is unavailable. Check your model settings.');
    assert.equal(displayChatError('Provider quota exceeded (429)'), 'Provider quota exceeded (429)');
  } finally { await i18n.changeLanguage('zh-CN'); }
});
