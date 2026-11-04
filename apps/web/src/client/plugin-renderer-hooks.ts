import { useSyncExternalStore } from 'react';
import { pluginCatalogSource } from '../plugins/catalog';

/** The renderer boundary is the only bare-source -> React bridge, including
 * legacy menu adapters that cannot render a named outlet themselves. */
export function usePluginCatalogSnapshot() {
  return useSyncExternalStore(pluginCatalogSource.subscribe, pluginCatalogSource.getSnapshot);
}
