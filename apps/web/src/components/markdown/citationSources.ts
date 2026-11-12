import { Marked, type Token, type Tokens, type TokenizerExtension } from 'marked';
import { splitAssistantContent } from '../../utils/streamingHtml';
import { protectMath } from './math';
import { websiteChip } from './links';

export interface WebsiteCitation extends NonNullable<ReturnType<typeof websiteChip>> {
  href: string;
  number: number;
  title: string | null;
}

function labelText(tokens: Token[]): string | null {
  let text = '';
  for (const token of tokens) {
    if (['text', 'strong', 'em', 'del'].includes(token.type) && 'tokens' in token && token.tokens) {
      const part = labelText(token.tokens);
      if (part === null) return null;
      text += part;
    } else if (['text', 'codespan', 'escape'].includes(token.type)) {
      text += (token as Tokens.Text).text;
    } else if (token.type === 'html' && /^<\/?(?:strong|b|em|i|s|del|code|span)(?:\s[^<>]*)?\s*\/?\s*>$/i.test(token.raw)) {
      continue;
    } else {
      // Rich embeds keep their own renderer and must not become numeric citations.
      return null;
    }
  }
  return text;
}

/** Collect only rendered Markdown links, never URLs inside code, works or TeX. */
export function websiteCitations(content: string, streaming = false, ownOrigins: string[] = []): WebsiteCitation[] {
  if (!/https?:\/\/|www\./i.test(content)) return [];
  const incomplete: TokenizerExtension = {
    name: 'pendingCitation',
    level: 'inline',
    start: source => source.indexOf('['),
    tokenizer(source) {
      if (!streaming) return;
      const match = /^!?\[[^\r\n]*?\]\([^\r\n]*$/.exec(source);
      if (!match) return;
      // Do not let Marked autolink a URL inside an unfinished destination.
      let depth = 1;
      let quote = '';
      let angle = false;
      const destination = match[0].indexOf('](') + 2;
      for (let i = destination; i < match[0].length; i++) {
        if (match[0][i] === '\\') i++;
        else if (quote) { if (match[0][i] === quote) quote = ''; }
        else if (angle) { if (match[0][i] === '>') angle = false; }
        else if (match[0][i] === '<' && i === destination) angle = true;
        else if (['"', "'"].includes(match[0][i]) && /\s/.test(match[0][i - 1])) quote = match[0][i];
        else if (match[0][i] === '(') depth++;
        else if (match[0][i] === ')' && --depth === 0) return;
      }
      return { type: 'pendingCitation', raw: match[0] };
    },
  };
  const parser = new Marked({ gfm: true, extensions: [incomplete] });
  const sources = new Map<string, WebsiteCitation>();
  const visit = (tokens: Token[]) => {
    for (const token of tokens) {
      if (token.type === 'image') continue;
      if (token.type === 'list') { for (const item of (token as Tokens.List).items) visit(item.tokens); continue; }
      if (token.type === 'table') {
        const table = token as Tokens.Table;
        for (const row of [table.header, ...table.rows]) for (const cell of row) visit(cell.tokens);
        continue;
      }
      if (token.type !== 'link') {
        if ('tokens' in token && token.tokens) visit(token.tokens);
        continue;
      }
      const link = token as Tokens.Link;
      const text = labelText(link.tokens);
      const chip = text === null ? null : websiteChip(link.href, text, ownOrigins);
      if (!chip) continue;
      const href = new URL(link.href).href;
      if (!sources.has(href)) sources.set(href, { ...chip, href, number: sources.size + 1, title: link.title ?? null });
    }
  };
  for (const block of splitAssistantContent(content)) {
    if (block.kind === 'markdown') visit(parser.lexer(protectMath(block.source, streaming)));
  }
  return [...sources.values()];
}
