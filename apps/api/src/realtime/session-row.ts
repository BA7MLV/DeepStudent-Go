import type { RuntimeSessionRow } from '@wangke/contracts/client-runtime';

// Presentation reads must not serialize the model transcript (which can repeat
// inline images) or usage logs. Full records stay available to explicit history,
// edit and server execution paths; never write this projection back as a record.
export const sessionRowSql = "json_remove(value,'$.modelTrace','$.modelRequests')";

export function sessionRow(data: Record<string, any>): RuntimeSessionRow {
  const { modelTrace: _trace, modelRequests: _requests, ...display } = data;
  return { id: display.id, sessionId: display.sessionId, createdAt: display.createdAt,
    role: display.role, content: display.content, ...(display.taskId ? { taskId: display.taskId } : {}), data: display };
}
