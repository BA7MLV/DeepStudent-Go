import { create } from 'zustand';
import { accountLifecycle } from '../client/account-lifecycle';

/** Immediate resource failures survive leaving/re-entering the library. Pending
 * command receipts remain in the existing durable sync recovery, not here. */
export const useResourceFeedback = create<{ error: string | null; setError: (error: string | null) => void }>(set => ({
  error: null,
  setError: error => set({ error }),
}));
accountLifecycle.onDisposed(() => useResourceFeedback.getState().setError(null));
