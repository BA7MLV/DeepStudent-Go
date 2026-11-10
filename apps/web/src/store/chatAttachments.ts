import { create } from 'zustand';
import i18n from '../i18n';
import { MAX_CHAT_ATTACHMENTS, type ChatAttachment } from '../chat/attachments';
import { prepareAttachment, removeAttachmentFile } from '../chat/prepareAttachment';

export const ATTACHMENTS_PENDING_ERROR = '请等待附件就绪，或重试 / 移除失败的附件后发送';

interface PendingAttachment {
  id: string;
  sessionKey: string;
  file: File;
  phase: string;
  value?: ChatAttachment;
  error?: string;
  editing?: boolean;
}

interface AttachmentDraft {
  sessionKey: string;
  items: PendingAttachment[];
  parked: Record<string, PendingAttachment[]>;
  error: string | null;
  bind: (sessionId: number | null) => void;
  discard: (sessionId: number | null) => Promise<void>;
  add: (files: File[]) => void;
  retry: (id: string) => void;
  replace: (id: string, file: File) => Promise<void>;
  remove: (id: string) => Promise<void>;
  consume: (ids: string[]) => void;
}

let sequence = 0;
function hasPendingItem(get: () => AttachmentDraft, item: PendingAttachment): boolean {
  const state = get();
  const items = state.sessionKey === item.sessionKey ? state.items : state.parked[item.sessionKey] ?? [];
  return items.some((row) => row.id === item.id);
}

export const useChatAttachments = create<AttachmentDraft>((set, get) => {
  const process = async (item: PendingAttachment) => {
    const hasItem = () => {
      const state = get();
      const items = state.sessionKey === item.sessionKey ? state.items : state.parked[item.sessionKey] ?? [];
      return items.some((row) => row.id === item.id);
    };
    const patch = (updates: Partial<PendingAttachment>) => set((state) => {
      const update = (items: PendingAttachment[]) => items.map((row) => row.id === item.id ? { ...row, ...updates } : row);
      if (state.sessionKey === item.sessionKey) {
        const items = update(state.items);
        return { items, ...(state.error === ATTACHMENTS_PENDING_ERROR && items.every(row => row.value && !row.error && !row.editing) ? { error: null } : {}) };
      }
      return { parked: { ...state.parked, [item.sessionKey]: update(state.parked[item.sessionKey] ?? []) } };
    });
    patch({ error: undefined, phase: '加载中' });
    try {
      const value = await prepareAttachment(item.id, item.file, (phase) => patch({ phase }));
      if (!hasItem()) {
        await removeAttachmentFile(value);
        return;
      }
      patch({ value, phase: '就绪' });
    } catch (error) { patch({ error: error instanceof Error ? error.message : String(error), phase: '失败' }); }
  };
  return {
    sessionKey: '0', items: [], parked: {}, error: null,
    bind: (sessionId) => {
      const nextKey = String(sessionId ?? 0);
      if (nextKey === get().sessionKey) return;
      set((state) => {
        const parked = { ...state.parked };
        if (state.items.length) parked[state.sessionKey] = state.items;
        else delete parked[state.sessionKey];
        const nextItems = parked[nextKey] ?? [];
        delete parked[nextKey];
        return { sessionKey: nextKey, items: nextItems, parked, error: null };
      });
    },
    discard: async (sessionId) => {
      const key = String(sessionId ?? 0);
      const state = get();
      const items = state.sessionKey === key ? state.items : state.parked[key] ?? [];
      if (state.sessionKey === key) set({ items: [], error: null });
      else set((current) => {
        const parked = { ...current.parked };
        delete parked[key];
        return { parked };
      });
      await Promise.allSettled(items.flatMap((item) => item.value ? [removeAttachmentFile(item.value)] : []));
    },
    add: (files) => {
      const available = MAX_CHAT_ATTACHMENTS - get().items.length;
      const sessionKey = get().sessionKey;
      const items = files.slice(0, available).map((file) => ({ sessionKey, id: `chat-file-${Date.now()}-${sequence++}-${Math.random().toString(36).slice(2)}`, file, phase: '加载中' }));
      set((state) => ({ items: [...state.items, ...items], error: files.length > available ? `每条消息最多 ${MAX_CHAT_ATTACHMENTS} 个附件，多出的文件未添加` : null }));
      // Bound parsing/upload memory; large PDFs and images should not all decode concurrently.
      void (async () => { for (const item of items) if (hasPendingItem(get, item)) await process(item); })();
    },
    retry: (id) => { const item = get().items.find((row) => row.id === id); if (item?.error) void process(item); },
    replace: async (id, file) => {
      const original = get().items.find(row => row.id === id);
      if (!original?.value || original.editing || original.error) throw new Error(i18n.t('interface:imageCrop.wait'));
      const update = (change: (row: PendingAttachment) => PendingAttachment) => set(state => {
        const apply = (items: PendingAttachment[]) => items.map(row => row.id === id ? change(row) : row);
        return state.sessionKey === original.sessionKey ? { items: apply(state.items) }
          : { parked: { ...state.parked, [original.sessionKey]: apply(state.parked[original.sessionKey] ?? []) } };
      });
      // Keep the old attachment until the replacement is safely stored. A failed
      // crop upload restores the usable original rather than destroying the draft.
      update(row => ({ ...row, editing: true, phase: i18n.t('interface:imageCrop.savePhase') }));
      const nextId = `chat-file-${crypto.randomUUID()}`;
      let value: ChatAttachment;
      try {
        value = await prepareAttachment(nextId, file, phase => update(row => ({ ...row, phase })));
      } catch (error) {
        update(() => original);
        throw error;
      }
      if (!hasPendingItem(get, original)) { await removeAttachmentFile(value); return; }
      update(() => ({ id: nextId, sessionKey: original.sessionKey, file, value, phase: i18n.t('interface:imageCrop.ready') }));
      // Only the superseded draft snapshot is disposable; message files are never edited.
      void removeAttachmentFile(original.value).catch(() => {
        if (get().sessionKey === original.sessionKey) set({ error: i18n.t('interface:imageCrop.cleanupFailed') });
      });
    },
    remove: async (id) => {
      const item = get().items.find((row) => row.id === id);
      set((state) => ({ items: state.items.map((row) => row.id === id ? { ...row, value: undefined, phase: '移除中' } : row) }));
      try {
        if (item?.value) await removeAttachmentFile(item.value);
        set((state) => ({ items: state.items.filter((row) => row.id !== id), error: null }));
      } catch { set((state) => ({ items: state.items.map((row) => row.id === id && item ? item : row), error: '附件移除失败，请检查服务连接后重试' })); }
    },
    consume: (ids) => set((state) => ({ items: state.items.filter((row) => !ids.includes(row.id)), error: null })),
  };
});
