import { type ComponentType } from 'react';
import type { PluginHostContext, PluginInstance, PluginPackage, PluginPlacement } from '@wangke/contracts/plugins';
import type { PluginProjectionHook } from '../client/plugin-projection';

export interface BuiltinViewProps { plugin: PluginPackage; instance: PluginInstance; placement: PluginPlacement; context: PluginHostContext; draftIdentity?: string; useProjection: PluginProjectionHook; call: (method: string, args?: Record<string, unknown>) => Promise<unknown> }
/** Only this compile-time registry may load React code; directory packages stay sandboxed. */
export interface NativeViewProvider { id: string; views: Record<string, ComponentType<BuiltinViewProps>> }
const modules = import.meta.glob<{ default: NativeViewProvider }>('./providers/*.provider.ts', { eager: true });
export const nativeViewProviders = Object.values(modules).map(module => module.default);
