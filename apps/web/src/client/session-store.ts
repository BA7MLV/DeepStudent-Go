import { useStore } from 'zustand';
import { ConversationSessionModel } from '@wangke/client-core';
import type { SessionMessage, SessionRow } from '@wangke/client-core';

/** Compatibility facade, not a second conversation store. Shell fields/actions
 * live here; all per-session values live exclusively in SessionStateModel.
 * getState composes a cached adapter snapshot for old command consumers. */
export function createSessionStore<View extends object, State extends View & { activeId: number | null }, Message extends SessionMessage, Row extends SessionRow>(
  empty: View, convert: (row: Row) => Message, initialize: (set: (patch: Partial<State> | ((state: State) => Partial<State>)) => void, get: () => State) => State,
) {
  const models = new Map<number, ConversationSessionModel<View, Message, Row>>();
  const listeners = new Set<(state: State, previous: State) => void>();
  const fields = new Set(Object.keys(empty));
  let shell: any, snapshot: State, batching = false;
  const publish = () => {
    if (batching || !shell) return;
    const previous = snapshot;
    snapshot = { ...shell, ...model(shell.activeId ?? 0).getSnapshot() };
    for (const listener of listeners) listener(snapshot, previous);
  };
  const model = (id: number) => {
    let value = models.get(id);
    if (!value) {
      value = new ConversationSessionModel(id, { ...empty }, convert, callback => {
        // Background tabs throttle rAF indefinitely; the timeout bounds delivery.
        let done = false;
        const run = () => { if (done) return; done = true; cancelAnimationFrame(frame); clearTimeout(timer); callback(); };
        const frame = requestAnimationFrame(run), timer = setTimeout(run, 80);
        return () => { done = true; cancelAnimationFrame(frame); clearTimeout(timer); };
      });
      models.set(id, value);
      value.subscribe(() => { if (shell?.activeId === id || id === 0 && shell?.activeId == null) publish(); });
    }
    return value;
  };
  const setState = (update: Partial<State> | ((state: State) => Partial<State>)) => {
    const patch = typeof update === 'function' ? update(snapshot) : update;
    batching = true;
    const view: Partial<View> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (fields.has(key)) (view as any)[key] = value; else shell[key] = value;
    }
    model(shell.activeId ?? 0).set(view);
    batching = false; publish();
  };
  const initial = initialize(setState, () => snapshot);
  shell = Object.fromEntries(Object.entries(initial).filter(([key]) => !fields.has(key)));
  model(shell.activeId ?? 0).set(Object.fromEntries(Object.entries(initial).filter(([key]) => fields.has(key))) as Partial<View>);
  snapshot = { ...shell, ...model(shell.activeId ?? 0).getSnapshot() };
  const api = { getState: () => snapshot, getInitialState: () => snapshot, setState,
    subscribe: (listener: (state: State, previous: State) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    model, models,
    clearModels: () => { for (const value of models.values()) value.dispose(); models.clear(); },
  };
  return Object.assign(<T,>(selector: (state: State) => T) => useStore(api, selector), api);
}
