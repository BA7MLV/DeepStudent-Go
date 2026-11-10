import { useEffect, useRef, useState } from 'react';
import { Button, Modal, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import ReactCrop, { type PercentCrop } from 'react-image-crop';
import { MODAL_CONTAINER_CLASS, Sym } from '../ui';
import { cropPixels, exportCroppedImage, renderCropCanvas, rotateCrop, rotationDimensions } from '../chat/cropImage';
import 'react-image-crop/dist/ReactCrop.css';
import './image-crop.css';

const FULL_CROP: PercentCrop = { unit: '%', x: 0, y: 0, width: 100, height: 100 };

export default function ImageCropDialog({ file, onSave, onClose }: {
  file: File; onSave: (file: File) => Promise<void> | void; onClose: () => void;
}) {
  const { t } = useTranslation('interface', { keyPrefix: 'imageCrop' });
  const saving = useRef(false);
  const alive = useRef(true);
  const [original, setOriginal] = useState<HTMLImageElement>();
  const [quarterTurns, setQuarterTurns] = useState(0);
  const [preview, setPreview] = useState<{ original: HTMLImageElement; turns: number; src: string }>();
  const [crop, setCrop] = useState<PercentCrop>(FULL_CROP);
  const [optimize, setOptimize] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    alive.current = true;
    if (file.size > 20 * 1024 * 1024) { setError(t('sourceTooLarge')); return () => { alive.current = false; }; }
    let cancelled = false;
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.decoding = 'async';
    image.onload = () => {
      if (cancelled) return;
      const { naturalWidth: width, naturalHeight: height } = image;
      if (!width || !height || width * height > 40_000_000) setError(t('tooManyPixels'));
      else setOriginal(image);
    };
    image.onerror = () => { if (!cancelled) setError(t('decodeFailed')); };
    image.src = url;
    return () => { cancelled = true; alive.current = false; image.onload = null; image.onerror = null; URL.revokeObjectURL(url); };
  }, [file, t]);
  useEffect(() => {
    if (!original) return;
    if (quarterTurns === 0) { setPreview({ original, turns: 0, src: original.src }); return; }
    let cancelled = false;
    let url = '';
    let canvas: HTMLCanvasElement | undefined;
    try {
      // Only the editor preview is downsampled. Saving always reads the original.
      canvas = renderCropCanvas(original, FULL_CROP, quarterTurns, 1280);
      const output = canvas;
      output.toBlob(blob => {
        output.width = 0; output.height = 0;
        if (cancelled) return;
        if (!blob) { setError(t('encodeFailed')); return; }
        url = URL.createObjectURL(blob);
        setPreview({ original, turns: quarterTurns, src: url });
      }, 'image/png');
    } catch (cause) { setError(cause instanceof Error ? cause.message : t('encodeFailed')); }
    return () => { cancelled = true; if (url) URL.revokeObjectURL(url); if (canvas) { canvas.width = 0; canvas.height = 0; } };
  }, [original, quarterTurns, t]);
  const source = preview?.original === original && preview?.turns === quarterTurns ? preview.src : '';
  const dimensions = original ? rotationDimensions(original.naturalWidth, original.naturalHeight, quarterTurns) : { width: 0, height: 0 };
  const region = dimensions.width && crop.width > 0 && crop.height > 0 ? cropPixels(dimensions.width, dimensions.height, crop) : undefined;
  const scale = region && optimize ? Math.min(1, 2560 / Math.max(region.width, region.height)) : 1;
  const rotate = (direction: 1 | -1) => {
    if (!original || saving.current) return;
    setError('');
    setCrop(current => rotateCrop(current, direction));
    setQuarterTurns(current => (current + direction + 4) % 4);
  };
  const save = async () => {
    if (!original || !source || !region || saving.current) return;
    saving.current = true; setBusy(true); setError('');
    try {
      const result = await exportCroppedImage(original, crop, file.name, optimize, quarterTurns);
      if (!alive.current) return;
      await onSave(result);
      if (alive.current) onClose();
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : t('saveFailed'));
    } finally {
      saving.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return <Modal.Root isOpen onOpenChange={open => { if (!open && !saving.current) onClose(); }}>
    <Modal.Backdrop isDismissable={!busy} isKeyboardDismissDisabled={busy}>
      <Modal.Container placement="center" size="lg" className={MODAL_CONTAINER_CLASS}>
        <div className="image-crop-events"
          onKeyDown={event => { if (event.key !== 'Escape') event.stopPropagation(); }}
          onKeyUp={event => { if (event.key !== 'Escape') event.stopPropagation(); }}>
        <Modal.Dialog className="image-crop" data-testid="image-crop-dialog" data-rotation={quarterTurns * 90} aria-busy={busy}>
          <Modal.Header className="image-crop__header">
            <Modal.Heading>{t('title')}</Modal.Heading>
            <Button isIconOnly variant="tertiary" aria-label={t('close')} isDisabled={busy} onPress={onClose}><Sym name="close" /></Button>
          </Modal.Header>
          <Modal.Body className="image-crop__body">
            <p className="image-crop__hint">{t('help')}</p>
            <div className="image-crop__stage">
              {source ? <ReactCrop crop={crop} onChange={(_, percent) => setCrop(percent)} ruleOfThirds keepSelection
                disabled={busy || !dimensions.width} minWidth={8} minHeight={8} ariaLabels={{
                  cropArea: t('area'), nwDragHandle: t('nw'), nDragHandle: t('n'), neDragHandle: t('ne'), eDragHandle: t('e'),
                  seDragHandle: t('se'), sDragHandle: t('s'), swDragHandle: t('sw'), wDragHandle: t('w'),
                }}>
                <img src={source} alt={file.name} draggable={false} onError={() => setError(t('decodeFailed'))} />
              </ReactCrop> : !error ? <Spinner aria-label={t('imageLoading')} /> : null}
            </div>
            <div className="image-crop__rotation" role="group" aria-label={t('orientation')}>
              <Button size="sm" variant="secondary" isDisabled={busy || !source} onPress={() => rotate(-1)}><Sym name="rotate_left" />{t('rotateLeft')}</Button>
              <Button size="sm" variant="secondary" isDisabled={busy || !source} onPress={() => rotate(1)}><Sym name="rotate_right" />{t('rotateRight')}</Button>
            </div>
            <div className="image-crop__options">
              <label><input type="checkbox" checked={optimize} disabled={busy} onChange={event => setOptimize(event.target.checked)} />{t('optimize')}</label>
              <span className="image-crop__hint">{t('qualityHint')}</span>
            </div>
            <p className="image-crop__hint" role="status">{region ? t('output', { width: Math.max(1, Math.round(region.width * scale)), height: Math.max(1, Math.round(region.height * scale)) }) : ''}{t('originalHint')}</p>
            {error && <p className="image-crop__error" role="alert">{error}</p>}
          </Modal.Body>
          <Modal.Footer className="image-crop__footer">
            <Button variant="tertiary" isDisabled={busy || !dimensions.width} onPress={() => setCrop(FULL_CROP)}>{t('reset')}</Button>
            <Button variant="secondary" isDisabled={busy} onPress={onClose}>{t('cancel')}</Button>
            <Button isDisabled={busy || !source || !region} onPress={() => void save()}>{busy ? <><Spinner size="sm" /> {t('saving')}</> : t('save')}</Button>
          </Modal.Footer>
        </Modal.Dialog>
        </div>
      </Modal.Container>
    </Modal.Backdrop>
  </Modal.Root>;
}
