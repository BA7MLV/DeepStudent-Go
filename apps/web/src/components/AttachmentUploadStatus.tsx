import { Button, Spinner } from '@heroui/react';
import { Sym } from '../ui';

/** Disappears entirely once the original file has finished uploading. */
export default function AttachmentUploadStatus({ label = '附件上传中', error, onRetry }: {
  label?: string; error?: string; onRetry?: () => void;
}) {
  return <span className="chat-image-pending__overlay" role={error ? 'alert' : 'status'} aria-label={error || label} title={error}>
    {error ? <Button isIconOnly size="sm" variant="secondary" aria-label="上传失败，重试" onPress={onRetry}><Sym name="refresh" /></Button>
      : <span className="chat-image-pending__indicator"><Spinner size="sm" color="current" aria-hidden="true" /></span>}
    <span className="sr-only">{error || label}</span>
  </span>;
}
