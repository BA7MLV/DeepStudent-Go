import { usePluginRenderer } from './usePluginRenderer';
import type { PluginActionsProps } from './PluginActionsView';

export function PluginActions(props: PluginActionsProps) {
  const { renderer, error } = usePluginRenderer();
  if (error) return <p role="alert">{error}</p>;
  return renderer ? renderer.renderActions(props) : null;
}
