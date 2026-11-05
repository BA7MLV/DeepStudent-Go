/** Display-only server stop metadata. Browser agent execution has been retired. */
export type StopReason = 'rounds' | 'loop' | 'tokens' | 'empty' | 'error';
export interface AgentStopInfo {
  reason: StopReason;
  rounds: number;
  detail?: string;
  requestedTools: string[];
  granted: boolean;
}
