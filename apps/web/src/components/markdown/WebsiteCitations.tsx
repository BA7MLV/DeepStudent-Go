import { useMemo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { WebsiteCitationContext } from './websiteCitationContext';
import { websiteCitations } from './citationSources';
import { WebsiteFavicon, websiteOrigins } from './WebsiteLink';
import './website-citations.css';

/** One scope per answer, outside timeline/visual splits, so numbering never restarts. */
export function WebsiteCitations({ content, streaming = false, children }: {
  content: string;
  streaming?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation('common');
  const sources = useMemo(() => websiteCitations(content, streaming, websiteOrigins()), [content, streaming]);
  const index = useMemo(() => new Map(sources.map(source => [source.href, source])), [sources]);
  return <WebsiteCitationContext.Provider value={index}>
    {children}
    {sources.length > 0 && <nav className="website-sources" aria-label={t('websiteSources.label')} data-testid="website-sources">
      <span className="website-sources__label">{t('websiteSources.label')}</span>
      <div className="website-sources__icons">
        {sources.map(source => <a key={source.href} className="website-sources__icon" href={source.href}
          target="_blank" rel="noopener noreferrer" data-citation-number={source.number}
          aria-label={t('websiteSources.open', { number: source.number, name: source.label })}
          title={[`[${source.number}] ${source.label}`, source.title, source.href].filter(Boolean).join('\n')}>
          <WebsiteFavicon host={source.host} origin={source.iconOrigin} />
        </a>)}
      </div>
      <span className="website-sources__count">{sources.length}</span>
    </nav>}
  </WebsiteCitationContext.Provider>;
}
