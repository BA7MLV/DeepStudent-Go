import type { RuntimeJson, RuntimePatch } from './client-runtime.js';

const object = (value: RuntimeJson): value is { [key: string]: RuntimeJson } => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Value comparison preserves unchanged branches; never compares serialized payloads. */
export function reconcileRuntime(previous: RuntimeJson | undefined, next: RuntimeJson): RuntimeJson {
  if (Object.is(previous, next)) return next;
  if (Array.isArray(previous) && Array.isArray(next)) {
    const values = next.map((value, index) => reconcileRuntime(previous[index], value));
    return previous.length === values.length && values.every((value, index) => value === previous[index]) ? previous : values;
  }
  if (previous !== undefined && object(previous) && object(next)) {
    const values = Object.fromEntries(Object.entries(next).map(([key, value]) => [key, reconcileRuntime(previous[key], value)]));
    return Object.keys(previous).length === Object.keys(values).length && Object.entries(values).every(([key, value]) => previous[key] === value) ? previous : values;
  }
  return next;
}

export function diffRuntime(previous: RuntimeJson, next: RuntimeJson, path: string[] = []): RuntimePatch[] {
  if (Object.is(previous, next)) return [];
  if (object(previous) && object(next)) {
    const changes: RuntimePatch[] = [];
    for (const key of Object.keys(previous)) if (!Object.hasOwn(next, key)) changes.push({ path: [...path, key], remove: true });
    for (const [key, value] of Object.entries(next)) {
      if (!Object.hasOwn(previous, key)) changes.push({ path: [...path, key], value });
      else changes.push(...diffRuntime(previous[key]!, value, [...path, key]));
    }
    return changes;
  }
  const value = reconcileRuntime(previous, next);
  return value === previous ? [] : [{ path, value: next }];
}

export function applyRuntimePatch(value: RuntimeJson, changes: RuntimePatch[]): RuntimeJson {
  const apply = (current: RuntimeJson, patch: RuntimePatch, depth: number): RuntimeJson => {
    if (depth === patch.path.length) {
      if (patch.remove || patch.value === undefined) throw new Error('protocol_invalid_root_patch');
      return reconcileRuntime(current, patch.value);
    }
    if (!object(current)) throw new Error('protocol_invalid_patch_path');
    const key = patch.path[depth]!;
    const next = { ...current };
    if (depth === patch.path.length - 1 && patch.remove) delete next[key];
    else {
      if (depth + 1 < patch.path.length && !Object.hasOwn(current, key)) throw new Error('protocol_missing_patch_parent');
      Object.defineProperty(next, key, { value: apply(current[key] ?? null, patch, depth + 1), enumerable: true, writable: true, configurable: true });
    }
    return next;
  };
  return changes.reduce((current, patch) => apply(current, patch, 0), value);
}
