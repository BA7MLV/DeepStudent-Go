import { Markdown } from './markdown/Markdown';
import { WebsiteCitationContext } from './markdown/websiteCitationContext';

const CONFIG = { breaks: true };

/** Reasoning is prose, never a second executable artifact surface. */
export default function ReasoningMarkdown({ content, streaming = false }: { content: string; streaming?: boolean }) {
  return <WebsiteCitationContext.Provider value={null}>
    <Markdown className="reasoning-markdown" content={content} config={CONFIG} escapeRawHtml
      streaming={{ hasNextChunk: streaming }} />
  </WebsiteCitationContext.Provider>;
}
