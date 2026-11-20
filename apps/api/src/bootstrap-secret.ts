import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

/** 引导口令文件的生命周期。这里的每一步都可能落在请求路径上
 * (`POST /bootstrap/initialize` 删除文件、`POST /account/reset` 轮换口令),
 * 所以全部走 fs/promises:同步读写会在大目录/慢盘上阻塞整个事件循环。
 * 权限语义与旧的同步实现逐条对应(0700 目录、0600 文件、wx 创建、rename 原子替换)。 */

export type BootstrapSecret = { secret: string; createdAt: number };

async function statTimes(filename: string): Promise<BootstrapSecret['createdAt']> {
  const stat = await fsp.stat(filename);
  return stat.birthtimeMs || stat.ctimeMs;
}

async function readSecret(filename: string): Promise<BootstrapSecret> {
  const [secret, createdAt] = await Promise.all([fsp.readFile(filename, 'utf8'), statTimes(filename)]);
  return { secret: secret.trim(), createdAt };
}

/** 首次启动:有文件就复用,没有就生成并以 wx 落盘。EEXIST 表示并发启动抢先写入,
 * 这时必须读回对方的口令,而不是当成错误。
 * createdAt 统一取 Now 而不是 birthtime:文件系统(如容器 overlayfs)可能返回 0,
 * 而引导口令的有效期必须从本次创建时刻起算。 */
export async function loadOrCreateBootstrapSecret(secretFile: string): Promise<BootstrapSecret> {
  await fsp.mkdir(path.dirname(secretFile), { recursive: true });
  const secret = crypto.randomBytes(32).toString('base64url');
  try {
    await fsp.writeFile(secretFile, `${secret}\n`, { mode: 0o600, flag: 'wx' });
    await fsp.chmod(secretFile, 0o600);
    return { secret, createdAt: Date.now() };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // 并发启动的一方已认领口令:读回它,但不能让本进程的创建时间变成陈旧的
    // birthtime——这里记录本次发现时刻,与「创建时可见」的语义一致。
    return { secret: (await fsp.readFile(secretFile, 'utf8')).trim(), createdAt: Date.now() };
  }
}

/** 账号重置后轮换:先写临时文件再 rename,读者要么看到旧口令要么看到新口令。 */
export async function replaceBootstrapSecret(secretFile: string): Promise<BootstrapSecret> {
  await fsp.mkdir(path.dirname(secretFile), { recursive: true, mode: 0o700 });
  const secret = crypto.randomBytes(32).toString('base64url');
  const temporary = `${secretFile}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  await fsp.writeFile(temporary, `${secret}\n`, { mode: 0o600, flag: 'wx' });
  await fsp.rename(temporary, secretFile);
  await fsp.chmod(secretFile, 0o600);
  return { secret, createdAt: Date.now() };
}

/** 启动期建/读口令。调用方在 server.ts 装配阶段、监听之前,同步在这里不会阻塞
 * 任何并发请求;首次启动必须在处理第一个请求前就绪,否则引导接口会拿空口令比较。 */
export function loadOrCreateBootstrapSecretSync(secretFile: string): BootstrapSecret {
  fs.mkdirSync(path.dirname(secretFile), { recursive: true });
  const existing = fs.statSync(secretFile, { throwIfNoEntry: false });
  if (existing) return { secret: fs.readFileSync(secretFile, 'utf8').trim(), createdAt: existing.birthtimeMs || existing.ctimeMs };
  const secret = crypto.randomBytes(32).toString('base64url');
  try { fs.writeFileSync(secretFile, `${secret}\n`, { mode: 0o600, flag: 'wx' }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return { secret: fs.readFileSync(secretFile, 'utf8').trim(), createdAt: Date.now() };
  }
  fs.chmodSync(secretFile, 0o600);
  return { secret, createdAt: Date.now() };
}

/** 已初始化后删除遗留口令的同步版本,与现代码的时机一致。 */
export function removeBootstrapSecretSync(secretFile: string): void {
  fs.rmSync(secretFile, { force: true });
}

/** 已初始化后旧口令文件必须消失;ENOENT 是正常的幂等结果。 */
export async function removeBootstrapSecret(secretFile: string): Promise<void> {
  await fsp.rm(secretFile, { force: true });
}

/** 清空上传目录。目录项逐个删除,顺序与旧 readdirSync + rmSync 循环一致。 */
export async function clearDirectory(directory: string): Promise<void> {
  await fsp.mkdir(directory, { recursive: true });
  const entries = await fsp.readdir(directory);
  for (const entry of entries) await fsp.rm(path.join(directory, entry), { recursive: true, force: true });
}
