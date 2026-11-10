import { lazy, Suspense, useState } from 'react';
import { Button, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym } from '../ui';

const ImageCropDialog = lazy(() => import('./ImageCropDialog'));

/** Load the editor and its stylesheet only on demand, never for message history. */
export default function ImageCropButton({ file, isDisabled, onSave }: {
  file: File; isDisabled?: boolean; onSave: (file: File) => Promise<void> | void;
}) {
  const [open, setOpen] = useState(false);
  const { t } = useTranslation('interface', { keyPrefix: 'imageCrop' });
  return <>
    <Button isIconOnly size="sm" variant="secondary" className="chat-image-draft__crop"
      aria-label={t('open', { name: file.name })} isDisabled={isDisabled} onPress={() => setOpen(true)}><Sym name="crop" /></Button>
    {open && <Suspense fallback={<span className="chat-image-draft__crop-loading" role="status"><Spinner size="sm" aria-label={t('loading')} /></span>}>
      <ImageCropDialog file={file} onSave={onSave} onClose={() => setOpen(false)} />
    </Suspense>}
  </>;
}
