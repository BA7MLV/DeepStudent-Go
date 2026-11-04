import type { ReactNode } from 'react';
import type { PluginCatalog, pluginCatalogSource } from './catalog';

export interface PluginNavigationProps { children(catalog: PluginCatalog | undefined): ReactNode }
export function PluginNavigationView({ children, useCatalog }: PluginNavigationProps & { useCatalog: <T>(select: (value: ReturnType<typeof pluginCatalogSource.getSnapshot>) => T) => T }) {
  return children(useCatalog(snapshot => snapshot.data));
}
