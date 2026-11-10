import { db } from './db';
import { resolveCloudBlob } from './cloudBlob';
import { apiUrl } from '../api/base';
import { loadSystemMaterialFile } from '../materials/systemFiles';

/** Current resource bytes are server-owned. Historical OPFS/IDB stays untouched
 * and is accessed only by the explicit recovery/export readers. */
export async function getCourseFile(id: string, _dirName?: string): Promise<Blob | null> {
  const resource = await db.table('courseFiles').get(id);
  if (resource?.resourceProjectId) {
    const response = await fetch(apiUrl(`/api/v1/resources/courses/${encodeURIComponent(id)}`), { credentials: 'include' });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`读取文件失败（${response.status}）`);
    return new Blob([await response.blob()], { type: resource.mimeType });
  }
  const edited = await db.files.get(id);
  if (edited) return resolveCloudBlob(edited.blob);
  if (!resource) return null;
  const response = await fetch(apiUrl(`/api/v1/files/${encodeURIComponent(resource.fileId)}`), { credentials: 'include' });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`读取服务器文件失败（${response.status}）`);
  return new Blob([await response.blob()], { type: resource.mimeType });
}

export function getVideoFile(id: string) { return getCourseFile(id); }
export async function getMaterialFile(id: string) { return (await loadSystemMaterialFile(id)) ?? getCourseFile(id); }
