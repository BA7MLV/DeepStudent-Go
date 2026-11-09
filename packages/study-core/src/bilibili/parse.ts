// 哔哩哔哩链接解析：从各种输入中提取 BV 号 / 分 P 序号。宿主验证网络地址。
//
// 支持的输入：
//   BV1xx411c7mD                                  裸 BV 号
//   https://www.bilibili.com/video/BV1xx411c7mD
//   https://www.bilibili.com/video/BV1xx411c7mD?p=2
//   https://www.bilibili.com/video/BV1xx411c7mD/?spm_id_from=..&p=3
//   bilibili.com/video/BV1xx411c7mD               无协议
//   https://b23.tv/xxxx                           短链（需再经一次跳转解析，见 resolveShortUrl）
//   【视频标题】 https://b23.tv/xxxx 复制后打开       分享文案

export interface ParsedBili {
  /** BV 号（含 BV 前缀），大小写原样保留 */
  bvid: string;
  /** 分 P 序号（1 起），未指定为 1 */
  page: number;
  /** 是否为 b23.tv 短链（短链自身不含 BV，需要二次解析） */
  isShort: boolean;
  /** 短链原始地址（仅 isShort=true 时有值） */
  shortUrl?: string;
}

const BV_RE = /BV[0-9A-Za-z]{10}/;
// 只提取已知域名，不能将标题、中文标点或 URL 的外层括号送入网络层。
const LINK_RE = /(?<![\w./:@%-])(?:https?:\/\/)?(?:(?:(?:www|m)\.)?bilibili\.com\/video\/BV[0-9A-Za-z]{10}(?![0-9A-Za-z])|b23\.tv\/[0-9A-Za-z_-]+)(?:[/?#][A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]*)?/i;

/** 从分享文案中取第一个 B 站视频链接；没有链接时兼容夹杂文字的 BV 号。 */
export function extractBiliInput(text: string): string | null {
  const link = text.match(LINK_RE)?.[0].replace(/[.,!?;:)\]}]+$/, '');
  if (link) {
    const url = new URL(/^https?:\/\//i.test(link) ? link : `https://${link}`);
    url.protocol = 'https:';
    url.hash = '';
    return url.href;
  }
  const bv = text.match(/BV[0-9A-Za-z]{10}(?![0-9A-Za-z])(?:\/?\?[^\s<>"'，。！？、；：（）【】《》]*)?/);
  return bv?.[0] ?? null;
}

/** 从任意字符串里提取第一个 BV 号（不含则返回 null） */
export function extractBv(text: string): string | null {
  const m = text.match(BV_RE);
  return m ? m[0] : null;
}

/** 从 URL 查询串/全串里取分 P（p= 或 ?p= / &p=），非法或缺省回退 1 */
export function extractPage(text: string): number {
  const m = text.match(/[?&]p=(\d+)/);
  if (!m) return 1;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 解析用户输入。无法识别时抛出带用户可读信息的 Error。
 */
export function parseBiliInput(raw: string): ParsedBili {
  if (!raw.trim()) throw new Error('请输入哔哩哔哩视频链接或 BV 号');
  const input = extractBiliInput(raw);
  if (!input) throw new Error('未识别到 BV 号，请检查链接是否正确（支持 BV 号、视频页链接、b23.tv 短链）');

  // b23.tv 短链：自身不含 BV，标记出来由调用方二次解析
  if (/^https:\/\/b23\.tv\//i.test(input)) {
    return { bvid: '', page: extractPage(input), isShort: true, shortUrl: input };
  }

  const bvid = extractBv(input);
  if (!bvid) {
    throw new Error('未识别到 BV 号，请检查链接是否正确（支持 BV 号、视频页链接、b23.tv 短链）');
  }
  return { bvid, page: extractPage(input), isShort: false };
}

/** 清洗文件名：去掉文件系统不允许的字符，裁剪长度 */
export function sanitizeFileName(name: string): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const trimmed = cleaned.slice(0, 80);
  return trimmed || 'bilibili-video';
}

/** 从短链跳转后的最终 URL / 页面内容中提取 BV（供短链二次解析用） */
export function parseBvFromResolved(text: string): string {
  const bvid = extractBv(text);
  if (!bvid) throw new Error('短链解析后仍未找到 BV 号，该链接可能不是视频页');
  return bvid;
}
