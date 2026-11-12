import { db } from './db';
import { resolveCloudBlob } from './cloudBlob';
import { apiUrl } from '../api/base';
import { loadSystemMaterialFile } from '../materials/systemFiles';
import { cloud } from '../cloud/state';
import { readRecordKeys } from '../cloud/sync';
import { accountLifetime } from '../client/account-lifecycle';

/** Current resource bytes are server-owned. Historical OPFS/IDB stays untouched
 * and is accessed only by the explicit recovery/export readers. */
export async function getCourseFile(id: string, _dirName?: string): Promise<Blob | null> {
  const database = db, owner = cloud.userId;
  const lifetime = cloud.enabled ? accountLifetime(owner) : undefined;
  const guard = () => { lifetime?.assertCurrent(); if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  const [resource, edited] = cloud.enabled
    ? await Promise.all([readRecordKeys<any>('courseFiles', [id]).then(rows => rows[0]), readRecordKeys<any>('files', [id]).then(rows => rows[0])])
    : await Promise.all([database.table('courseFiles').get(id), database.files.get(id)]);
  guard();
  if (resource?.resourceProjectId) {
    const response = await fetch(apiUrl(`/api/v1/resources/courses/${encodeURIComponent(id)}`), { credentials: 'include' });
    guard();
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取文件失败（${response.status}）`);
    const blob = new Blob([await response.blob()], { type: resource.mimeType }); guard(); return blob;
  }
  if (edited) { const blob = await resolveCloudBlob(edited.blob); guard(); return blob; }
  if (!resource) return null;
  const response = await fetch(apiUrl(`/api/v1/files/${encodeURIComponent(resource.fileId)}`), { credentials: 'include' });
  guard();
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取服务器文件失败（${response.status}）`);
  const blob = new Blob([await response.blob()], { type: resource.mimeType }); guard(); return blob;
}

export function getVideoFile(id: string) { return getCourseFile(id); }
export async function getMaterialFile(id: string) { return (await loadSystemMaterialFile(id)) ?? getCourseFile(id); }
