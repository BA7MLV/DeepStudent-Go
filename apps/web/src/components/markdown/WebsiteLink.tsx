import { useContext, useState, type ReactNode } from 'react';
import type { ComponentProps } from '@ant-design/x-markdown';
import { IconArrowUpRight, IconWorld } from '@tabler/icons-react';
import { useTranslation } from 'react-i18next';
import { API_BASE_URL, apiUrl } from '../../api/base';
import { linkText, websiteChip } from './links';
import { websiteBrand } from './websiteBrands';
import { WebsiteCitationContext } from './websiteCitationContext';
import './website-link.css';

function RemoteFavicon({ origin }: { origin: string | null }) {
  const [status, setStatus] = useState<'pending' | 'loaded' | 'failed'>('pending');
  return <span className="md-link-chip__icon" data-loaded={status === 'loaded' || undefined} aria-hidden="true">
    <IconWorld size="1em" />
    {origin && status !== 'failed' && <img src={apiUrl(`/api/v1/link-icons?origin=${encodeURIComponent(origin)}`)} alt="" width="16" height="16"
      loading="lazy" decoding="async" crossOrigin="use-credentials" referrerPolicy="no-referrer" onLoad={() => setStatus('loaded')} onError={() => setStatus('failed')} />}
  </span>;
}

export function WebsiteFavicon({ host, origin }: { host: string; origin: string | null }) {
  const brand = websiteBrand(host);
  if (!brand) return <RemoteFavicon key={origin} origin={origin} />;
  const BrandIcon = brand.Icon;
  return <span className="md-link-chip__icon" data-brand={brand.id} aria-hidden="true"><BrandIcon size="1em" /></span>;
}

export function websiteOrigins(): string[] {
  const ownOrigins = typeof window === 'undefined' ? [] : [window.location.origin];
  if (API_BASE_URL) {
    try { ownOrigins.push(new URL(API_BASE_URL).origin); } catch { /* A relative API base already uses the page's origin. */ }
  }
  return ownOrigins;
}

export function WebsiteLink({ href, children, title, target, rel, domNode }: Partial<ComponentProps> & { href?: string; children?: ReactNode }) {
  const citations = useContext(WebsiteCitationContext);
  const { t } = useTranslation('common');
  const text = domNode ? linkText(domNode) : typeof children === 'string' ? children : null;
  const chip = text === null ? null : websiteChip(href, text, websiteOrigins());
  const linkTarget = chip ? '_blank' : typeof target === 'string' ? target : undefined;
  const linkRel = linkTarget === '_blank' ? [...new Set(`${typeof rel === 'string' ? rel : ''} noopener noreferrer`.trim().split(/\s+/))].join(' ') : typeof rel === 'string' ? rel : undefined;
  if (!chip) return <a href={href} title={typeof title === 'string' ? title : undefined} target={linkTarget} rel={linkRel}>{children}</a>;
  const fullTitle = [typeof title === 'string' ? title : '', !chip.bare ? chip.label : '', href].filter(Boolean).join('\n');
  const citation = href && citations?.get(new URL(href).href);
  if (citation) return <sup className="md-website-citation"><a href={href} target={linkTarget} rel={linkRel} title={fullTitle}
    aria-label={t('websiteSources.open', { number: citation.number, name: chip.label })}>[{citation.number}]</a></sup>;
  return <a href={href} className="md-link-chip" target={linkTarget} rel={linkRel} title={fullTitle} dir={chip.bare ? 'ltr' : undefined}>
    <WebsiteFavicon host={chip.host} origin={chip.iconOrigin} />
    <span className="md-link-chip__label">{chip.bare ? chip.label : children || chip.label}</span>
    {!chip.bare && <span className="md-link-chip__domain" dir="ltr">{chip.domain}</span>}
    <IconArrowUpRight className="md-link-chip__arrow" size="1em" aria-hidden="true" />
  </a>;
}
