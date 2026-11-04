import { Context } from '@deepseek-ai/cordis';
import { Component, createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { apply as installRenderer } from '@deepseek-ai/dsh-client-ui-renderer/client';
import type { PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots';
import type { PluginHostContext, PluginInstance, PluginPackage, PluginPlacement } from '@wangke/contracts/plugins';
import { PluginView } from '../plugins/PluginView';
import { PluginSlotView, type PluginSlotProps } from '../plugins/PluginSlotView';
import { PluginActionsView, type PluginActionsProps } from '../plugins/PluginActionsView';
import { pluginCatalogSource, pluginCatalogDiagnostics } from '../plugins/catalog';
import { nativeViewProviders } from '../plugins/builtins';
import { callPlugin, callPluginAction, observePlugin } from './plugins';
import { pluginProjectionKey, pluginProjectionSource } from './plugin-projection';
import type { ModelSnapshot } from '@wangke/client-core';
import type { KeyedSnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots';
import type { PluginQuery } from './plugins';
import { PluginPageView } from '../plugins/PluginPageView';
import { PluginMessageView, type PluginMessageProps } from '../plugins/PluginMessageView';
import { PluginNavigationView, type PluginNavigationProps } from '../plugins/PluginNavigationView';
import { createPluginScopes, type PlacementLease } from './plugin-scopes';
import { cloud } from '../cloud/state';
import { API_BASE_URL } from '../api/base';

const PlacementOwner = createContext<PlacementLease | undefined>(undefined);
class PluginErrorBoundary extends Component<{ children: ReactNode; onFailure(): void }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch() { this.props.onFailure(); }
  render() { return this.state.failed ? <p role="alert">插件视图出错，历史数据已保留</p> : this.props.children; }
}

export interface PluginOccurrence {
  plugin: PluginPackage;
  instance: PluginInstance;
  placement: PluginPlacement;
  context: PluginHostContext;
}

declare module '@deepseek-ai/dsh-client-ui-renderer/client' {
  interface RootOwnerProps { occurrence?: PluginOccurrence; surface?: PluginSlotProps; actions?: PluginActionsProps; page?: boolean; message?: PluginMessageProps; navigation?: PluginNavigationProps }
}
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'wangke.plugin.view': { kind: 'single'; scope: 'root'; owner: PluginOccurrence };
    'wangke.plugin.surface': { kind: 'single'; scope: 'root'; owner: PluginSlotProps };
    'wangke.plugin.actions': { kind: 'single'; scope: 'root'; owner: PluginActionsProps };
    'wangke.plugin.native': { kind: 'keyed'; scope: 'root'; owner: PluginOccurrence };
    'wangke.plugin.page': { kind: 'single'; scope: 'root'; owner: Record<string, never> };
    'wangke.plugin.message': { kind: 'single'; scope: 'root'; owner: PluginMessageProps };
    'wangke.plugin.navigation': { kind: 'single'; scope: 'root'; owner: PluginNavigationProps };
  }
}

function PluginOutlet({ occurrence, surface, actions, page, message, navigation, renderSlot }: PropsRuntime<'root'> & PropsRenderSlots<'wangke.plugin.view' | 'wangke.plugin.surface' | 'wangke.plugin.actions' | 'wangke.plugin.page' | 'wangke.plugin.message' | 'wangke.plugin.navigation'>) {
  return occurrence ? renderSlot('wangke.plugin.view', occurrence) : surface ? renderSlot('wangke.plugin.surface', surface) : actions ? renderSlot('wangke.plugin.actions', actions)
    : page ? renderSlot('wangke.plugin.page', {}) : message ? renderSlot('wangke.plugin.message', message) : navigation ? renderSlot('wangke.plugin.navigation', navigation) : null;
}

/** Only committed outlets retain this Cordis tree. No resource is acquired in render.
 * The root can occur in any existing surface without mounting a second React root.
 * Sandboxed documents remain data, never Cordis contributions. */
export async function createPluginRenderer() {
  const ctx = new Context();
  const scopes = createPluginScopes(ctx);
  const projectionOwners = new Map<number, PlacementLease>();
  const projectionSources = new WeakMap<PlacementLease, Map<string, { getSnapshot(): ModelSnapshot; subscribe(listener: () => void): () => void }>>();
  const scopedProjectionSource = (encoded: string) => {
    const { incarnation, key } = JSON.parse(encoded) as { incarnation: number; key: string };
    const lease = projectionOwners.get(incarnation);
    if (!lease) return undefined;
    let sources = projectionSources.get(lease);
    if (!sources) { sources = new Map(); projectionSources.set(lease, sources); }
    let source = sources.get(key);
    if (!source) {
      const bare = pluginProjectionSource(key);
      source = { getSnapshot: () => bare.getSnapshot(), subscribe: listener => lease.current() ? lease.own(() => bare.subscribe(() => { if (lease.current()) listener(); })) : () => {} };
      sources.set(key, source);
      if (sources.size > 256) sources.delete(sources.keys().next().value!);
    }
    return source;
  };
  scopeDiagnostics.set(ctx, scopes.diagnostics);
  const sessionEnded = () => scopes.invalidate();
  window.addEventListener('wangke:bot-session-ended', sessionEnded);
  ctx.effect(() => () => window.removeEventListener('wangke:bot-session-ended', sessionEnded), 'plugin account invalidation');
  live.add(ctx);
  try {
    await ctx.plugin(installRenderer);
    // The upstream renderer resolves this standard seat even for root outlets.
    // No DSH product Session identity is substituted for our account/instance.
    const absent = { key: undefined, hooks: {}, keyedHooks: {}, props: {} };
    const source = { getSnapshot: () => absent, subscribe: () => () => {} };
    ctx.slots.installScope('session', { current: source, bindingSource: () => source });
    ctx.slots.register({ name: 'root', children: { 'wangke.plugin.view': { kind: 'single', scope: 'root' }, 'wangke.plugin.surface': { kind: 'single', scope: 'root' }, 'wangke.plugin.actions': { kind: 'single', scope: 'root' }, 'wangke.plugin.page': { kind: 'single', scope: 'root' }, 'wangke.plugin.message': { kind: 'single', scope: 'root' }, 'wangke.plugin.navigation': { kind: 'single', scope: 'root' } } }, PluginOutlet);
    function ScopedPluginView(props: Parameters<typeof PluginView>[0]) {
      const [owned, setOwned] = useState<{ key: string; lease: PlacementLease }>();
      const account = cloud.userId || 'local';
      const project = props.context.projectId ?? (props.instance.scope?.kind === 'project' ? props.instance.scope.id : 'account');
      const available = !!props.plugin.manifest?.enabled && !props.plugin.error && props.plugin.installation !== 'uninstalled' && !!props.plugin.manifest.views[props.placement.viewId];
      const key = JSON.stringify([account, project, props.plugin.id, props.instance.id, props.placement.id, props.plugin.revision]);
      const lease = owned?.key === key ? owned.lease : undefined;
      useEffect(() => {
        if (!available) { setOwned(undefined); return; }
        const owned = scopes.acquire({ server: API_BASE_URL || location.origin, account, project, instance: `${props.plugin.id}:${props.instance.id}`, placement: props.placement.id, revision: props.plugin.revision });
        projectionOwners.set(owned.incarnation, owned);
        setOwned({ key, lease: owned });
        const ended = () => { setOwned(undefined); };
        window.addEventListener('wangke:bot-session-ended', ended);
        return () => { window.removeEventListener('wangke:bot-session-ended', ended); projectionOwners.delete(owned.incarnation); owned.release(); };
      }, [key, available]);
      const call = useCallback<typeof callPlugin>(async (...args) => {
        if (!lease) throw new Error('plugin_scope_pending');
        lease.assertCurrent();
        const result = await callPlugin(...args);
        lease.assertCurrent();
        return result;
      }, [lease]);
      const observe = useCallback<typeof observePlugin>((identity, method, args, listener, failed) => {
        if (!lease) { failed(new Error('plugin_scope_pending')); return () => {}; }
        return lease.own(() => observePlugin(identity, method, args, value => { if (lease.current()) listener(value); }, error => { if (lease.current()) failed(error); }));
      }, [lease]);
      if (!available) return <p role="alert">插件视图不可用，历史数据已保留</p>;
      return lease?.current() ? <PlacementOwner.Provider value={lease}><PluginErrorBoundary key={lease.incarnation} onFailure={scopes.recordFailure}><PluginView {...props} draftIdentity={JSON.stringify([API_BASE_URL || location.origin, account, project, props.plugin.id, props.instance.id, props.placement.id, props.context.materialId])} callPlugin={call} observePlugin={observe} /></PluginErrorBoundary></PlacementOwner.Provider> : <p aria-busy="true">加载插件视图…</p>;
    }
    ctx.slots.register({ name: 'wangke.plugin.view', children: { 'wangke.plugin.native': { kind: 'keyed', scope: 'root' } }, inject: () => ({ callPlugin, observePlugin }) }, ScopedPluginView);
    for (const provider of nativeViewProviders) for (const [viewId, Component] of Object.entries(provider.views)) {
      function NativeContribution({ usePluginProjection, callPlugin, ...props }: PropsRuntime<'wangke.plugin.native'> & { usePluginProjection: KeyedSnapshotSelectorHook<ModelSnapshot>; callPlugin: typeof import('./plugins').callPlugin }) {
        const { plugin, instance } = props;
        const lease = useContext(PlacementOwner);
        const call = useCallback(async (method: string, args: Record<string, unknown> = {}) => {
          if (!lease) throw new Error('plugin_scope_pending');
          lease.assertCurrent();
          const result = await callPlugin({ pluginId: plugin.id, instanceId: instance.id, revision: plugin.revision }, method, args);
          lease.assertCurrent(); return result;
        }, [plugin.id, instance.id, plugin.revision, callPlugin, lease]);
        const useProjection = (queries: PluginQuery[]) => usePluginProjection(JSON.stringify({ incarnation: lease?.incarnation, key: pluginProjectionKey({ pluginId: plugin.id, instanceId: instance.id, revision: plugin.revision }, queries) })) ?? { status: 'loading' as const };
        return <Component {...props} draftIdentity={JSON.stringify([API_BASE_URL || location.origin, cloud.userId, props.context.projectId, plugin.id, instance.id, props.placement.id])} call={call} useProjection={useProjection} />;
      }
      ctx.slots.register({ name: 'wangke.plugin.native', key: `${provider.id}:${viewId}`, inject: () => ({ callPlugin, keyedHooks: { pluginProjection: scopedProjectionSource } }) }, NativeContribution);
    }
    ctx.slots.register({ name: 'wangke.plugin.surface', inject: () => ({ hooks: { catalog: pluginCatalogSource }, serverEnabled: cloud.enabled }) }, PluginSlotView);
    ctx.slots.register({ name: 'wangke.plugin.actions', inject: () => ({ hooks: { catalog: pluginCatalogSource }, serverEnabled: cloud.enabled, callAction: callPluginAction }) }, PluginActionsView);
    ctx.slots.register({ name: 'wangke.plugin.page', inject: () => ({ hooks: { catalog: pluginCatalogSource } }) }, PluginPageView);
    ctx.slots.register({ name: 'wangke.plugin.message', inject: () => ({ hooks: { catalog: pluginCatalogSource } }) }, PluginMessageView);
    ctx.slots.register({ name: 'wangke.plugin.navigation', inject: () => ({ hooks: { catalog: pluginCatalogSource } }) }, PluginNavigationView);
    let disposal: Promise<void> | undefined;
    const dispose = () => disposal ??= (async () => {
      try { scopes.invalidate(); await ctx.fiber.dispose(); await scopes.settled(); }
      finally {
        const final = scopes.diagnostics();
        for (const key of ['created', 'released', 'failures', 'observationReleases'] as const) retired[key] += final[key];
        live.delete(ctx); scopeDiagnostics.delete(ctx);
      }
    })();
    return {
      render: (occurrence: PluginOccurrence) => ctx.slots.renderSlot('root', { occurrence }),
      renderSurface: (surface: PluginSlotProps) => ctx.slots.renderSlot('root', { surface }),
      renderActions: (actions: PluginActionsProps) => ctx.slots.renderSlot('root', { actions }),
      renderPage: () => ctx.slots.renderSlot('root', { page: true }),
      renderMessage: (message: PluginMessageProps) => ctx.slots.renderSlot('root', { message }),
      renderNavigation: (navigation: PluginNavigationProps) => ctx.slots.renderSlot('root', { navigation }),
      diagnostics: () => ({ slots: ctx.slots.snapshot(), lifecycle: scopes.diagnostics() }),
      dispose,
    };
  } catch (error) { try { await ctx.fiber.dispose(); } finally { live.delete(ctx); scopeDiagnostics.delete(ctx); } throw error; }
}

type Renderer = Awaited<ReturnType<typeof createPluginRenderer>>;
const live = new Set<Context>();
const scopeDiagnostics = new Map<Context, ReturnType<typeof createPluginScopes>['diagnostics']>();
const retired = { created: 0, released: 0, failures: 0, observationReleases: 0 };
export const pluginScopeDiagnostics = () => [...scopeDiagnostics.values()].map(read => read());
export const pluginLifecycleDiagnostics = () => ({ renderer: pluginRendererDiagnostics(), scopes: pluginScopeDiagnostics(), catalog: pluginCatalogDiagnostics(), retired: { ...retired } });
let active: { ready: Promise<Renderer>; refs: number } | undefined;
export const pluginRendererDiagnostics = () => ({ refs: active?.refs ?? 0, contexts: live.size });
export function acquirePluginRenderer() {
  const owned = active ??= { ready: createPluginRenderer(), refs: 0 };
  owned.refs++;
  let released = false;
  return { ready: owned.ready, release: () => {
    if (released) return;
    released = true;
    if (--owned.refs !== 0) return;
    if (active === owned) active = undefined;
    void owned.ready.then(renderer => renderer.dispose()).catch(() => {});
  } };
}
