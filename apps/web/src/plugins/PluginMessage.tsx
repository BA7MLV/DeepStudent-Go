import { usePluginRenderer } from './usePluginRenderer';
import type { PluginMessageProps } from './PluginMessageView';

export default function PluginMessage(props: PluginMessageProps) {
  const { renderer, error } = usePluginRenderer();
  if (error) return <p role="alert">{error}</p>;
  return renderer ? renderer.renderMessage(props) : <p aria-busy="true">正在加载插件引用…</p>;
}
