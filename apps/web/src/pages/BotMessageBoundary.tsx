import { Component, type ReactNode } from 'react';
import { Button } from '@heroui/react';
import { useTranslation } from 'react-i18next';

/** A malformed rich message/chunk must not unmount the conversation or drafts. */
export default class BotMessageBoundary extends Component<{ content: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <Fallback content={this.props.content} retry={() => this.setState({ failed: false })} /> : this.props.children;
  }
}
function Fallback({ content, retry }: { content: string; retry: () => void }) {
  const { t } = useTranslation();
  return <div role="alert"><p>{t('botHome.renderError')}</p><pre className="bot-message-fallback">{content}</pre><Button size="sm" variant="ghost" onPress={() => void navigator.clipboard.writeText(content)}>{t('botHome.copyText')}</Button><Button size="sm" variant="ghost" onPress={retry}>{t('botHome.retryHistory')}</Button></div>;
}
