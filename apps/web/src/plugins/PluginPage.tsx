import { usePluginRenderer } from './usePluginRenderer';

export default function PluginPage() {
  const { renderer, error } = usePluginRenderer();
  if (error) return <p role="alert">{error}</p>;
  return renderer ? renderer.renderPage() : <p aria-busy="true">正在加载…</p>;
}
