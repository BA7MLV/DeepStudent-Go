import sharp from 'sharp';
import type { ModelOverrides } from '@wangke/study-core/model/meta';

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => !!value && typeof value === 'object' && !Array.isArray(value);
export type ImageTarget = { protocol: string; capabilities?: ModelOverrides };
const INPUT_BYTES = 32_000_000;
const INPUT_PIXELS = 40_000_000;
export const imagePreparationCodes = new Set([
  'invalid_model_image_policy', 'model_image_input_too_large', 'model_image_invalid_or_too_large',
  'model_image_output_too_large', 'model_image_count_exceeded', 'model_image_remote_not_supported',
]);
export class ImagePreparationError extends Error {}

/** Application defaults, NOT claimed provider limits. Prefer readable study text.
 * Exact-model overrides win, including for OpenAI-compatible third parties.
 * "original" is a local resolution tier, not a portable API detail value. */
export function imagePolicy(target: ImageTarget) {
  const overrides = target.capabilities?.imageInput;
  const high = overrides?.quality === 'high';
  const bounded = (value: unknown, fallback: number, max: number) => value === undefined ? fallback
    : typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= max ? value
    : (() => { throw new ImagePreparationError('invalid_model_image_policy'); })();
  if (overrides?.quality !== undefined && !['high', 'original'].includes(overrides.quality)) throw new ImagePreparationError('invalid_model_image_policy');
  return {
    maxEdge: bounded(overrides?.maxEdge, high ? 2048 : 6000, 16000),
    maxPixels: bounded(overrides?.maxPixels, high ? 2_560_000 : 10_000_000, INPUT_PIXELS),
    maxBytes: bounded(overrides?.maxBytes, target.protocol === 'anthropic-messages' ? 5 * 1024 * 1024 : 20 * 1024 * 1024, INPUT_BYTES),
  };
}

/** Never writes to attachment storage or uses previews. Decode before trusting
 * headers; normalize orientation/animation only in the model-facing derivative. */
export async function prepareImage(bytes: Uint8Array, target: ImageTarget) {
  const policy = imagePolicy(target);
  if (!bytes.length || bytes.length > INPUT_BYTES) throw new ImagePreparationError('model_image_input_too_large');
  try {
    const input = Buffer.from(bytes);
    const pipeline = sharp(input, { limitInputPixels: INPUT_PIXELS, failOn: 'warning', animated: false });
    const meta = await pipeline.metadata();
    if (!meta.width || !meta.height || !['png', 'jpeg', 'webp', 'gif'].includes(meta.format ?? '')) throw new Error('invalid');
    // metadata() alone accepts truncated/corrupt image bodies.
    await pipeline.clone().stats();
    const rotated = [5, 6, 7, 8].includes(meta.orientation ?? 1);
    const width = rotated ? meta.height : meta.width, height = rotated ? meta.width : meta.height;
    let scale = Math.min(1, policy.maxEdge / width, policy.maxEdge / height, Math.sqrt(policy.maxPixels / (width * height)));
    if (scale === 1 && input.length <= policy.maxBytes && (!meta.orientation || meta.orientation === 1)
      && (meta.pages ?? 1) === 1 && meta.format !== 'gif') {
      return { bytes: input, mime: `image/${meta.format}`, width, height };
    }
    // PNG preserves mathematical glyphs; lossless WebP is a smaller fallback.
    // If byte pressure still requires downsampling, do it explicitly and bound work.
    for (let attempt = 0; attempt < 8; attempt++) {
      let w = Math.max(1, Math.floor(width * scale)), h = Math.max(1, Math.floor(height * scale));
      // A very narrow image hits the one-pixel floor before the area formula.
      if (w * h > policy.maxPixels) {
        if (w >= h) w = Math.max(1, Math.floor(policy.maxPixels / h));
        else h = Math.max(1, Math.floor(policy.maxPixels / w));
      }
      const resized = pipeline.clone().rotate().resize({ width: w, height: h, fit: 'inside', withoutEnlargement: true });
      const png = await resized.clone().png().toBuffer({ resolveWithObject: true });
      if (png.data.length <= policy.maxBytes) return { bytes: png.data, mime: 'image/png', width: png.info.width, height: png.info.height };
      const webp = await resized.webp({ lossless: true }).toBuffer({ resolveWithObject: true });
      if (webp.data.length <= policy.maxBytes) return { bytes: webp.data, mime: 'image/webp', width: webp.info.width, height: webp.info.height };
      scale *= Math.min(0.8, Math.sqrt(policy.maxBytes / Math.min(png.data.length, webp.data.length)) * 0.9);
    }
    throw new ImagePreparationError('model_image_output_too_large');
  } catch (error) {
    if (error instanceof ImagePreparationError) throw error;
    throw new ImagePreparationError('model_image_invalid_or_too_large');
  }
}

/** Shared by canonical and native requests, and by Chat before its output
 * budget calculation. Only image blocks are changed; continuation stays intact.
 * No remote URL fetching (SSRF), global byte cache, persistent derivatives or tiling. */
export async function prepareModelImages<T>(payload: T, target: ImageTarget, signal?: AbortSignal): Promise<T> {
  let count = 0, total = 0;
  const cache = new Map<string, Awaited<ReturnType<typeof prepareImage>>>();
  const image = async (data: unknown) => {
    signal?.throwIfAborted();
    if (++count > 64) throw new ImagePreparationError('model_image_count_exceeded');
    if (typeof data !== 'string' || data.length > Math.ceil(INPUT_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) throw new ImagePreparationError('model_image_invalid_or_too_large');
    total += Math.floor(data.length * 3 / 4) - (data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0);
    if (total > 64_000_000) throw new ImagePreparationError('model_image_input_too_large');
    let prepared = cache.get(data);
    if (!prepared) { prepared = await prepareImage(Buffer.from(data, 'base64'), target); cache.set(data, prepared); }
    signal?.throwIfAborted();
    return prepared;
  };
  const walk = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) { const out = []; for (const item of value) out.push(await walk(item)); return out; }
    if (!object(value)) return value;
    if (value.type === 'image' && object(value.source)) {
      if (value.source.type !== 'base64') throw new ImagePreparationError('model_image_remote_not_supported');
      const prepared = await image(value.source.data);
      return { ...value, source: { ...value.source, media_type: prepared.mime, data: prepared.bytes.toString('base64') } };
    }
    if (['image_url', 'input_image'].includes(String(value.type))) {
      const nested = object(value.image_url), part = nested ? value.image_url as ObjectValue : value;
      const url = nested ? part.url : value.image_url;
      if (typeof url !== 'string' || !/^data:image\/(png|jpeg|webp|gif);base64,/.test(url)) throw new ImagePreparationError('model_image_remote_not_supported');
      const prepared = await image(url.slice(url.indexOf(',') + 1));
      const output = `data:${prepared.mime};base64,${prepared.bytes.toString('base64')}`;
      const detail = part.detail ?? 'high';
      return nested ? { ...value, image_url: { ...part, url: output, detail } } : { ...value, image_url: output, detail };
    }
    const entries: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) entries.push([key, await walk(item)]);
    return Object.fromEntries(entries);
  };
  return await walk(payload) as T;
}
