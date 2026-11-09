import i18n from '../i18n';

/**
 * Provider/browser errors are not guaranteed to be localized. Keep useful
 * provider details, but translate the common transport messages that users
 * otherwise see as raw English (for example, "Load failed").
 */
export function displayChatError(reason?: string): string {
  const text = reason?.trim();
  if (!text) return i18n.t('chat.requestNotCompleted');

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
