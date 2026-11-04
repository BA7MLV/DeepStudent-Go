import { usePluginRenderer } from './usePluginRenderer';
import type { PluginSlotProps } from './PluginSlotView';

/** Public surface boundary. The dedicated renderer injects the catalog hook. */
export function PluginSlot(props: PluginSlotProps) {
  const { renderer, error } = usePluginRenderer();
  if (error) return <p role="alert">{error}</p>;
  return renderer ? renderer.renderSurface(props) : <p aria-busy="true">加载插件…</p>;
}
