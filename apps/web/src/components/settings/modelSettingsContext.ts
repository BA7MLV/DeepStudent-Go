import { createContext, useContext } from 'react';
import { useStore, type StoreApi } from 'zustand';
import type { SettingsStore } from '../../store/settings';

export type ModelSettingsState = SettingsStore;
/** The editor only receives an unpersisted server-settings draft from Models. */
export const ModelSettingsContext = createContext<StoreApi<ModelSettingsState> | null>(null);
export const useModelSettingsStore = () => {
  const draft = useContext(ModelSettingsContext);
  if (!draft) throw new Error('server_model_settings_provider_required');
  return draft;
};
const identity = (state: ModelSettingsState) => state;
export function useModelSettings<T = ModelSettingsState>(selector: (state: ModelSettingsState) => T = identity as (state: ModelSettingsState) => T): T {
  return useStore(useModelSettingsStore(), selector);
}
