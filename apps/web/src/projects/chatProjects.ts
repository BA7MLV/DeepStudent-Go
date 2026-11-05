import type { ProjectDetailDto } from '@wangke/contracts';
import type { ResourceFolderColor } from '@wangke/contracts/resources';
import { flushCloud } from '../cloud/sync';
import { readResources, resourceCommand } from '../client/resources';

export interface ChatProject { folderId: number; name: string; color?: ResourceFolderColor }
export const projectDisplayName = (name: string) => name.replace(/^项目[：:]\s*/, '');
export function projectFolderName(name: string) {
  const title = projectDisplayName(name.trim()).trim();
  if (!title || title.length > 97 || /[\\/\u0000-\u001f\u007f]/.test(title)) throw new Error('invalid_project_name');
  return `项目：${title}`;
}
export async function listChatProjects(): Promise<ChatProject[]> {
  await flushCloud();
  const data = await readResources();
  return data.entries.filter(entry => entry.kind === 'directory' && entry.scope && entry.folderId != null)
    .map(entry => ({ folderId: entry.folderId!, name: entry.name, color: entry.color }));
}
export async function createChatProject(name: string): Promise<ChatProject> {
  const folderName = projectFolderName(name);
  const project = await resourceCommand({ kind: 'createFolder', name: folderName }) as unknown as ProjectDetailDto & { folderId: number };
  return { folderId: project.folderId, name: project.name };
}
