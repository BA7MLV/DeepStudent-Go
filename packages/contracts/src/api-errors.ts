/**
 * REST 准入拒绝的稳定错误码。客户端（Web/原生壳/脚本）只按 `error` 字段分支，
 * 因此每个码都必须是我们自己决定的常量，而不是数据库或运行时抛出的任意文本。
 */
export const BOT_MESSAGE_ADMISSION_ERRORS = [
  /** 账号还没配置可用的对话模型：这是配置缺失，不是服务端故障。 */
  'model_not_configured',
  'invalid_model_selection',
  'target_expired',
  'question_already_answered',
  'target_waiting_for_specific_answer',
  'message_nonce_conflict',
  'task_model_requires_new_attempt',
] as const;
export type BotMessageAdmissionError = typeof BOT_MESSAGE_ADMISSION_ERRORS[number];

/** 历史契约：错误响应最小形状就是一个具名字符串 `error`。 */
export interface ApiErrorResponse {
  error: string;
}

/**
 * 准入门控拒绝。`code` 放进 `error` 字段以保持老客户端的解析方式；
 * `status` 是建议的 HTTP 状态码，新增字段，旧读取方忽略即可。
 */
export interface ApiAdmissionErrorResponse extends ApiErrorResponse {
  error: BotMessageAdmissionError;
  status: number;
}

export function isBotMessageAdmissionError(value: string): value is BotMessageAdmissionError {
  return (BOT_MESSAGE_ADMISSION_ERRORS as readonly string[]).includes(value);
}

/**
 * 准入错误 → HTTP 状态码。放在契约里而不是各端各写一份，
 * 避免 REST、IM 适配器和测试对同一个码给出不同的状态。
 */
export function botMessageAdmissionStatus(code: BotMessageAdmissionError): number {
  // 409：会话/目标状态冲突，客户端换个目标或等当前任务结束。
  // 400：请求本身或本地配置不可用，需要用户先改配置。
  return code === 'target_expired' || code === 'question_already_answered' || code === 'target_waiting_for_specific_answer' || code === 'message_nonce_conflict' || code === 'task_model_requires_new_attempt' ? 409 : 400;
}

/**
 * 把调用方异常折叠成准入错误码；不认识的异常返回 undefined，
 * 由调用方原样抛出（真正的服务端故障不能被伪装成 4xx）。
 */
export function botMessageAdmissionError(reason: { name?: string; message?: string } | null | undefined, properties: Record<string, unknown> | null | undefined): BotMessageAdmissionError | undefined {
  // 具名错误类优先：它不依赖 `props.code` 恰好是字符串，也让非 Error 抛出物可判。
  // 旧调用方仍以 `new Error('xxx')` 抛出这些码，所以要同时看 message。
  const named = reason?.name;
  if (named === BOT_MODEL_NOT_CONFIGURED_ERROR_NAME) return 'model_not_configured';
  if (named && isBotMessageAdmissionError(named)) return named;
  const candidates = [reason?.message, properties?.code];
  for (const candidate of candidates) if (typeof candidate === 'string' && isBotMessageAdmissionError(candidate)) return candidate;
  return undefined;
}

// 契约不依赖任何 workspace 包，所以错误类名以字符串形式发布：
// 生产方（api）按它命名类，消费方按它识别，不需要跨包 instanceof。
export const BOT_MODEL_NOT_CONFIGURED_ERROR_NAME = 'BotModelNotConfiguredError';
