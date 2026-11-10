import i18n from '../i18n';

/** Percent coordinates survive responsive layout changes; export from original pixels. */
export interface CropRegion { x: number; y: number; width: number; height: number }

export function cropPixels(width: number, height: number, crop: CropRegion) {
  if (![width, height, crop.x, crop.y, crop.width, crop.height].every(Number.isFinite)
    || width < 1 || height < 1 || crop.width <= 0 || crop.height <= 0) throw new Error(i18n.t('interface:imageCrop.invalidRegion'));
  const x = Math.max(0, Math.min(width - 1, Math.round(width * crop.x / 100)));
  const y = Math.max(0, Math.min(height - 1, Math.round(height * crop.y / 100)));
  return { x, y, width: Math.max(1, Math.min(width - x, Math.round(width * crop.width / 100))),
    height: Math.max(1, Math.min(height - y, Math.round(height * crop.height / 100))) };
}

export function rotationDimensions(width: number, height: number, quarterTurns: number) {
  return Math.abs(quarterTurns % 2) === 1 ? { width: height, height: width } : { width, height };
}

/** Keep the same selected content when turning the image, not the same screen box. */
export function rotateCrop<T extends CropRegion>(crop: T, direction: 1 | -1): T {
  return { ...crop, x: direction === 1 ? 100 - crop.y - crop.height : crop.y,
    y: direction === 1 ? crop.x : 100 - crop.x - crop.width, width: crop.height, height: crop.width };
}

/** Draw straight from the original into the final-sized canvas. No full-size
 * intermediate bitmap or repeated lossy encoding is needed for rotation. */
export function renderCropCanvas(image: HTMLImageElement, crop: CropRegion, quarterTurns = 0, maxEdge = Infinity) {
  const { naturalWidth: width, naturalHeight: height } = image;
  if (!width || !height || width * height > 40_000_000) throw new Error(i18n.t('interface:imageCrop.tooManyPixels'));
  const rotated = rotationDimensions(width, height, quarterTurns);
  const region = cropPixels(rotated.width, rotated.height, crop);
  const scale = Math.min(1, maxEdge / Math.max(region.width, region.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(region.width * scale));
  canvas.height = Math.max(1, Math.round(region.height * scale));
  const context = canvas.getContext('2d');
  if (!context) { canvas.width = 0; canvas.height = 0; throw new Error(i18n.t('interface:imageCrop.noCanvas')); }
  context.imageSmoothingQuality = 'high';
  // Use actual output dimensions after rounding, so no transparent edge is added.
  context.scale(canvas.width / region.width, canvas.height / region.height);
  context.translate(-region.x + rotated.width / 2, -region.y + rotated.height / 2);
  context.rotate(quarterTurns * Math.PI / 2);
  context.drawImage(image, -width / 2, -height / 2);
  return canvas;
}

export async function exportCroppedImage(image: HTMLImageElement, crop: CropRegion, name: string, optimize: boolean, quarterTurns = 0): Promise<File> {
  const canvas = renderCropCanvas(image, crop, quarterTurns, optimize ? 2560 : Infinity);
  try {
    // Canvas removes EXIF/GPS. PNG is lossless; WebP retains transparency. Check the
    // actual MIME because browsers without a WebP encoder fall back to PNG.
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(
      value => value ? resolve(value) : reject(new Error(i18n.t('interface:imageCrop.encodeFailed'))),
      optimize ? 'image/webp' : 'image/png', 0.92,
    ));
    if (!['image/png', 'image/webp'].includes(blob.type)) throw new Error(i18n.t('interface:imageCrop.unsupportedOutput'));
    if (blob.size > 10 * 1024 * 1024) throw new Error(i18n.t('interface:imageCrop.tooLarge'));
    const stem = name.replace(/\.[^.]+$/, '').slice(0, 80) || i18n.t('interface:imageCrop.name');
    return new File([blob], `${stem}_${i18n.t('interface:imageCrop.suffix')}_${crypto.randomUUID().slice(0, 8)}.${blob.type === 'image/webp' ? 'webp' : 'png'}`, { type: blob.type });
  } finally { canvas.width = 0; canvas.height = 0; }
}
