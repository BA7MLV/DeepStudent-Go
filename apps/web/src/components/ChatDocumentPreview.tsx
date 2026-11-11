import { useEffect, useState } from 'react';
import { Button, Modal, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import type { ChatAttachment } from '../chat/attachments';
import { attachmentSize } from '../chat/attachments';
import { downloadAttachment, readAttachmentBlob } from '../chat/prepareAttachment';
import { CopyButton, MODAL_CONTAINER_CLASS, Sym, toast } from '../ui';

const PREVIEW_BYTES = 512 * 1024;
export const isTextFile = (file: ChatAttachment) => /\.(txt|md|markdown|csv|json|html?|log|ya?ml)$/i.test(file.name) || /^text\//.test(file.mimeType);

/** Original text is read on demand, never limited to the model's 12,000-character extract. */
export default function ChatDocumentPreview({ file, local, onClose }: { file: ChatAttachment; local?: File; onClose: () => void }) {
  const { t } = useTranslation();
  const [preview, setPreview] = useState<{ text: string; limited?: boolean; fallback?: boolean }>(() => ({ text: file.text ?? '' }));
  const [loading, setLoading] = useState(isTextFile(file));
  useEffect(() => {
    if (!isTextFile(file)) return;
    let cancelled = false;
    void (async () => {
      const blob = local ?? await readAttachmentBlob(file);
      const text = await blob.slice(0, PREVIEW_BYTES).text();
      if (!cancelled) setPreview({ text, limited: blob.size > PREVIEW_BYTES });
    })().catch(() => {
      if (!cancelled) setPreview({ text: file.text ?? '', fallback: true });
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [file, local]);
  return <Modal.Root isOpen onOpenChange={open => { if (!open) onClose(); }}>
    <Modal.Backdrop><Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}>
      <Modal.Dialog className="chat-document-preview" data-testid="chat-document-preview">
        <Modal.Header className="chat-document-preview__header">
          <Modal.Heading className="truncate" title={file.name}>{file.name}</Modal.Heading>
          <Button isIconOnly variant="tertiary" aria-label={t('chatAttachment.close')} onPress={onClose}><Sym name="close" /></Button>
        </Modal.Header>
        <Modal.Body className="chat-document-preview__body">
          {loading ? <Spinner aria-label={t('chatAttachment.loading')} /> : <>
            {(preview.limited || preview.fallback || (!isTextFile(file) && file.truncated)) && <p role="status" className="chat-document-preview__notice">{t(preview.fallback ? 'chatAttachment.fallback' : 'chatAttachment.limited')}</p>}
            <pre tabIndex={0} aria-label={t('chatAttachment.content')}>{preview.text}</pre>
          </>}
        </Modal.Body>
        <Modal.Footer className="chat-document-preview__footer">
          <small>{attachmentSize(file.size)}</small>
          <CopyButton variant="tertiary" text={preview.text} label={t('chatAttachment.copy')} isDisabled={loading || !preview.text} />
          <Button variant="secondary" onPress={() => void downloadAttachment(file).catch((error: Error) => toast.error(error.message))}><Sym name="download" />{t('chatAttachment.download')}</Button>
        </Modal.Footer>
      </Modal.Dialog>
    </Modal.Container></Modal.Backdrop>
  </Modal.Root>;
}
