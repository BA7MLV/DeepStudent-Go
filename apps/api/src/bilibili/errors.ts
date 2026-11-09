import { BiliHttpError } from '@wangke/study-core/bilibili/api';

/** Only fixed messages and numeric upstream codes leave the server, never URLs or cookies. */
export class BiliNetworkError extends Error {
  constructor(message: string, readonly status?: number) { super(message); }
}

export function biliResolveFailure(error: unknown): { status: number; error: string } {
  if (error instanceof BiliHttpError) {
    const code = error.apiCode;
    if (code === -404 || code === 62002) return { status: 400, error: '该 B 站视频不存在、已删除或暂不可见，请检查链接。' };
    if (code === -101 || code === -111) return { status: 400, error: `B 站登录态缺失或已失效（code=${code}），请在设置中更新 B 站 Cookie。` };
    if (code === -403 || code === 62012) return { status: 400, error: `B 站拒绝访问该视频（code=${code}），请检查账号权限或视频可见范围。` };
    if (code === -352 || code === -412 || error.status === 412 || error.status === 429) return { status: 502, error: 'B 站触发风控或请求频率限制，请稍后重试；如持续出现，请检查服务器出口网络。' };
    return { status: 502, error: Number.isInteger(code) ? `B 站接口返回错误（code=${code}），请稍后重试。` : 'B 站返回的视频数据无效，请检查链接或稍后重试。' };
  }
  if (error instanceof BiliNetworkError) {
    if (error.status === 412 || error.status === 429) return { status: 502, error: 'B 站触发风控或请求频率限制，请稍后重试；如持续出现，请检查服务器出口网络。' };
    if (error.status === 403) return { status: 502, error: 'B 站拒绝服务器访问（HTTP 403），请检查服务器出口网络和 B 站登录态。' };
    return { status: 502, error: error.message };
  }
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return { status: 504, error: '服务器请求 B 站超时，请检查服务器网络或稍后重试。' };
  if (error instanceof TypeError) return { status: 502, error: '服务器无法连接 B 站，请检查服务器 DNS、网络出口和 TLS 连接。' };
  return { status: 502, error: '服务器暂时无法解析该 B 站链接，请稍后重试。' };
}
