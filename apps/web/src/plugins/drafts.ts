/** Tab/mount-only navigation state. This is never a learning record. */
export function readPluginNumberDraft(key: string): number | undefined {
  try {
    const raw = sessionStorage.getItem(key);
    const value = raw ? Number(raw) : NaN;
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch { return undefined; }
}
export function writePluginNumberDraft(key: string, value: number) {
  try { sessionStorage.setItem(key, String(value)); } catch { /* Optional drafts. */ }
}
