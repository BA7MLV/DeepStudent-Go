import type { DatabaseStore } from '../storage/database.js';
import type { CloudConfiguration } from '../cloud/config.js';

export function biliCookie(store: DatabaseStore, configuration: CloudConfiguration, owner: string): string {
  const row = store.db.prepare('SELECT value FROM bilibili_credentials WHERE owner_id=?').get(owner) as { value: string } | undefined;
  return row ? configuration.open(row.value) : '';
}

export function saveBiliCookie(store: DatabaseStore, configuration: CloudConfiguration, owner: string, cookie: unknown) {
  if (typeof cookie !== 'string' || cookie.length > 16384 || /[^\x20-\x7e]/.test(cookie)) throw new Error('B 站 Cookie 格式无效，请粘贴 Cookie 请求头的内容。');
  const value = cookie.trim();
  if (value && !value.split(';').every(part => /^\s*[^=;\s]+=[^;]*$/.test(part))) throw new Error('B 站 Cookie 格式无效。');
  if (value) store.db.prepare('INSERT INTO bilibili_credentials(owner_id,value) VALUES(?,?) ON CONFLICT(owner_id) DO UPDATE SET value=excluded.value').run(owner, configuration.seal(value));
  else store.db.prepare('DELETE FROM bilibili_credentials WHERE owner_id=?').run(owner);
  configuration.audit(owner, 'bilibili.credentials.updated', { configured: Boolean(value) });
  return { configured: Boolean(value) };
}
