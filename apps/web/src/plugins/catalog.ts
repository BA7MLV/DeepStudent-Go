import { useSyncExternalStore } from 'react';
import type { PluginPackage, PluginScopes } from '@wangke/contracts/plugins';
import type { SystemDocument } from '@wangke/contracts/system';
import { clearPluginReads, pluginRead, subscribePluginRead } from './shared';
import { cloud } from '../cloud/state';
import { localPluginLayout, localPluginPackages } from './availability';

export interface PluginCatalog { plugins: PluginPackage[]; layout: SystemDocument; scopes?: PluginScopes; local?: boolean }
const readCatalog = async (): Promise<PluginCatalog> => {
  if (cloud.enabled) return pluginRead<PluginCatalog>('/plugins');
  const layout = localPluginLayout(); return { local: true, plugins: localPluginPackages(JSON.parse(layout.content)), layout };
};
let snapshot: { data?: PluginCatalog; error?: string } = {};
const listeners = new Set<() => void>();
let stop: (() => void) | undefined;
let generation = 0;
const getSnapshot = () => snapshot;
const notify = () => { for (const fn of listeners) fn(); };
export async function refreshPlugins() {
  const before = generation;
  try { clearPluginReads(); const data = await readCatalog(); if (before !== generation) return; snapshot = { data }; notify(); }
  catch (e) { if (before !== generation) return; snapshot = { ...snapshot, error: e instanceof Error ? e.message : 'plugin_request_failed' }; notify(); }
}
const start = () => {
  const before = generation;
  if (!stop) stop = subscribePluginRead('catalog', readCatalog, data => { if (before !== generation) return; snapshot = { data: data as PluginCatalog }; notify(); });
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  start();
  return () => { listeners.delete(listener); if (!listeners.size) { stop?.(); stop = undefined; snapshot = {}; } };
};
window.addEventListener('system-files-changed', () => { if (listeners.size) void refreshPlugins(); });
window.addEventListener('storage', () => { if (listeners.size) void refreshPlugins(); });
window.addEventListener('wangke:bot-session-ended', () => { generation++; stop?.(); stop = undefined; snapshot = {}; notify(); if (listeners.size) start(); });
export function usePluginCatalog() { return useSyncExternalStore(subscribe, getSnapshot); }
export function usePluginAvailable(id: string) { const { data } = usePluginCatalog(); return !!data?.plugins.some(p => p.id === id && !p.error && p.manifest?.enabled); }
