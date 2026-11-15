/**
 * 前后端共享的 REST DTO 与信任边界校验器。
 *
 * 这些形状此前只存在于 web 的 serverClient.ts 里,两端会漂移;搬进 contracts 后,
 * `request` 在把响应体交给业务代码前先过 `validateServerDto`,坏数据不再一路
 * 断言穿透到界面。校验器刻意手写、零依赖:contracts 不依赖任何其他 workspace。
 */
export interface Session { authenticated: boolean; user: { id: string; name: string } | null }
export interface FileDto { id: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string; previewServerId?: string; width?: number; height?: number }
export interface ApprovalDto { id: string; messageId: string; threadId: string; runId?: string | null; status: 'pending' | 'approved' | 'rejected'; createdAt: string; resolvedAt: string | null; resolution: string | null }
export interface ThreadQuestionDto { id: string; runId: string; messageId: string; status: 'pending' | 'answered'; createdAt: string; answeredAt: string | null; answerMessageId: string | null }
export interface ThreadRunDto { id: string; status: string; errorCode: string | null; wakeAt: string | null }

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fail = (shape: string): never => { throw new Error(`server_contract_violation:${shape}`); };
const string = (value: unknown): string => typeof value === 'string' ? value : fail('string');
const nullableString = (value: unknown): string | null => value === null ? null : string(value);
const boolean = (value: unknown): boolean => typeof value === 'boolean' ? value : fail('boolean');
const number = (value: unknown): number => typeof value === 'number' && Number.isFinite(value) ? value : fail('number');
const optional = <T>(check: (value: unknown) => T) => (value: unknown): T | undefined => value === undefined ? undefined : check(value);

export function validateSession(value: unknown): Session {
  if (!isObject(value)) return fail('session');
  if (value.authenticated !== false && value.authenticated !== true) fail('session.authenticated');
  if (value.user !== null && !isObject(value.user)) return fail('session.user');
  return { authenticated: boolean(value.authenticated), user: value.user === null ? null : { id: string(value.user.id), name: string(value.user.name) } };
}

export function validateFileDto(value: unknown): FileDto {
  if (!isObject(value)) return fail('file');
  return { id: string(value.id), originalName: string(value.originalName), mimeType: string(value.mimeType),
    sizeBytes: number(value.sizeBytes), sha256: string(value.sha256), createdAt: string(value.createdAt),
    previewServerId: optional(string)(value.previewServerId), width: optional(number)(value.width), height: optional(number)(value.height) };
}

export function validateApprovalDto(value: unknown): ApprovalDto {
  if (!isObject(value)) return fail('approval');
  if (!['pending', 'approved', 'rejected'].includes(value.status as string)) return fail('approval.status');
  return { id: string(value.id), messageId: string(value.messageId), threadId: string(value.threadId),
    runId: value.runId === undefined ? undefined : nullableString(value.runId), status: value.status as ApprovalDto['status'],
    createdAt: string(value.createdAt), resolvedAt: nullableString(value.resolvedAt), resolution: nullableString(value.resolution) };
}

export function validateThreadQuestionDto(value: unknown): ThreadQuestionDto {
  if (!isObject(value)) return fail('thread_question');
  if (!['pending', 'answered'].includes(value.status as string)) return fail('thread_question.status');
  return { id: string(value.id), runId: string(value.runId), messageId: string(value.messageId), status: value.status as ThreadQuestionDto['status'],
    createdAt: string(value.createdAt), answeredAt: nullableString(value.answeredAt), answerMessageId: nullableString(value.answerMessageId) };
}

export function validateThreadRunDto(value: unknown): ThreadRunDto {
  if (!isObject(value)) return fail('thread_run');
  return { id: string(value.id), status: string(value.status), errorCode: nullableString(value.errorCode), wakeAt: nullableString(value.wakeAt) };
}
