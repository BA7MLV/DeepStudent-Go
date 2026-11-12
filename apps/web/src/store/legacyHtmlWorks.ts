import { db } from './db';
import { editMessage } from '../client/learning';
import { splitAssistantContent } from '../utils/streamingHtml';
import { artifactFences } from '../utils/artifactEdit';
import { prepareInteractiveHtml } from '../utils/htmlAnswer';
import { uuid } from '../utils/uuid';
import { versionWidget, validateWidgetPayload } from '../harness/widgetProtocol';
import type { WidgetPayload } from '../harness/widgetRuntime';
import { readConversationMessage } from './conversationProducts';
import { accountLifecycle } from '../client/account-lifecycle';

export function legacyHtmlSources(content: string): Set<string> {
  const sources = new Set(splitAssistantContent(content)
    .filter(block => block.kind === 'html' && block.closed).map(block => block.source));
  for (const fence of artifactFences(content)) {
    if (/^html?$/i.test(fence.kind)) sources.add(content.slice(fence.start, fence.end));
  }
  return sources;
}

function prepare(source: string): WidgetPayload {
  return versionWidget({ html: prepareInteractiveHtml(source), source: 'legacy-html' }, uuid());
}

/** Inert, idempotent compatibility/explicit-example adaptation. No script runs
 * here; ordinary examples call this only after the reader opens preview. */
export async function openLegacyHtmlWork(source: string, rowId?: number): Promise<WidgetPayload> {
  if (rowId == null) return prepare(source);
  const database = db;
  const lifetime = accountLifecycle.current();
  const guard = () => { lifetime?.assertCurrent(); if (database !== db) throw new Error('client_account_changed'); };
  const run = async () => {
    const row = await readConversationMessage(rowId);
    guard();
    if (!row || row.role !== 'assistant') throw new Error('原回答已删除，请回到当前会话');
    const sources = legacyHtmlSources(row.content);
    if (!sources.has(source)) throw new Error('此 HTML 已修改，请重新打开当前版本');
    const previous = row.legacyHtmlWorks?.find(work => work.source === source);
    if (previous) { validateWidgetPayload(previous.payload); return previous.payload; }
    const payload = prepare(source);
    const patch = { legacyHtmlWorks: [
      ...(row.legacyHtmlWorks ?? []).filter(work => sources.has(work.source)), { source, payload },
    ] };
    await editMessage(row, { ...row, ...patch });
    guard();
    return payload;
  };
  return run();
}
