import { useEffect, useState } from 'react';
import { Button, Drawer, Spinner } from '@heroui/react';
import { useTranslation } from 'react-i18next';
import { Sym } from '../ui/icons';
import { Markdown } from './markdown/Markdown';
import { sanitizeWidgetPreview } from '../harness/widgetStaticPreview';
import type { DeliveryPreviewFile } from './deliveryPreviewFile';
import { readDeliverySlides, readDeliveryWord } from './deliveryOfficePreview';
import './delivery-preview.css';

const TEXT_LIMIT = 256 * 1024;
const OFFICE_LIMIT = 20 * 1024 * 1024;
const OFFICE_ITEMS = 200;

type Content =
  | { kind: 'text' | 'markdown' | 'html'; text: string; limited: boolean }
  | { kind: 'docx'; blocks: Awaited<ReturnType<typeof readDeliveryWord>>; limited: boolean }
  | { kind: 'pptx'; slides: string[]; limited: boolean };
type Result = Content | { kind: 'error' | 'tooLarge' };

// Do not allow previewing a Markdown file to load remote resources or host UI.
const STATIC_MARKDOWN = { FORBID_ATTR: ['src', 'srcset', 'href', 'poster', 'background', 'ping', 'style'] };

function staticHtml(source: string) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>html{overflow-wrap:anywhere}body{margin:12px;font:1rem/1.55 system-ui,sans-serif}img,svg,video{max-width:100%;height:auto}pre{overflow:auto}</style>
</head><body>${sanitizeWidgetPreview(source)}</body></html>`;
}

async function loadPreview(file: DeliveryPreviewFile, signal: AbortSignal): Promise<Result> {
  const { kind } = file;
  if (kind === 'legacy') throw new Error('legacy_preview_unsupported');
  const office = kind === 'docx' || kind === 'pptx';
  if (office && file.size !== undefined && file.size > OFFICE_LIMIT) return { kind: 'tooLarge' };
  const response = await fetch(file.url, { credentials: 'include', signal });
  if (!response.ok || !response.body) throw new Error('preview_missing_file');
  const reader = response.body.getReader();
  const limit = office ? OFFICE_LIMIT : TEXT_LIMIT;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  let limited = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      const remaining = limit - size;
      const chunk = value.slice(0, remaining);
      chunks.push(chunk);
      size += chunk.byteLength;
      if (value.byteLength > remaining) { limited = true; break; }
    }
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  signal.throwIfAborted();
  if (office && limited) return { kind: 'tooLarge' };
  const blob = new Blob(chunks);
  if (kind === 'docx') {
    const blocks = await readDeliveryWord(blob);
    return { kind, blocks: blocks.slice(0, OFFICE_ITEMS), limited: blocks.length > OFFICE_ITEMS };
  }
  if (kind === 'pptx') {
    const slides = await readDeliverySlides(blob);
    return { kind, slides: slides.slice(0, OFFICE_ITEMS), limited: slides.length > OFFICE_ITEMS };
  }
  const text = await blob.text();
  return { kind, text: kind === 'html' ? staticHtml(text) : text, limited };
}

function PreviewBody({ file }: { file: DeliveryPreviewFile }) {
  const { t } = useTranslation();
  const { kind, name, url, size } = file;
  const [result, setResult] = useState<Result>();
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (kind === 'legacy') return;
    const controller = new AbortController();
    void loadPreview({ kind, name, url, size }, controller.signal).then(next => {
      if (!controller.signal.aborted) setResult(next);
    }, () => { if (!controller.signal.aborted) setResult({ kind: 'error' }); });
    return () => controller.abort();
  }, [kind, name, url, size, attempt]);

  if (kind === 'legacy') return <p className="delivery-preview__notice">{t('deliveryPreview.legacy')}</p>;
  if (!result) return <div className="delivery-preview__notice" role="status"><Spinner size="sm" aria-label={t('chatAttachment.loading')} /></div>;
  if (result.kind === 'tooLarge') return <p className="delivery-preview__notice">{t('deliveryPreview.tooLarge')}</p>;
  if (result.kind === 'error') return <div className="delivery-preview__notice" role="alert">{t('deliveryPreview.failed')}
    <Button size="sm" variant="tertiary" onPress={() => { setResult(undefined); setAttempt(value => value + 1); }}>{t('deliveryPreview.retry')}</Button>
  </div>;
  if (!('limited' in result)) return null;

  return <>
    {result.limited && <p className="delivery-preview__note">{t('chatAttachment.limited')}</p>}
    {result.kind === 'html' ? <iframe className="delivery-preview__html" title={name} sandbox="" referrerPolicy="no-referrer" srcDoc={result.text} />
      : <div className="delivery-preview__scroll" tabIndex={0} role="region" aria-label={t('chatAttachment.content')}>
        {result.kind === 'markdown' || result.kind === 'text' ? (!result.text.trim() ? <p>{t('deliveryPreview.empty')}</p>
          : result.kind === 'markdown' ? <Markdown content={result.text} dompurifyConfig={STATIC_MARKDOWN} /> : <pre>{result.text}</pre>)
          : result.kind === 'docx' ? <>
            <p className="delivery-preview__note">{t('deliveryPreview.documentText')}</p>
            {result.blocks.length ? result.blocks.map(block => block.kind === 'title'
              ? <h3 key={block.unit}>{block.text}</h3> : <p key={block.unit}>{block.text}</p>) : <p>{t('deliveryPreview.empty')}</p>}
          </> : result.kind === 'pptx' ? <>
            <p className="delivery-preview__note">{t('deliveryPreview.documentText')}</p>
            {result.slides.length ? <ol className="delivery-preview__slides">{result.slides.map((slide, index) => <li key={index}>
              <h3>{t('deliveryPreview.slide', { number: index + 1 })}</h3>
              <p>{slide || t('deliveryPreview.emptySlide')}</p>
            </li>)}</ol> : <p>{t('deliveryPreview.empty')}</p>}
          </> : null}
      </div>}
  </>;
}

export function DeliveryPreview({ file, inline, onClose }: { file: DeliveryPreviewFile; inline: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const label = t('deliveryPreview.title');
  const header = <>
    <div className="delivery-preview__heading"><span>{label}</span><strong title={file.name}>{file.name}</strong></div>
    <a href={file.url} download className="delivery-preview__download" aria-label={t('chatAttachment.download')} title={t('chatAttachment.download')}><Sym name="download" /></a>
    <Button isIconOnly size="sm" variant="ghost" autoFocus={inline} aria-label={t('deliveryPreview.close')} onPress={onClose}><Sym name="close" /></Button>
  </>;
  const body = <PreviewBody key={`${file.url}:${file.kind}`} file={file} />;
  return inline ? <aside className="delivery-preview delivery-preview--inline" aria-label={label} data-testid="delivery-preview">
    <header className="delivery-preview__header">{header}</header>{body}
  </aside> : <Drawer.Root isOpen onOpenChange={open => { if (!open) onClose(); }}>
    <Drawer.Backdrop variant="opaque"><Drawer.Content placement="right" className="delivery-preview__drawer">
      <Drawer.Dialog className="delivery-preview" aria-label={label} data-testid="delivery-preview">
        <header className="delivery-preview__header">{header}</header>{body}
      </Drawer.Dialog>
    </Drawer.Content></Drawer.Backdrop>
  </Drawer.Root>;
}
