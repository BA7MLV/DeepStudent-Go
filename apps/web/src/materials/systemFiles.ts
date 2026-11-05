import { db, type VideoRow } from '../store/db';
import { boardPath } from '@wangke/contracts/board';
import { pluginPath } from '@wangke/contracts/plugins';
import { useSettings } from '../store/settings';
import { MD_MIME } from './md';
import { create } from 'zustand';
import { cloud } from '../cloud/state';
import { request, ServerApiError } from '../api/serverClient';
import { AGENTS_PATH, MCP_PATH, MEMORY_PATH, SKILLS_PATH, memoryName, memoryPath, systemSaveArguments, type SystemDocument, type SystemDirectory } from '@wangke/contracts/system';

export const AGENT_INSTRUCTIONS_FILE_ID = 'system:agent-instructions';
export const AGENT_INSTRUCTIONS_ROUTE = `/player/${encodeURIComponent(AGENT_INSTRUCTIONS_FILE_ID)}`;
export const useSystemDocuments = create<{ documents: Record<string, SystemDocument> }>()(() => ({ documents: {} }));
export function systemMaterialPath(id: string): string | undefined {
  if (id === AGENT_INSTRUCTIONS_FILE_ID) return AGENTS_PATH;
  const path = memoryPath(id.replace(/^system:memory:/, ''));
  if (id.startsWith('system:memory:') && memoryName(path)) return path;
  if (id.startsWith('system:file:')) {
    try {
      const candidate = decodeURIComponent(id.slice('system:file:'.length));
      return pluginPath(candidate) || boardPath(candidate) || candidate === MCP_PATH || candidate.startsWith(`${SKILLS_PATH}/`) && candidate.slice(1).split('/').every(part => part && part !== '.' && part !== '..') ? candidate : undefined;
    } catch { return undefined; }
  }
  return undefined;
}
export function systemMaterialId(path: string): string | undefined {
  if (path === AGENTS_PATH) return AGENT_INSTRUCTIONS_FILE_ID;
  if (memoryName(path)) return `system:memory:${memoryName(path)}`;
  return pluginPath(path) || boardPath(path) || path === MCP_PATH || path.startsWith(`${SKILLS_PATH}/`) ? `system:file:${encodeURIComponent(path)}` : undefined;
}
export const systemMaterialRoute = (path: string) => `/player/${encodeURIComponent(systemMaterialId(path)!)}`;

const systemRequest = <T>(path: string, init: RequestInit = {}) => request<T>(path, init);

function remember(document: SystemDocument) {
  const previous = useSystemDocuments.getState().documents[document.path];
  if (previous && document.kind !== 'skill' && document.kind !== 'board' && (previous.revision > document.revision || previous.revision === document.revision && previous.status === 'stale' && document.status === 'active')) return previous;
  if (previous && JSON.stringify(previous) === JSON.stringify(document)) return previous;
  useSystemDocuments.setState(state => ({ documents: { ...state.documents, [document.path]: document } }));
  return document;
}

export async function readSystemDocument(path: string): Promise<SystemDocument> {
  const database = db, owner = cloud.userId;
  const guard = () => { if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  if (path === AGENTS_PATH || path.startsWith(`${SKILLS_PATH}/`)) await (await import('../cloud/sync')).flushCloud();
  guard();
  const document = await systemRequest<SystemDocument>(`/system/file?path=${encodeURIComponent(path)}`);
  guard(); return remember(document);
}

export async function listSystemMemory(offset = 0, query = ''): Promise<SystemDirectory> {
  return listSystemDirectory(MEMORY_PATH, offset, query);
}

export async function listSystemDirectory(path: string, offset = 0, query = ''): Promise<SystemDirectory> {
  const database = db, owner = cloud.userId;
  if (path === SKILLS_PATH || path.startsWith(`${SKILLS_PATH}/`)) await (await import('../cloud/sync')).flushCloud();
  if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
  const directory = await systemRequest<SystemDirectory>(`/system/files?path=${encodeURIComponent(path)}&offset=${offset}&query=${encodeURIComponent(query)}`);
  if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed');
  return directory;
}

export async function loadSystemMaterialFile(id: string): Promise<Blob | undefined> {
  const path = systemMaterialPath(id);
  if (!path) return;
  const document = await readSystemDocument(path);
  return new Blob([document.content], { type: MD_MIME });
}

/** Synchronous cache for reader refreshes; cloud loads/saves always reach the server. */
export function getSystemMaterialFile(id: string): Blob | undefined {
  const path = systemMaterialPath(id);
  if (!path) return;
  const content = id === AGENT_INSTRUCTIONS_FILE_ID ? useSettings.getState().agentInstructions : useSystemDocuments.getState().documents[path]?.content;
  return content === undefined ? undefined : new Blob([content], { type: MD_MIME });
}

export function getSystemMaterial(id: string): VideoRow | undefined {
  const path = systemMaterialPath(id);
  if (!path) return;
  const file = getSystemMaterialFile(id);
  return { id, name: path.split('/').pop()!, kind: 'material', materialFormat: 'md', mimeType: MD_MIME,
    size: file?.size ?? 0, duration: 0, createdAt: 0, status: 'transcribed' };
}

export async function saveSystemMarkdown(id: string, text: string, expected?: string, create = false, expectedRevision?: number): Promise<boolean> {
  const database = db, owner = cloud.userId;
  const guard = () => { if (database !== db || owner !== cloud.userId) throw new Error('client_account_changed'); };
  const path = systemMaterialPath(id);
  if (!path) return false;
  {
    const { flushCloud } = await import('../cloud/sync');
    guard(); await flushCloud(); guard();
    let current: SystemDocument;
    try { current = await readSystemDocument(path); }
    catch (error) {
      if (!create || !(error instanceof ServerApiError) || error.status !== 404 || !memoryName(path) && !boardPath(path) && !pluginPath(path)) throw error;
      current = { path, name: path.split('/').at(-1)!, content: '', revision: 0, updatedAt: null };
    }
    guard();
    if (create && current.revision !== 0) throw new Error('文件已存在，请先读取，再按原文修改。');
    if (expected !== undefined && current.content !== expected) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
    let saved: SystemDocument;
    const args = systemSaveArguments(path, text, current.content, current.revision);
    try {
      saved = await systemRequest<SystemDocument>('/system/file', { method: 'POST', body: JSON.stringify(args) });
      guard(); saved = remember(saved);
    } catch (e) {
      if (e instanceof ServerApiError && e.status === 409) throw new Error('文件已在其他页面更新，请重新读取后再修改。');
      if (e instanceof ServerApiError && e.code === 'memory_source_changed') throw new Error('记忆的来源已变化，请在 Bot 记忆管理中核实后更新。');
      throw e;
    }
    await flushCloud(); guard();
    if (path === AGENTS_PATH) {
      const { applySystemAgentInstructions } = await import('../cloud/preferences');
      guard(); await applySystemAgentInstructions(saved.content, database);
    }
    return true;
  }
}
