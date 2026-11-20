import { Ajv } from 'ajv';

/** 飞书回调与开放平台响应都是网络边界数据：先按显式形状解析，再交给业务代码。
 * 平台字段可以缺失（旧版事件不带新字段），但一旦出现就必须是声明的类型；
 * 响应体不是 JSON 或形状不符时返回 undefined，由调用方按原有错误码拒绝。 */
const ajv = new Ajv({ strict: true, strictTypes: false, strictTuples: false, allowUnionTypes: true, ownProperties: true, allErrors: false, addUsedSchema: false });

export interface FeishuEvent {
  tenant_key?: string;
  message?: { message_id?: string; content?: string; message_type?: string; chat_id?: string; chat_type?: string };
  sender?: { tenant_key?: string; sender_type?: string; sender_id?: { open_id?: string } };
}
const validateEvent = ajv.compile<FeishuEvent>({
  type: 'object',
  properties: {
    tenant_key: { type: 'string' },
    message: {
      type: 'object',
      properties: {
        message_id: { type: 'string' }, content: { type: 'string' }, message_type: { type: 'string' },
        chat_id: { type: 'string' }, chat_type: { type: 'string' },
      },
      additionalProperties: true,
    },
    sender: {
      type: 'object',
      properties: {
        tenant_key: { type: 'string' }, sender_type: { type: 'string' },
        sender_id: { type: 'object', properties: { open_id: { type: 'string' } }, additionalProperties: true },
      },
      additionalProperties: true,
    },
  },
  additionalProperties: true,
});
export function feishuEvent(value: unknown): FeishuEvent | undefined {
  if (value === undefined || value === null) return undefined;
  return validateEvent(value) ? value : undefined;
}

/** `m.content` 是平台给的 JSON 字符串；解析失败或不是对象时保持空内容（原行为）。 */
export interface FeishuMessageContent { image_key?: string; file_key?: string; file_name?: string; text?: string }
const validateContent = ajv.compile<FeishuMessageContent>({
  type: 'object',
  properties: {
    image_key: { type: 'string' }, file_key: { type: 'string' }, file_name: { type: 'string' }, text: { type: 'string' },
  },
  additionalProperties: true,
});
export function feishuMessageContent(raw: string | undefined): FeishuMessageContent | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    return validateContent(value) ? value : undefined;
  } catch { return undefined; }
}

export interface FeishuTokenResponse { code?: number | string; tenant_access_token?: string; expire?: number }
const validateToken = ajv.compile<FeishuTokenResponse>({
  type: 'object',
  properties: { code: { type: ['integer', 'string'] }, tenant_access_token: { type: 'string' }, expire: { type: 'number' } },
  additionalProperties: true,
});
export function feishuTokenResponse(value: unknown): FeishuTokenResponse | undefined {
  return validateToken(value) ? value : undefined;
}

export interface FeishuMediaResponse { code?: number | string; data?: { image_key?: string; file_key?: string } }
const validateMedia = ajv.compile<FeishuMediaResponse>({
  type: 'object',
  properties: {
    code: { type: ['integer', 'string'] },
    data: { type: 'object', properties: { image_key: { type: 'string' }, file_key: { type: 'string' } }, additionalProperties: true },
  },
  additionalProperties: true,
});
export function feishuMediaResponse(value: unknown): FeishuMediaResponse | undefined {
  return validateMedia(value) ? value : undefined;
}

export interface FeishuSendResponse { code?: number | string; data?: { message_id?: string } }
const validateSend = ajv.compile<FeishuSendResponse>({
  type: 'object',
  properties: {
    code: { type: ['integer', 'string'] },
    data: { type: 'object', properties: { message_id: { type: 'string' } }, additionalProperties: true },
  },
  additionalProperties: true,
});
export function feishuSendResponse(value: unknown): FeishuSendResponse | undefined {
  return validateSend(value) ? value : undefined;
}