import { useEffect, useState } from 'react';
import { accountLifecycle } from '../client/account-lifecycle';
import { readAttachmentBlob } from './prepareAttachment';
import type { ImageAttachment } from './attachmentMedia';
import i18n from '../i18n';

/** A view owns URLs/waiters only; immutable bytes use the existing account LRU. */
export function useAttachmentImage(file: ImageAttachment, active: boolean, preview: boolean) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ key: string; url?: string; error?: string }>();
  const key = `${file.id}:${file.serverId ?? ''}:${file.previewServerId ?? ''}:${preview}:${attempt}`;
  useEffect(() => {
    if (!active) { setResult(undefined); return; }
    const controller = new AbortController();
    const lifetime = accountLifecycle.current();
    let url = '';
    const release = () => {
      controller.abort();
      if (url) { URL.revokeObjectURL(url); url = ''; }
    };
    const unregister = lifetime?.own(() => { release(); setResult(undefined); });
    setResult(undefined);
    void readAttachmentBlob(file, controller.signal, preview).then(blob => {
      if (controller.signal.aborted) return;
      lifetime?.assertCurrent();
      url = URL.createObjectURL(blob);
      setResult({ key, url });
    }).catch(error => {
      if (!controller.signal.aborted) setResult({ key, error: error instanceof Error ? error.message : i18n.t('dataDelivery.imageLoadFailed') });
    });
    return () => { unregister?.(); release(); };
  }, [active, file.id, file.serverId, file.previewServerId, file.dataUrl, preview, key]);
  const current = result?.key === key ? result : undefined;
  return { url: active ? current?.url : undefined, error: current?.error, retry: () => setAttempt(value => value + 1) };
}
