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

/** Translate the stable failure prefix without rewriting provider details. */
export function displayChatFailure(content?: string): string {
  const text = content?.trim() ?? '';
  const match = text.match(/^(?:回答失败：|回答失败:|answer failed:\s*)(.*)$/is);
  return match ? i18n.t('chat.failed', { reason: displayChatError(match[1]) }) : displayChatError(text);
}
