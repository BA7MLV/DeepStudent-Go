export interface BiliImportInput {
  bvid: string;
  pages: { bvid: string; cid: number }[];
  langs: string[];
  folderId?: number;
}
export function parseBiliImport(value: Record<string, unknown>): BiliImportInput {
  const bv = (s: unknown): s is string => typeof s === 'string' && /^BV[0-9A-Za-z]{10}$/.test(s);
  if (Object.keys(value).some(key => !['bvid', 'pages', 'langs', 'folderId', '_pluginProviders'].includes(key)) || !bv(value.bvid) ||
    !Array.isArray(value.pages) || !value.pages.length || value.pages.length > 500 ||
    !value.pages.every(p => p && typeof p === 'object' && Object.keys(p).every(k => ['bvid', 'cid'].includes(k)) && bv(p.bvid) && Number.isSafeInteger(p.cid) && p.cid > 0) ||
    new Set(value.pages.map(p => `${p.bvid}:${p.cid}`)).size !== value.pages.length ||
    !Array.isArray(value.langs) || value.langs.length > 20 || !value.langs.every(s => typeof s === 'string' && /^[a-zA-Z0-9_-]{1,40}$/.test(s)) ||
    value.folderId !== undefined && (!Number.isSafeInteger(value.folderId) || Number(value.folderId) <= 0)) throw new Error('invalid_bilibili_import');
  return { bvid: value.bvid, pages: value.pages, langs: value.langs, ...(value.folderId === undefined ? {} : { folderId: Number(value.folderId) }) };
}
