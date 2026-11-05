import type { JevSettings } from '../store/settings';

/** 留足默认 32k 单问题 / 64k 请求窗口余量；UTF-8 字节数是保守的输入上界。 */
export const JEV_REQUEST_BYTES = 30_000;
export const JEV_MAX_QUESTIONS = 64;

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true: string; false: string };
}

export interface JevRequest {
  state: unknown;
  questions: Record<string, NoulQuestion>;
}

export function jevRequestBody(config: JevSettings, request: JevRequest): string {
  return JSON.stringify({ model: config.model.trim(), ...request });
}

export function fitsJevRequest(config: JevSettings, request: JevRequest): boolean {
  const count = Object.keys(request.questions).length;
  return count > 0 && count <= JEV_MAX_QUESTIONS &&
    new TextEncoder().encode(jevRequestBody(config, request)).length <= JEV_REQUEST_BYTES;
}
