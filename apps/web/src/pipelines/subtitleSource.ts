import type { SubtitleBundle } from '../bilibili/subtitle';

/** Source selection is independent of decoding/ASR and is shared by auto jobs. */
export async function preferOriginalSubtitles(options: {
  completed: boolean;
  hasSource: boolean;
  load: () => Promise<SubtitleBundle>;
  save: (bundle: SubtitleBundle) => Promise<void>;
  fallback: (error?: unknown) => void;
  checkActive: () => void;
}): Promise<boolean> {
  options.checkActive();
  if (options.completed) return true;
  if (!options.hasSource) return false;
  let bundle: SubtitleBundle;
  try { bundle = await options.load(); }
  catch (error) {
    options.checkActive();
    options.fallback(error);
    return false;
  }
  options.checkActive();
  if (!bundle.primary?.cues.length) { options.fallback(); return false; }
  // Persistence failures are not "no original subtitles": do not start paid ASR.
  await options.save(bundle);
  return true;
}
