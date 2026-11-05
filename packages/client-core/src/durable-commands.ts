/** Ports deliberately contain no React, browser globals, cache or storage API. */
export interface DurableCommand<Request> { operationId: string; request: Request; state: 'queued' | 'uncertain' | 'conflict'; error?: string; entities?: string[] }
export interface CommandJournal<Request> {
  list(): Promise<DurableCommand<Request>[]>;
  save(command: DurableCommand<Request>): Promise<void>;
  remove(operationId: string): Promise<void>;
  /** Keep an overlay until the acknowledged authoritative versions arrive. */
  acknowledge?(operationId: string, value: unknown): Promise<void>;
}
export type CommandReceipt = { status: 'missing' | 'pending' | 'uncertain' | 'failed'; code?: string } | { status: 'completed'; value: unknown };
/** Every send is preceded by a receipt lookup. Uncertain external effects never
 * auto-replay. The caller declares whether an endpoint is durably SQL-idempotent. */
export class DurableCommands<Request> {
  private flight?: Promise<void>;
  private disposed = false;
  private again = false;
  constructor(private readonly journal: CommandJournal<Request>, private readonly port: {
    receipt(operationId: string): Promise<CommandReceipt>;
    send(request: Request): Promise<unknown>;
    current(): boolean;
    replaySafe: boolean;
    isolateFailures?: boolean;
  }) {}
  private guard() { if (this.disposed || !this.port.current()) throw new Error('client_account_changed'); }
  drain(): Promise<void> {
    this.again = true;
    if (this.flight) return this.flight;
    this.flight = (async () => {
      while (this.again) { this.again = false; await this.run(); }
    })().finally(() => { this.flight = undefined; });
    return this.flight;
  }
  private async run() {
    this.guard();
    const blocked = new Set<string>();
    const acknowledge = async (operationId: string, value: unknown) => {
      this.guard();
      if (this.journal.acknowledge) await this.journal.acknowledge(operationId, value);
      else await this.journal.remove(operationId);
    };
    for (const command of await this.journal.list()) {
      this.guard();
      if (this.port.isolateFailures && (command.state === 'conflict' || command.entities?.some(key => blocked.has(key)))) {
        command.entities?.forEach(key => blocked.add(key)); continue;
      }
      if (command.state === 'conflict') throw new Error(command.error ?? 'command_conflict');
      try {
        const receipt = await this.port.receipt(command.operationId); this.guard();
        if (receipt.status === 'completed') { await acknowledge(command.operationId, receipt.value); continue; }
        if (receipt.status !== 'missing' || command.state === 'uncertain' && !this.port.replaySafe) throw new Error('command_requires_reconciliation');
        await this.journal.save({ ...command, state: 'uncertain' }); this.guard();
        const value = await this.port.send(command.request); this.guard();
        await acknowledge(command.operationId, value);
      } catch (error) {
        // Never write an old account's error into a newly selected journal.
        this.guard();
        const conflict = ['client/record-conflict', 'client/conflict', ...(this.port.isolateFailures ? ['client/domain', 'gateway/forbidden', 'gateway/unauthorized'] : [])].includes((error as { code?: string }).code ?? '');
        await this.journal.save({ ...command, state: conflict ? 'conflict' : 'uncertain', error: error instanceof Error ? error.message : String(error) });
        if (!this.port.isolateFailures) throw error;
        command.entities?.forEach(key => blocked.add(key));
      }
    }
  }
  dispose() { this.disposed = true; }
}
