import type { McpContext } from '@wangke/contracts/mcp';
import type { DatabaseStore } from '../storage/database.js';
import type { CloudRecords } from '../cloud/records.js';

/** Resolve live, owner-scoped grants. Never trust a scope supplied by a task/model. */
export function mcpScope(store: DatabaseStore, records: CloudRecords, owner: string, context: McpContext): string[] | undefined {
  if (!context || (context.sessionId !== undefined) === (context.threadId !== undefined)) throw new Error('mcp_invalid_context');
  let ids: unknown;
  if (context.sessionId !== undefined) {
    if (!Number.isSafeInteger(context.sessionId)) throw new Error('mcp_invalid_context');
    const session = records.get(owner, 'chatSessions', context.sessionId);
    if (!session) throw new Error('mcp_context_denied');
    ids = session.mcpServerIds;
  } else {
    if (typeof context.threadId !== 'string') throw new Error('mcp_invalid_context');
    const thread = store.db.prepare('SELECT mcp_server_ids,project_id FROM threads WHERE id=? AND owner_id=?').get(context.threadId, owner) as { mcp_server_ids: string | null; project_id: string | null } | undefined;
    if (!thread) throw new Error('mcp_context_denied');
    // External connectors are owner-scoped, not project-scoped.
    if (thread.project_id) return [];
    ids = thread.mcp_server_ids === null ? undefined : JSON.parse(thread.mcp_server_ids);
  }
  if (ids !== undefined && (!Array.isArray(ids) || ids.some(id => typeof id !== 'string'))) throw new Error('mcp_invalid_scope');
  return ids as string[] | undefined;
}
