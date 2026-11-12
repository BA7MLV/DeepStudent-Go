import { useEffect, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import type { BotAttachment } from '@wangke/contracts';
import { serverClient } from '../api/serverClient';
import { attachmentSize } from '../chat/attachments';
import { Sym } from '../ui';
import ImagePreview from './ImagePreview';
import { markImagePreviewSource } from './imagePreviewSource';
import ImageGallery from './ImageGallery';
import AttachmentUploadStatus from './AttachmentUploadStatus';
import ImageCropButton from './ImageCropButton';
import './chat-attachments.css';
import { acquireBotImage, invalidateBotImage } from './botImageCache';

export interface BotDraftFile {
  id: string;
  file: File;
  uploaded?: BotAttachment;
  error?: string;
  editing?: boolean;
}

const nameOf = (file: BotAttachment) => file.originalName || file.name || '附件';
const isImage = (file: BotAttachment) => /^image\/(png|jpeg|webp|gif)$/.test(file.mimeType ?? '') || /\.(png|jpe?g|webp|gif)$/i.test(nameOf(file));
const urlOf = (file: BotAttachment, projectId?: string) => projectId
  ? file.projectId === projectId && file.projectPath ? serverClient.projectDownloadUrl(projectId, file.projectPath) : undefined
  : file.fileId ? serverClient.fileDownloadUrl(file.fileId) : undefined;

/** Authenticated blob URLs also work for project downloads (application/octet-stream). */
function useAttachmentImage(url?: string, local?: File) {
  const [source, setSource] = useState('');
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = '';
    let release: (() => void) | undefined;
    setSource(''); setFailed(false);
    const load = async () => {
      if (local) {
        objectUrl = URL.createObjectURL(local);
        setSource(objectUrl);
      }
      else {
        if (!url) throw new Error('file_not_found');
        const handle = acquireBotImage(url); release = handle.release;
        const source = await handle.promise;
        if (!controller.signal.aborted) setSource(source);
      }
    };
    void load().catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => { controller.abort(); release?.(); if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [url, local, attempt]);
  return { source, failed, attempt, setFailed, retry: () => { if (url) invalidateBotImage(url); setAttempt(value => value + 1); } };
}

type ImageItem = { name: string; url?: string; local?: File };

/** Decorative cards share the authenticated image cache with the full viewer. */
function AttachmentImageCard({ url }: { url?: string }) {
  const { source, failed, setFailed } = useAttachmentImage(url);
  return source && !failed ? <img src={source} alt="" decoding="async" onError={() => setFailed(true)} /> : null;
}

function AttachmentImage({ name, url, local, draft = false, images }: ImageItem & { draft?: boolean; images?: ImageItem[] }) {
  const { source, failed, setFailed, retry } = useAttachmentImage(url, local);
  const [open, setOpen] = useState(false);
  const stacked = !!images && images.length > 1;
  return <>
    <Button variant="ghost" className={draft ? 'chat-image chat-image--draft' : 'chat-image'} aria-label={stacked ? `查看 ${images.length} 张图片` : `预览图片 ${name}`}
      onPress={event => { if (failed && !stacked) retry(); else { markImagePreviewSource(event.target); setOpen(true); } }}>
      {failed ? <span role="status">图片加载失败，点击重试</span> : source ? <img src={source} alt={name} decoding="async" onError={() => setFailed(true)} /> : <Spinner size="sm" aria-label="图片加载中" />}
    </Button>
    {open && <AttachmentImageViewer images={images ?? [{ name, url, local }]} onClose={() => setOpen(false)} />}
  </>;
}

function AttachmentImageViewer({ images, onClose }: { images: ImageItem[]; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const selected = Math.min(index, images.length - 1);
  return <AttachmentImagePreview key={selected} image={images[selected]} onClose={onClose}
    navigation={{ index: selected, total: images.length, onChange: setIndex }} />;
}

function AttachmentImagePreview({ image: { name, url, local }, onClose, navigation }: {
  image: ImageItem; onClose: () => void; navigation: { index: number; total: number; onChange: (index: number) => void };
}) {
  const { source, failed, attempt, setFailed, retry } = useAttachmentImage(url, local);
  return <ImagePreview isOpen onOpenChange={open => { if (!open) onClose(); }} title={name} contentKey={`${url}:${attempt}`} testId="bot-image-viewer"
      navigation={navigation}
      content={source && !failed ? { kind: 'image', src: source, onError: () => setFailed(true) } : undefined}
      status={failed ? <Button variant="tertiary" onPress={retry}>图片加载失败，重试</Button> : <Spinner aria-label="图片加载中" />}
      onDownload={source ? () => { const link = document.createElement('a'); link.href = source; link.download = name; link.click(); } : undefined} />
}

export function BotMessageAttachments({ files, projectId, compact = false }: { files: BotAttachment[]; projectId?: string; compact?: boolean }) {
  // Only consecutive images belong to an album; keep other attachments in order.
  const groups: BotAttachment[][] = [];
  for (const file of files) {
    const previous = groups.at(-1);
    if (isImage(file) && previous && isImage(previous[0])) previous.push(file);
    else groups.push([file]);
  }
  return <div className={`chat-attachments bot-message-attachments${compact ? ' chat-attachments--compact' : ''}`} data-testid="bot-message-attachments">
    {groups.map((group, index) => {
      const file = group[0];
      const name = nameOf(file), url = urlOf(file, projectId);
      return isImage(file) ? <ImageGallery count={group.length} key={`${file.fileId ?? file.projectPath ?? 'image'}:${index}`}
        cards={group.slice(1, 3).map((item, depth) => <AttachmentImageCard key={`${item.fileId ?? item.projectPath}:${depth}`} url={urlOf(item, projectId)} />)}>
        <AttachmentImage name={name} url={url} images={group.map(item => ({ name: nameOf(item), url: urlOf(item, projectId) }))} />
      </ImageGallery>
        : <div className="imsg-bubble imsg-bubble--file" key={index}>
          <span className="imsg-file__icon" aria-hidden="true"><Sym name="description" /></span>
          {url ? <a className="imsg-file__name" href={url} download>{name}</a> : <span className="imsg-file__name">{name}</span>}
          <span className="imsg-file__size">{file.sizeBytes === undefined ? '' : attachmentSize(file.sizeBytes)}</span>
        </div>;
    })}
  </div>;
}

export function BotAttachmentDraft({ files, sending, onRemove, onRetry, onReplace }: { files: BotDraftFile[]; sending: boolean; onRemove: (id: string) => void; onRetry: (id: string) => void; onReplace: (id: string, file: File) => Promise<void> }) {
  return <div className="chat-attachments" data-testid="chat-attachment-draft" aria-label="待发送附件">
    {files.map(item => isImage({ originalName: item.file.name, mimeType: item.file.type }) ? <div key={item.id} className="chat-image-draft" data-testid="chat-attachment" data-state={item.error ? 'error' : item.uploaded && !item.editing ? 'ready' : 'loading'}>
      <AttachmentImage name={item.file.name} local={item.file} draft />
      {(!item.uploaded || item.error) && <AttachmentUploadStatus label="图片上传中" error={item.error} onRetry={() => onRetry(item.id)} />}
      <div className="chat-image-draft__actions">
        <ImageCropButton file={item.file} isDisabled={sending || !item.uploaded || !!item.error || item.editing} onSave={file => onReplace(item.id, file)} />
        <Button isIconOnly size="sm" variant="secondary" className="chat-image-draft__remove" aria-label={`移除附件 ${item.file.name}`} isDisabled={sending || item.editing} onPress={() => onRemove(item.id)}><Sym name="close" /></Button>
      </div>
    </div> : <div key={item.id} className="chat-attachments__item" data-testid="chat-attachment" data-state={item.error ? 'error' : item.uploaded ? 'ready' : 'loading'}>
      {!item.uploaded && !item.error ? <Spinner size="sm" aria-label="附件上传中" /> : <Sym name="description" />}
      <span className="chat-attachments__info"><span>{item.file.name}</span><small>{attachmentSize(item.file.size)} · {item.error ? '上传失败' : item.uploaded ? '待发送' : '上传中'}</small>{item.error && <span role="alert" className="chat-attachments__error">{item.error}</span>}</span>
      {item.error && <Button size="sm" variant="tertiary" isDisabled={sending} onPress={() => onRetry(item.id)}>重试</Button>}
      <Button isIconOnly size="sm" variant="tertiary" aria-label={`移除附件 ${item.file.name}`} isDisabled={sending} onPress={() => onRemove(item.id)}><Sym name="close" /></Button>
    </div>)}
  </div>;
}
