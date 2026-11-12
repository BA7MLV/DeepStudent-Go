export interface TaskFailure { reason: string; rejected: boolean }

/** Keep stable server reasons, not localized text, in the private draft journal.
 * Missing/legacy details and transport failures must never imply non-execution. */
export function taskFailure(error: unknown): TaskFailure {
  const remote = error as { code?: string; detail?: { code?: string; admissionRejected?: boolean } } | null;
  const domain = remote?.code === 'client/domain';
  return {
    reason: domain && typeof remote.detail?.code === 'string' ? remote.detail.code : remote?.code === 'gateway/cancelled' ? 'aborted' : error instanceof Error ? error.message : String(error),
    rejected: domain && remote.detail?.admissionRejected === true,
  };
}
