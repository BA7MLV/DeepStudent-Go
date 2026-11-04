import { encodeCanvas } from './frames';
import { drawTextCover } from '@wangke/study-core/media/text-cover';
export { hueOfTitle } from '@wangke/study-core/media/text-cover';

export async function paintTextCover(input: { title: string; preview: string }) {
  await document.fonts.ready;
  const canvas = document.createElement('canvas');
  canvas.width = 480; canvas.height = 270;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建封面画布');
  drawTextCover(ctx, input);
  return { blob: await encodeCanvas(canvas, 0.82), width: 480, height: 270 };
}
