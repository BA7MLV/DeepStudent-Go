import type { PluginCatalog } from './catalog';

/** UI hints are resolved against the authenticated server catalog, never used as
 * authority by actions. The API separately checks project and material ownership. */
export function pluginProject(data: PluginCatalog | undefined, materialId?: string, projectId?: string, projectFolderId?: number) {
  const scopes = data?.scopes;
  const requested = projectId ?? (projectFolderId == null ? undefined : scopes?.projectFolders.find(p => p.folderId === projectFolderId)?.projectId);
  const materialProject = materialId ? scopes?.materialProjects[materialId] : undefined;
  if (requested && (!scopes?.projects.some(p => p.id === requested) || materialProject && materialProject !== requested)) return undefined;
  return requested ?? materialProject;
}
