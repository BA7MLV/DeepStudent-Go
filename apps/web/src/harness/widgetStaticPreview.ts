/**
 * Script-free, high-fidelity preview of a show_widget HTML fragment.
 *
 * Used while tool arguments are still streaming and while the validated work's
 * isolated runtime is starting. Unlike `StreamingHtmlPreview` (legacy answers in
 * the main document), this keeps author styles, ids/classes and inline SVG so
 * the preview looks like the final work's first frame.
 *
 * ## Boundary (each layer alone is enough to stop script execution)
 *
 * 1. DOMPurify removes script, event handlers, javascript: URLs and document-level
 *    or embedding elements. Only `#…` fragment links and inline raster data images
 *    survive as URLs.
 * 2. The preview document is parsed in an iframe with `sandbox="allow-same-origin"`
 *    and **no** `allow-scripts`: scripting is disabled for that browsing context,
 *    so even a missed handler cannot run. No forms, popups or top navigation.
 * 3. A document CSP forbids scripts, frames, network fetches and non-data images
 *    or fonts, so leftover CSS such as `url(https://…)` cannot reach the network.
 *
 * allow-same-origin is only there so the host can measure layout and patch
 * frozen/live nodes without re-parsing the whole document on every token. It is
 * never combined with allow-scripts.
 */
import createDOMPurify, { type Config, type DOMPurify } from 'dompurify';
import { WIDGET_STYLES } from './widgetStyles.ts';
import { splitStreamingHtml } from '../utils/streamingHtml.ts';
import type { WidgetTheme } from './widgetTheme.ts';

export const STATIC_PREVIEW_SANDBOX = 'allow-same-origin';

const CSP = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  'img-src data:',
  'font-src data:',
  "connect-src 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "object-src 'none'",
].join('; ');

const FORBID_TAGS = [
  'script', 'noscript', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal',
  'form', 'meta', 'base', 'link', 'template', 'slot', 'audio', 'video', 'source', 'track',
  // SVG elements that can reference external documents or animate attributes into URLs.
  'use', 'image', 'feImage', 'animate', 'animateMotion', 'animateTransform', 'set', 'foreignObject', 'a',
];
const FORBID_ATTR = ['action', 'formaction', 'srcset', 'imagesrcset', 'ping', 'autofocus', 'background', 'poster', 'xlink:href'];
const SAFE_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z0-9+/=\s]+$/i;
const URL_IN_CSS = /url\s*\(\s*(['"]?)(?!#|data:image\/)[^)]*\1\s*\)|@import\b[^;]*;?/gi;

const CONFIG: Config & { RETURN_TRUSTED_TYPE: false } = {
  // Keep a leading <style>; without FORCE_BODY the parser hoists it out of body.
  FORCE_BODY: true,
  ADD_TAGS: ['style'],
  FORBID_TAGS,
  FORBID_ATTR,
  ALLOW_DATA_ATTR: true,
  ALLOW_ARIA_ATTR: true,
  ALLOW_UNKNOWN_PROTOCOLS: false,
  RETURN_TRUSTED_TYPE: false,
};

let purifier: DOMPurify | undefined;
function purify(): DOMPurify {
  if (purifier) return purifier;
  // A private instance: hooks here never affect the global sanitizer used by Markdown.
  const instance = createDOMPurify(window);
  instance.addHook('uponSanitizeAttribute', (node, data) => {
    const name = data.attrName.toLowerCase();
    const value = data.attrValue.trim();
    if (name === 'href' && !value.startsWith('#')) data.keepAttr = false;
    if (name === 'src' && !SAFE_IMAGE.test(value)) data.keepAttr = false;
    if (name === 'target') data.keepAttr = false;
    if (name === 'style' && URL_IN_CSS.test(value)) data.attrValue = value.replace(URL_IN_CSS, 'none');
    URL_IN_CSS.lastIndex = 0;
    void node;
  });
  instance.addHook('uponSanitizeElement', (node, data) => {
    // Inline <style> survives, but without remote url()/@import (CSP blocks them too).
    if (data.tagName === 'style' && node.textContent && URL_IN_CSS.test(node.textContent))
      node.textContent = node.textContent.replace(URL_IN_CSS, 'none');
    URL_IN_CSS.lastIndex = 0;
  });
  return (purifier = instance);
}

/** Sanitized HTML string, safe to parse into the script-disabled preview document. */
export function sanitizeWidgetPreview(raw: string): string {
  return purify().sanitize(raw, CONFIG) as string;
}

/** Initial document. Content is patched in later; scripts never run here. */
export function buildStaticPreviewDocument(theme?: WidgetTheme): string {
  const tokens = Object.entries(theme?.tokens ?? {})
    .filter(([name, value]) => /^--wbw-[a-z0-9-]+$/.test(name) && !/[;{}<>]/.test(value))
    .map(([name, value]) => `${name}:${value}`).join(';');
  const dark = theme?.dark === true;
  return `<!doctype html>
<html lang="zh-CN" data-wbw-theme="${dark ? 'dark' : 'light'}" style="color-scheme:${dark ? 'dark' : 'light'};${tokens}">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>
${WIDGET_STYLES}
[data-wbw-preview-part] { display: contents; }
img:not([src]) { display: inline-block; min-width: 48px; min-height: 48px; background: var(--wbw-surface); border-radius: var(--wbw-radius); }
</style>
</head>
<body inert><div data-wbw-preview-part="frozen"></div><div data-wbw-preview-part="live"></div></body>
</html>`;
}

export function applyStaticPreviewTheme(doc: Document, theme: WidgetTheme) {
  const root = doc.documentElement;
  for (const [name, value] of Object.entries(theme.tokens))
    if (/^--wbw-[a-z0-9-]+$/.test(name)) root.style.setProperty(name, value);
  root.style.colorScheme = theme.dark ? 'dark' : 'light';
  root.setAttribute('data-wbw-theme', theme.dark ? 'dark' : 'light');
}

/**
 * Appends completed top-level elements once and replaces only the unfinished tail,
 * so frozen nodes (and the reader's place) stay stable while tokens arrive.
 */
export class StaticPreviewRenderer {
  private stable = '';
  private live = '';

  constructor(private readonly doc: Document) {}

  owns(doc: Document | null | undefined): boolean {
    return !!doc && doc === this.doc && !!doc.defaultView;
  }

  private part(name: 'frozen' | 'live'): HTMLElement | null {
    return this.doc.querySelector(`[data-wbw-preview-part="${name}"]`);
  }

  private parse(html: string): DocumentFragment {
    // <template> content is inert: nothing loads or runs while nodes are built.
    const template = this.doc.createElement('template');
    template.innerHTML = html;
    return template.content;
  }

  update(source: string): void {
    const frozen = this.part('frozen'), live = this.part('live');
    if (!frozen || !live) return;
    const { stableEnd } = splitStreamingHtml(source);
    const cleanStable = sanitizeWidgetPreview(source.slice(0, stableEnd));
    const cleanAll = stableEnd >= source.length ? cleanStable : sanitizeWidgetPreview(source);
    if (!cleanAll.startsWith(cleanStable)) {
      // Rare parser normalization across the split: render one safe snapshot.
      this.reset(frozen, live);
      live.replaceChildren(this.parse(cleanAll));
      this.live = cleanAll;
      return;
    }
    if (!cleanStable.startsWith(this.stable)) this.reset(frozen, live);
    if (cleanStable.length > this.stable.length) {
      frozen.appendChild(this.parse(cleanStable.slice(this.stable.length)));
      this.stable = cleanStable;
    }
    const tail = cleanAll.slice(cleanStable.length);
    if (tail !== this.live) {
      live.replaceChildren(this.parse(tail));
      this.live = tail;
    }
  }

  private reset(frozen: HTMLElement, live: HTMLElement) {
    this.stable = ''; this.live = '';
    frozen.replaceChildren(); live.replaceChildren();
  }

  /** Content height in CSS px, measured from boxes rather than the viewport-floored scrollHeight. */
  height(): number {
    const body = this.doc.body;
    if (!body) return 0;
    // Body's own box already includes its padding; overflowing descendants
    // (absolute labels, wide SVG text) get the same bottom padding added.
    const padding = parseFloat(this.doc.defaultView?.getComputedStyle(body).paddingBottom ?? '0') || 0;
    let bottom = body.getBoundingClientRect().bottom;
    for (const element of body.querySelectorAll('*')) {
      const rect = element.getBoundingClientRect();
      if (rect.width || rect.height) bottom = Math.max(bottom, rect.bottom + padding);
    }
    return Math.ceil(bottom + (this.doc.defaultView?.scrollY ?? 0));
  }
}
