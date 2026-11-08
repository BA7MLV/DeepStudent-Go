import { resolveBiliTarget } from './index';
import { parseBiliInput } from './parse';
import { biliVideoSource, type BiliVideoSource } from './source';

/** 旧导入/本地文件没有来源标识时，只解析稿件与分 P，不下载视频。 */
export async function resolveBiliVideoSource(raw: string): Promise<BiliVideoSource> {
  const parsed = parseBiliInput(raw);
  const target = await resolveBiliTarget(raw);
  const page = target.pages.find(item => (item.bvid ?? target.bvid) === target.bvid && (item.sourcePage ?? item.page) === parsed.page);
  if (!page) throw new Error(`该视频不存在 P${parsed.page}，请检查链接中的分 P 序号`);
  return biliVideoSource(target, page);
}
