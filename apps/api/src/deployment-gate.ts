import fs from 'node:fs';

/** 发布门禁:只有激活文件内容等于本次发布令牌的哈希时才放行流量。
 * 调用点在 server.ts 装配阶段(监听之前),同步读这一次不会阻塞任何请求;
 * 之后的激活写入走异步路径(routes/deployment.ts)。 */
export function releaseHeld(deps: { releaseId: string | undefined; releaseToken: string; activationFile: string | null; hashToken: (value: string) => string }): boolean {
  if (!deps.releaseId) return false;
  if (!deps.activationFile || !fs.existsSync(deps.activationFile)) return true;
  // 启动期只读一次:装配完成后门禁状态是内存变量,不再重读;监听之后改用异步激活写入。
  return fs.readFileSync(deps.activationFile, 'utf8') !== deps.hashToken(deps.releaseToken);
}
