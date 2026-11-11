import i18n from '../i18n';

const taskErrors = {
  model_not_configured: 'modelNotConfigured',
  model_preset_not_found: 'modelPresetNotFound',
  model_provider_not_found: 'modelProviderNotFound',
  model_capability_unavailable: 'modelCapabilityUnavailable',
  invalid_model_selection: 'invalidModelSelection',
  invalid_model_reference: 'invalidModelSelection',
  task_fallback_not_supported: 'taskFallbackNotSupported',
  session_not_found: 'sessionNotFound',
  plugin_unavailable: 'pluginUnavailable',
  invalid_task: 'invalidTask',
  task_admission_uncertain: 'taskBusy',
  client_account_changed: 'accountChanged',
  client_runtime_disposed: 'accountChanged',
  client_unauthenticated: 'authenticationExpired',
  'Authentication expired': 'authenticationExpired',
  'Task operation id reused with different content': 'taskConflict',
  domain_failed: 'generic',
  'Domain request failed': 'generic',
} as const;

/**
 * Provider/browser errors are not guaranteed to be localized. Keep useful
 * provider details, but translate the common transport messages that users
 * otherwise see as raw English (for example, "Load failed").
 */
export function displayChatError(reason?: string): string {
  const text = reason?.trim();
  if (!text) return i18n.t('chat.requestNotCompleted');

  // The gateway folds carrier exceptions into a message containing its internal
  // endpoint. Translate the underlying failure, not that implementation detail.
  const carrier = text.match(/^client api: [\w/-]+ failed: (.+)$/s);
  if (carrier) return displayChatError(carrier[1]);

  if (Object.hasOwn(taskErrors, text)) {
    return i18n.t(`settings:recovery.taskErrors.${taskErrors[text as keyof typeof taskErrors]}`);
  }
  if (/^(?:AbortError: )?(?:(?:the|this) (?:operation|request) was aborted|.*user aborted.*|signal is aborted.*|aborted)\.?$/i.test(text)) return i18n.t('settings:recovery.taskErrors.interrupted');

  if (/^(load failed|failed to fetch|network request failed)$/i.test(text)) {
    return i18n.t('chat.errors.loadFailed');
  }
  if (/^(network error|network request was interrupted|the network connection was lost)$/i.test(text)) {
    return i18n.t('chat.errors.networkFailed');
  }
  return text;
}

/**
 * 判断失败文本是不是「模型/密钥没配好」这一类：这类错误的下一步是去设置里配置模型，
 * 而不是原地重试。匹配保持保守，只收编常见的供应商与本地网关措辞。
 */
export function isModelConfigError(reason?: string): boolean {
  const text = reason?.toLowerCase() ?? '';
  if (!text) return false;
  return /api[ _-]?key/.test(text)
    || /unauthorized|forbidden|\b401\b|\b403\b/.test(text)
    || /invalid[ _-]?credentials/.test(text)
    || /no model|model not found|missing model/.test(text)
    || /未配置|没有配置|无可用模型|密钥/.test(reason!)
    || /provider/.test(text) && /not configured|missing/.test(text);
}

/** Translate the stable failure prefix without rewriting provider details. */
export function displayChatFailure(content?: string): string {
  const text = content?.trim() ?? '';
  const match = text.match(/^(?:回答失败：|回答失败:|answer failed:\s*)(.*)$/is);
  return match ? i18n.t('chat.failed', { reason: displayChatError(match[1]) }) : displayChatError(text);
}
