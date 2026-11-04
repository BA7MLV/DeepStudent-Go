import { useEffect, useState } from 'react';

export function usePluginRenderer() {
  const [renderer, setRenderer] = useState<Awaited<ReturnType<typeof import('../client/plugin-renderer')['createPluginRenderer']>>>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let current = true;
    let release: (() => void) | undefined;
    void import('../client/plugin-renderer').then(({ acquirePluginRenderer }) => {
      if (!current) return;
      const lease = acquirePluginRenderer(); release = lease.release;
      return lease.ready.then(value => { if (current) setRenderer(value); });
    }).catch(error => { if (current) setError(error instanceof Error ? error.message : 'plugin_renderer_failed'); });
    return () => { current = false; release?.(); };
  }, []);
  return { renderer, error };
}
