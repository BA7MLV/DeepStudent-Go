import { mcpToolDefinition } from '@wangke/contracts/mcp';
import { mcpError } from '../src/mcp/manager.js';
import { mcpScope } from '../src/mcp/scope.js';
import type { TaskContext } from '../src/cloud/execution.js';

/** Native chat shares connections/transports with HTTP chat and BotRunner. */
export async function sessionMcp(context: TaskContext) {
  const scope = () => {
    context.checkActive();
    const ids = mcpScope(context.store, context.records, context.owner, { sessionId: Number(context.task.input.sessionId) });
    // BotRunner owns external-call approvals. Nested study tasks must not
    // bypass those approvals (or project isolation) via a chat session.
    const parent = context.store.db.prepare('SELECT parent_run_id FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as { parent_run_id: string | null } | undefined;
    return parent?.parent_run_id ? [] : ids;
  };
  const catalog = await context.mcp?.catalog(context.owner, scope()) ?? { tools: [], warnings: [] };
  context.checkActive();
  const tools = catalog.tools.map(mcpToolDefinition);
  const metadata = new Map(catalog.tools.map(tool => [tool.name, tool]));
  return {
    tools,
    serverNames: new Set(catalog.tools.map(tool => tool.serverName)),
    label(name: string) {
      const tool = metadata.get(name);
      return tool ? `MCP · ${tool.serverName} / ${tool.originalName}` : name;
    },
    traces: catalog.warnings.map(warning => ({ name: 'mcp_catalog', status: 'error' as const, result: warning })),
    wrap(execute: (name: string, args: Record<string, unknown>) => Promise<string>) {
      return async (name: string, args: Record<string, unknown>): Promise<string> => {
        if (!name.startsWith('mcp_')) return execute(name, args);
        const tool = metadata.get(name);
        if (!tool || !context.mcp) throw new Error('mcp_tool_unavailable');
        if (JSON.stringify(args).length > 100000) throw new Error('mcp_invalid_arguments');
        let result;
        try {
          result = await context.mcp.call(context.owner, name, args, scope(), context.signal);
        } catch (error) {
          context.checkActive();
          throw new Error(mcpError(error));
        }
        const current = scope();
        if (current !== undefined && !current.includes(tool.serverId)) throw new Error('mcp_authorization_changed');
        // Propagate MCP isError to the durable tool trace as well as the model.
        if (result.isError) throw new Error(result.text);
        return result.text;
      };
    },
  };
}
