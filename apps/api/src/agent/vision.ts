import type { CloudConfig } from '@wangke/contracts/cloud';
import { prepareImage, type ImageTarget } from './image-preparation.js';

/** Explicit selection wins. The server has no browser capability catalog, so
 * automatic mode sends a real multimodal request to the main model and surfaces
 * provider rejection rather than guessing capabilities from model names. */
export function visionTarget(config: CloudConfig) {
  const explicit = Boolean(config.visionModel.model);
  const ref = explicit ? config.visionModel : config.llmModel;
  const provider = config.providers.find(p => p.id === ref.providerId);
  if (!provider || !ref.model) throw new Error('vision_model_not_configured');
  return { ref, provider };
}

/** Compatibility helper; Gateway prepares again for its actual selected model. */
export async function prepareVisionImage(bytes: Uint8Array, target: ImageTarget = { protocol: 'openai-chat' }) {
  try {
    return await prepareImage(bytes, target);
  } catch { throw new Error('vision_image_invalid_or_too_large'); }
}

export const visionRecovery: Record<string, string> = {
  vision_model_not_configured: 'Select an image-understanding model in model settings. Do not repeatedly retry or ask the user to transcribe the image as the default fix.',
  vision_image_invalid_or_too_large: 'Image decoding failed or exceeded the 40-megapixel input limit. Ask for a valid PNG/JPEG/WebP/GIF or a smaller crop.',
  model_image_invalid_or_too_large: 'Image decoding failed or exceeded the 40-megapixel safety limit. Ask for a valid image or a smaller crop; do not retry unchanged bytes.',
  model_image_input_too_large: 'Image bytes exceeded the per-image or total request safety limit. Ask for fewer images or a smaller crop.',
  model_image_output_too_large: 'The prepared image cannot fit the selected model byte budget. Check its image policy or request a smaller crop.',
  model_image_count_exceeded: 'Too many image blocks in this request. Start a shorter conversation or send fewer images.',
  model_image_remote_not_supported: 'Image input must be an uploaded attachment, not a remote URL. Upload the image and retry.',
  invalid_model_image_policy: 'The selected model image policy is invalid. Check its resolution and byte limits before retrying.',
  invalid_image_format: 'Ask for a supported PNG/JPEG/WebP/GIF image.',
  vision_empty_response: 'The image model returned no usable text. Retry once with a specific question; if it persists, report the failure without inventing image contents.',
  model_auth_failed: 'Model credentials were rejected. Ask the user to check the provider credentials in settings; do not retry unchanged credentials.',
  model_quota_exhausted: 'Ask the user to check the model provider billing/quota.',
  model_invalid_request: 'The provider rejected the image request. Select an image-capable vision model and check its API protocol in model settings; do not repeat an unchanged request.',
  model_request_failed: 'Transient failures persisted after bounded automatic retries. Explain that the provider is temporarily unavailable; do not loop on the same tool.',
};
