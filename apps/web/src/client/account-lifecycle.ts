/** One terminal identity for account-owned browser work. Account strings are not
 * identities: A -> B -> A and rebuilding A both create a fresh lifetime. */
export interface AccountLifetime {
  readonly account: string;
  readonly signal: AbortSignal;
  current(): boolean;
  assertCurrent(): void;
  /** Release at terminal invalidation (including late acquisitions). Returns an
   * unregister function, not an immediate resource disposer. */
  own(dispose: () => void | Promise<unknown>): () => void;
}

export function createAccountLifecycle() {
  let active: AccountLifetime | undefined;
  let release: (() => void) | undefined;
  const observers = new Set<() => void>();
  const pending = new Set<Promise<unknown>>();
  const run = (dispose: () => void | Promise<unknown>) => {
    try {
      const work = Promise.resolve(dispose()).catch(error => { console.error('client_account_disposal_failed', error); }).finally(() => pending.delete(work));
      pending.add(work);
    } catch (error) { console.error('client_account_disposal_failed', error); }
  };
  const invalidate = () => {
    const oldRelease = release;
    active = undefined; release = undefined;
    oldRelease?.();
    for (const observer of [...observers]) run(observer);
  };
  const acquire = (account: string): AccountLifetime => {
    if (!account) throw new Error('client_unauthenticated');
    if (active?.account === account) return active;
    if (active) invalidate();
    const controller = new AbortController();
    const resources = new Set<() => void | Promise<unknown>>();
    const lifetime: AccountLifetime = {
      account, signal: controller.signal,
      current: () => active === lifetime && !controller.signal.aborted,
      assertCurrent() { if (!lifetime.current()) throw new Error('client_account_changed'); },
      own(dispose) {
        if (!lifetime.current()) { run(dispose); return () => {}; }
        resources.add(dispose);
        return () => { resources.delete(dispose); };
      },
    };
    active = lifetime;
    release = () => {
      controller.abort(new Error('client_account_changed'));
      for (const dispose of [...resources]) { resources.delete(dispose); run(dispose); }
    };
    return lifetime;
  };
  return { acquire, invalidate, current: () => active,
    onDisposed(dispose: () => void) { observers.add(dispose); return () => { observers.delete(dispose); }; },
    async settled() { while (pending.size) await Promise.allSettled([...pending]); },
  };
}

export const accountLifecycle = createAccountLifecycle();
export const accountLifetime = accountLifecycle.acquire;
export const invalidateAccountLifetime = accountLifecycle.invalidate;
