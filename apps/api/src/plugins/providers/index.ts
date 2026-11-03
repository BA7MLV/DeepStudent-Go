import { flashcardsProvider } from './flashcards.js';
import { practiceProvider } from './practice.js';
import { reviewProvider } from './review.js';
import { materialToolsProvider } from './material-tools.js';
import type { PluginService } from '../service.js';

/** Compile-time native allowlist. Directory packages cannot register server code. */
export const nativeProviders = [flashcardsProvider, practiceProvider, reviewProvider, materialToolsProvider];
export function registerNativeProviders(service: PluginService) {
  for (const provider of nativeProviders) service.registerProvider(provider.package, () => provider.setup(service));
}
