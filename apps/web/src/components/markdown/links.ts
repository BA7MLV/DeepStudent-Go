import type { ComponentProps } from '@ant-design/x-markdown';
import { safeWebUrl } from '@wangke/contracts/web-search';
import { linkIconHost, linkIconOrigin } from '@wangke/contracts/web-links';

type Node = ComponentProps['domNode'];

/** Image links and other rich embedded content retain their existing renderer. */
export function linkText(node: Node): string | null {
  if (node.type === 'text') return node.data;
  if (node.type !== 'tag' || !['a', 'strong', 'b', 'em', 'i', 's', 'del', 'code', 'span'].includes(node.name)) return null;
  let text = '';
  for (const child of node.children) {
    const part = linkText(child as Node);
    if (part === null) return null;
    text += part;
  }
  return text;
}

const FILE_PATH = /\.(?:pdf|docx?|xlsx?|pptx?|zip|gz|tar|7z|rar|png|jpe?g|gif|webp|svg|ico|mp[34]|webm|wav|epub|md|txt|csv)$/i;

export function websiteChip(href: string | undefined, text: string, ownOrigins: string[] = []) {
  const safe = safeWebUrl(href);
  if (!safe) return null;
  const url = new URL(safe);
  if (ownOrigins.includes(url.origin) || FILE_PATH.test(url.pathname)) return null;
  const host = linkIconHost(url.hostname);
  if (!host) return null;
  const label = text.trim();
  const displayUrl = `${url.host.replace(/^www\./, '')}${url.pathname === '/' ? '' : url.pathname}${url.search}${url.hash}`;
  let bare = label === href || label === url.href;
  if (!bare && (/^(?:https?:\/\/|www\.)/i.test(label) || label.startsWith(url.hostname))) {
    try { bare = new URL(/^https?:\/\//i.test(label) ? label : `${url.protocol}//${label}`).href === url.href; } catch { /* Descriptive text stays descriptive. */ }
  }
  return { host, iconOrigin: linkIconOrigin(url.origin), domain: url.host.replace(/^www\./, ''), label: bare ? displayUrl : label || displayUrl, bare };
}
