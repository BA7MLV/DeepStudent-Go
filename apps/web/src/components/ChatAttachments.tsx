import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { useChatAttachments } from '../store/chatAttachments';
import { attachmentSize, type ChatAttachment } from '../chat/attachments';
import { downloadAttachment } from '../chat/prepareAttachment';
import { isImageAttachment, type ImageAttachment } from '../chat/attachmentMedia';
import { useAttachmentImage } from '../chat/useAttachmentImage';
import { accountLifecycle } from '../client/account-lifecycle';
import { Sym, toast } from '../ui';
import { prefersReducedMotion } from '../utils/motion';
import ImagePreview from './ImagePreview';
import { markImagePreviewSource } from './imagePreviewSource';
import ImageGallery from './ImageGallery';
import AttachmentUploadStatus from './AttachmentUploadStatus';
import ImageCropButton from './ImageCropButton';
import ChatDocumentPreview, { isTextFile } from './ChatDocumentPreview';
import './chat-attachments.css';

/** The same accessible viewer serves composer thumbnails and persisted messages. */
function ChatImage({ file, images, draft = false }: { file: ChatAttachment; images: ChatAttachment[]; draft?: boolean }) {
  const thumbnail = useRef<HTMLDivElement>(null);
  const [near, setNear] = useState(draft);
  const [open, setOpen] = useState(false);
  const [index, setIndex] = useState(0);
  const [failed, setFailed] = useState(false);
  const [thumbnailFailed, setThumbnailFailed] = useState(false);
  const current = images[index] || file;
  const preview = useAttachmentImage(file, near, true);
  const original = useAttachmentImage(current, open, false);
  const download = useRef<AbortController | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    download.current = controller;
    const unregister = accountLifecycle.current()?.own(() => { controller.abort(); setOpen(false); });
    return () => { unregister?.(); controller.abort(); };
  }, [open, current.id]);
  useEffect(() => {
    const node = thumbnail.current;
    if (!node || draft) return;
    const observer = new IntersectionObserver(entries => setNear(entries.some(entry => entry.isIntersecting)), { rootMargin: '240px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, [draft]);
  const navigate = (next: number) => { setIndex(next); setFailed(false); };
  const stacked = !draft && images.length > 1;
  const dimensions = file as ImageAttachment;
  return <>
    <div ref={thumbnail} className="chat-image-slot" style={{ aspectRatio: dimensions.width && dimensions.height ? `${dimensions.width} / ${dimensions.height}` : '1' }}>
    <Button variant="ghost" className={draft ? 'chat-image chat-image--draft' : 'chat-image'} aria-label={stacked ? `查看 ${images.length} 张图片` : `预览图片 ${file.name}`}
      onPress={event => { markImagePreviewSource(event.target); navigate(Math.max(0, images.findIndex((image) => image.id === file.id))); setOpen(true); }}>
      {preview.url && !thumbnailFailed ? <img src={preview.url} alt={file.name} width={dimensions.width} height={dimensions.height} decoding="async" onError={() => setThumbnailFailed(true)} /> : <span className="chat-image-placeholder" aria-label={preview.error ? '图片预览不可用' : '图片加载中'}><Sym name="image" /></span>}
    </Button>
    {(preview.error || thumbnailFailed) && <button type="button" className="chat-image-retry" aria-label={`重试图片预览 ${file.name}`} onClick={() => { setThumbnailFailed(false); preview.retry(); }}>重试</button>}
    </div>
    <ImagePreview isOpen={open} onOpenChange={setOpen} title={current.name} contentKey={current.id}
      content={original.url && !failed ? { kind: 'image', src: original.url, onError: () => setFailed(true) } : undefined}
      status={original.error || failed ? <div role="alert"><p>{original.error || '图片加载失败'}</p><Button onPress={() => { setFailed(false); original.retry(); }}>重试</Button></div> : <Spinner aria-label="正在加载原图" />}
      navigation={{ index, total: images.length, onChange: navigate }}
      onDownload={() => {
        const signal = download.current?.signal;
        void downloadAttachment(current, signal).catch((error: Error) => { if (!signal?.aborted) toast.error(error.message); });
      }}
      testId="chat-image-viewer" />
  </>;
}

function PendingImage({ file, removing, error, onRetry }: { file: File; removing: boolean; error?: string; onRetry: () => void }) {
  const [preview, setPreview] = useState('');
  useEffect(() => {
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return <div className="chat-image chat-image--draft chat-image-pending" aria-busy={!error} aria-label={file.name}>
    {preview && <img src={preview} alt="" />}
    <AttachmentUploadStatus label={removing ? '正在移除图片' : '图片上传中'} error={error} onRetry={onRetry} />
  </div>;
}

function ChatDocument({ file, local, status, loading, error, children }: {
  file: ChatAttachment; local?: File; status?: string; loading?: boolean; error?: string; children?: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const canPreview = (!!file.text || isTextFile(file)) && !loading && !error;
  return <>
    <div className="chat-document__row">
      <button type="button" className="chat-document__open" disabled={loading || !!error}
        aria-label={t(canPreview ? 'chatAttachment.preview' : 'chatAttachment.downloadNamed', { name: file.name })}
        onClick={() => canPreview ? setOpen(true) : void downloadAttachment(file).catch((error: Error) => toast.error(error.message))}>
        <span className="chat-document__icon">{loading ? <Spinner size="sm" aria-label={t('chatAttachment.loading')} /> : <Sym name="description" />}</span>
        <span className="chat-attachments__info">
          <span className="truncate" title={file.name}>{file.name}</span>
          <small>{attachmentSize(file.size)} · {status ?? t(canPreview ? 'chatAttachment.clickPreview' : 'chatAttachment.download')}</small>
        </span>
        {file.text && <span className="chat-document__snippet" aria-hidden="true">{file.text.slice(0, 240)}</span>}
      </button>
      {children}
    </div>
    {error && <span role="alert" className="chat-attachments__error">{error}</span>}
    {open && <ChatDocumentPreview file={file} local={local} onClose={() => setOpen(false)} />}
  </>;
}

export function ChatAttachmentDraft() {
  const containerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const container = containerRef.current;
    const content = contentRef.current;
    if (!container || !content) return;
    // Observe only attachments: typing must not animate the textarea's height.
    const resize = () => {
      const height = content.getBoundingClientRect().height;
      if (height > 0) {
        container.dataset.open = 'true';
        // Commit the collapsed size before starting the first expansion.
        void container.offsetHeight;
      }
      container.style.height = `${height}px`;
      if (height === 0 && (prefersReducedMotion() || container.getBoundingClientRect().height === 0)) {
        container.dataset.open = 'false';
      }
    };
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);
  return <div ref={containerRef} className="chat-attachment-resize t-resize" style={{ height: 0 }}
    onTransitionEnd={(event) => {
      if (event.target === event.currentTarget && event.propertyName === 'height' && contentRef.current?.getBoundingClientRect().height === 0) {
        event.currentTarget.dataset.open = 'false';
      }
    }}>
    <div ref={contentRef}><ChatAttachmentDraftContent /></div>
  </div>;
}

function ChatAttachmentDraftContent() {
  const { items, error, retry, remove, replace } = useChatAttachments();
  const { t } = useTranslation();
  const images = items.flatMap((item) => item.value && isImageAttachment(item.value) ? [item.value] : []);
  if (!items.length && !error) return null;
  return <div className="chat-attachments" data-testid="chat-attachment-draft" aria-label="待发送附件">
    {items.map((item) => (item.value && isImageAttachment(item.value) || /^image\/(png|jpeg|webp|gif)$/.test(item.file.type) || /\.(png|jpe?g|webp|gif)$/i.test(item.file.name)) ? <div key={item.id} className="chat-image-draft" data-testid="chat-attachment" data-state={item.error ? 'error' : item.value && !item.editing ? 'ready' : 'loading'}>
      {item.value && isImageAttachment(item.value) && !item.error ? <ChatImage file={item.value} images={images} draft /> : <PendingImage file={item.file} removing={item.phase === '移除中'} error={item.error} onRetry={() => retry(item.id)} />}
      <ImageCropButton file={item.file} isDisabled={!item.value || !!item.error || item.editing} onSave={file => replace(item.id, file)} />
      <Button isIconOnly size="sm" variant="secondary" className="chat-image-draft__remove" aria-label={`移除附件 ${item.file.name}`} isDisabled={item.editing || item.phase === '移除中'} onPress={() => void remove(item.id)}><Sym name="close" /></Button>
    </div> : <div key={item.id} className="chat-attachments__item chat-document" data-testid="chat-attachment" data-state={item.error ? 'error' : item.value ? 'ready' : 'loading'}>
      <ChatDocument file={item.value ?? { id: item.id, name: item.file.name, size: item.file.size, mimeType: item.file.type }} local={item.file}
        loading={!item.value && !item.error} error={item.error} status={item.error ? t('chatAttachment.failed') : item.value ? undefined : item.phase}>
        {item.error && <Button size="sm" variant="tertiary" onPress={() => retry(item.id)}>重试</Button>}
        <Button isIconOnly size="sm" variant="tertiary" aria-label={`移除附件 ${item.file.name}`} onPress={() => void remove(item.id)}><Sym name="close" /></Button>
      </ChatDocument>
    </div>)}
    {error && <p role="alert" className="chat-attachments__error">{error}</p>}
  </div>;
}

export function ChatMessageAttachments({ files }: { files?: ChatAttachment[] }) {
  if (!files?.length) return null;
  const images = files.filter(isImageAttachment);
  return <div className="chat-attachments chat-attachments--compact" data-testid="chat-message-attachments">
    {images.length > 0 && <ImageGallery count={images.length}><ChatImage key={images[0].id} file={images[0]} images={images} /></ImageGallery>}
    {files.filter((file) => !isImageAttachment(file)).map((file) => <div key={file.id} className="chat-attachments__item chat-document"><ChatDocument file={file} /></div>)}
  </div>;
}
