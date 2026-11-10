import { create } from 'zustand';
import { liveQuery } from 'dexie';
import { db, type ChatRow } from './db';
import { assertArtifactTarget, type ArtifactTarget } from './artifactEdit';
import { readConversationMessage } from './conversationProducts';
import { cloud } from '../cloud/state';
import { serverRuntime, isCurrentServerRuntime } from '../client/bootstrap';
import { accountLifecycle } from '../client/account-lifecycle';

export interface ArtifactDraft {
  open: boolean;
  instruction: string;
  context: string;
  next?: string;
  status: 'idle' | 'generating' | 'ready' | 'applying';
  error: string;
  notice: string;
}

export const EMPTY_ARTIFACT_DRAFT: ArtifactDraft = {
  open: false, instruction: '', context: '', status: 'idle', error: '', notice: '',
};

// Memory only: scrolling, collapsing or switching sessions must not cancel a paid request.
// Source identity isolates revisions; no generated result is ever automatically applied.
export const useArtifactDrafts = create<{ drafts: Record<string, ArtifactDraft> }>(() => ({ drafts: {} }));
const controllers = new Map<string, AbortController>();

export function artifactDraftKey(target: ArtifactTarget): string {
  return JSON.stringify([target.rowId, target.kind, target.location, target.widgetId ?? null, target.source]);
}

export function updateArtifactDraft(key: string, patch: Partial<ArtifactDraft>): void {
  useArtifactDrafts.setState(({ drafts }) => ({ drafts: { ...drafts, [key]: { ...(drafts[key] ?? EMPTY_ARTIFACT_DRAFT), ...patch } } }));
}

export function clearArtifactDraft(key: string): void {
  cancelArtifactDraft(key);
  useArtifactDrafts.setState(({ drafts }) => {
    const next = { ...drafts };
    delete next[key];
    return { drafts: next };
  });
}

export function cancelArtifactDraft(key: string): void {
  const controller = controllers.get(key);
  if (!controller) return;
  controllers.delete(key);
  controller.abort();
  const draft = useArtifactDrafts.getState().drafts[key];
  updateArtifactDraft(key, { status: draft?.next ? 'ready' : 'idle', notice: '已停止生成，原内容未修改。' });
}

export async function generateArtifactDraft(target: ArtifactTarget, mode: 'patch' | 'rewrite', libraries?: readonly string[]): Promise<void> {
  const key = artifactDraftKey(target);
  const draft = useArtifactDrafts.getState().drafts[key];
  if (!draft?.instruction.trim() || controllers.has(key) || draft.status === 'applying') return;
  const controller = new AbortController();
  const database = db, owner = cloud.userId, lifetime = accountLifecycle.current();
  const current = () => database === db && owner === cloud.userId && (!lifetime || lifetime.current());
  controllers.set(key, controller);
  updateArtifactDraft(key, { status: 'generating', error: '', notice: '' });
  let subscription: { unsubscribe(): void } | undefined;
  let releaseLifetime: (() => void) | undefined;
  const invalidate = (error: unknown) => {
    if (controller.signal.aborted) return;
    controllers.delete(key);
    controller.abort();
    updateArtifactDraft(key, { next: undefined, status: 'idle', error: error instanceof Error ? error.message : String(error) });
    subscription?.unsubscribe();
  };
  try {
    // Account disposal must stop an offscreen request even without another record event.
    releaseLifetime = lifetime?.own(() => invalidate(new Error('client_account_changed')));
    assertArtifactTarget(await readConversationMessage(target.rowId), target);
    if (!current()) throw new Error('client_account_changed');
    // Navigation is harmless; deleting/changing this target is not. Stop even while offscreen.
    if (cloud.enabled) {
      const runtime = await serverRuntime(owner);
      if (!current() || !isCurrentServerRuntime(runtime)) throw new Error('client_account_changed');
      const model = runtime.recordKeys({ kind: 'recordKeys', keys: [{ table: 'chats', key: target.rowId }] });
      const inspect = () => {
        if (!current()) { invalidate(new Error('client_account_changed')); return; }
        const snapshot = model.getSnapshot();
        if (snapshot.status === 'error') { invalidate(new Error(snapshot.error)); return; }
        if (snapshot.status !== 'ready') return;
        const value = snapshot.data as unknown as { records: { value: unknown }[] };
        try { assertArtifactTarget(value.records[0]?.value as ChatRow | undefined, target); } catch (error) { invalidate(error); }
      };
      const off = model.subscribe(inspect), release = model.acquire();
      subscription = { unsubscribe: () => { off(); release(); } };
      inspect();
    } else subscription = liveQuery(() => db.chats.get(target.rowId)).subscribe({
      next: (row) => { try { assertArtifactTarget(row, target); } catch (error) { invalidate(error); } },
      error: invalidate,
    });
    const { editArtifact, validateArtifact } = await import('../pipelines/artifactEdit');
    if (controller.signal.aborted) return;
    const next = await editArtifact({ kind: target.kind, source: target.source, instruction: draft.instruction,
      context: draft.context, libraries, mode, signal: controller.signal });
    if (controller.signal.aborted) return;
    await validateArtifact(target.kind, next, target.location === 'widget');
    assertArtifactTarget(await readConversationMessage(target.rowId), target);
    if (!current()) throw new Error('client_account_changed');
    if (!controller.signal.aborted) updateArtifactDraft(key, { next, status: 'ready' });
  } catch (error) {
    if (!controller.signal.aborted) updateArtifactDraft(key, {
      status: draft.next ? 'ready' : 'idle', error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    releaseLifetime?.();
    subscription?.unsubscribe();
    // An older cancelled request must not release or overwrite a newer one.
    if (controllers.get(key) === controller) controllers.delete(key);
  }
}
