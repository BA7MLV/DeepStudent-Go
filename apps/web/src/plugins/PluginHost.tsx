import type { PluginOccurrence } from '../client/plugin-renderer';
import { usePluginRenderer } from './usePluginRenderer';

export function PluginHost(props: PluginOccurrence) {
  const { renderer, error } = usePluginRenderer();
  if (error) return <p role="alert">{error}</p>;
  return renderer ? renderer.render(props) : <p aria-busy="true">加载插件视图…</p>;
}
