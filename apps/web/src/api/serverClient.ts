import type {
  AgentProfileDto,
  BootstrapStatusDto,
  MessageDto,
  ThreadDto,
  ProjectDto, ProjectDetailDto, ProjectPolicy, ProjectRole, ProjectFileDto, ProjectTextDto,
  BotSnapshot, BotMessagePage, BotSyncState, BotThreadPage,
} from '@wangke/contracts';
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/browser';
import { apiUrl } from './base';

const API_ROOT = apiUrl('/api/v1');
let authenticatedIdentity: string | null | undefined;

export class ServerApiError extends Error {
  status: number;
  code: string;
  retryAfterMs?: number;
  constructor(status: number, code: string) {
    super(code);
    this.name = 'ServerApiError';
    this.status = status;
    this.code = code;
  }
}

export async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: 'include',
    ...init,
    headers: { Accept: 'application/json', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new ServerApiError(response.status, typeof body?.error === 'string' ? body.error : `http_${response.status}`);
  return body as T;
}

export interface ThreadDetail extends ThreadDto { messages: MessageDto[]; participants?: AgentProfileDto[]; approvals?: ApprovalDto[]; questions?: ThreadQuestionDto[]; runs?: ThreadRunDto[]; running?: boolean }
export interface Session { authenticated: boolean; user: { id: string; name: string } | null }
export interface FileDto { id: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string; previewServerId?: string; width?: number; height?: number }
export interface ApprovalDto { id: string; messageId: string; threadId: string; runId?: string | null; status: 'pending' | 'approved' | 'rejected'; createdAt: string; resolvedAt: string | null; resolution: string | null }
export interface ThreadQuestionDto { id: string; runId: string; messageId: string; status: 'pending' | 'answered'; createdAt: string; answeredAt: string | null; answerMessageId: string | null }
export interface ThreadRunDto { id: string; status: string; errorCode: string | null; wakeAt: string | null }

export const serverClient = {
  bootstrapStatus: () => request<BootstrapStatusDto>('/bootstrap/status'),
  bootstrapInitialize: (adminPassword: string, secret: string) => request<{ initialized: true }>('/bootstrap/initialize', {
    method: 'POST', headers: { 'X-Bootstrap-Secret': secret }, body: JSON.stringify({ adminPassword }),
  }),
  login: (password: string) => request<{ user: Session['user'] }>('/auth/password/login', { method: 'POST', body: JSON.stringify({ password }) }),
  passkeyLoginOptions: () => request<PublicKeyCredentialRequestOptionsJSON>('/auth/passkey/login/options', { method: 'POST' }),
  passkeyLoginVerify: (response: AuthenticationResponseJSON) => request<{ verified: true; user: Session['user'] }>('/auth/passkey/login/verify', { method: 'POST', body: JSON.stringify(response) }),
  passkeyRegisterOptions: () => request<PublicKeyCredentialCreationOptionsJSON>('/auth/passkey/register/options', { method: 'POST' }),
  passkeyRegisterVerify: (response: RegistrationResponseJSON) => request<{ verified: true }>('/auth/passkey/register/verify', { method: 'POST', body: JSON.stringify(response) }),
  session: async () => {
    const result = await request<Session>('/auth/session');
    const identity = result.authenticated ? result.user?.id ?? null : null;
    if (!identity || authenticatedIdentity !== undefined && authenticatedIdentity !== identity) window.dispatchEvent(new Event('wangke:bot-session-ended'));
    authenticatedIdentity = identity;
    return result;
  },
  logout: async () => {
    const result = await request<{ ok: true }>('/auth/logout', { method: 'POST' });
    window.dispatchEvent(new Event('wangke:bot-session-ended'));
    authenticatedIdentity = null;
    return result;
  },
  resetAccount: (password: string) => request<{ reset: true; initialized: false; bootstrapSecret: string; expiresAt: string }>('/account/reset', { method: 'POST', body: JSON.stringify({ password }) }),
  agents: () => request<{ agents: AgentProfileDto[] }>('/agents'),
  createAgent: (profile: { name: string; role?: string; systemPrompt?: string; avatar?: string }) => request<AgentProfileDto>('/agents', { method: 'POST', body: JSON.stringify(profile) }),
  threads: (projectId?: string) => request<{ threads: ThreadDto[] }>(`/threads${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`),
  threadPage: (projectId?: string, cursor?: string) => request<BotThreadPage>(`/threads/page?${new URLSearchParams({ ...(projectId ? { projectId } : {}), ...(cursor ? { cursor } : {}) })}`),
  threadSummary: (id: string) => request<ThreadDto>(`/threads/${encodeURIComponent(id)}/summary`),
  createThread: (title?: string, scope: { projectId?: string; agentId?: string } = {}) => request<ThreadDto>('/threads', { method: 'POST', body: JSON.stringify({ mode: 'bot', title, ...scope }) }),
  updateThread: (id: string, value: { title?: string; archived?: boolean }) => request<ThreadDto>(`/threads/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(value) }),
  deleteThread: (id: string) => request<{ deleted: true }>(`/threads/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  projects: () => request<{ projects: ProjectDto[] }>('/projects'),
  project: (id: string) => request<ProjectDetailDto>(`/projects/${encodeURIComponent(id)}`),
  createProject: (name: string, agentId: string) => request<ProjectDetailDto>('/projects', { method: 'POST', body: JSON.stringify({ name, agentId }) }),
  updateProject: (id: string, value: { name?: string; instructions?: string; policy?: ProjectPolicy; archived?: boolean }) => request<ProjectDetailDto>(`/projects/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(value) }),
  grantProject: (id: string, agentId: string, role: ProjectRole | null) => request<ProjectDetailDto>(`/projects/${encodeURIComponent(id)}/agents/${encodeURIComponent(agentId)}`, { method: 'PUT', body: JSON.stringify({ role }) }),
  projectFiles: (id: string, path = '') => request<{ files: ProjectFileDto[] }>(`/projects/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}`),
  projectText: (id: string, path: string) => request<ProjectTextDto>(`/projects/${encodeURIComponent(id)}/text?path=${encodeURIComponent(path)}`),
  writeProjectText: async (id: string, path: string, text: string, expectedRevision: string | null) =>
    await (await import('../client/resources')).resourceCommand({ kind: 'saveProjectText', projectId: id, path, text, expectedRevision }) as unknown as { path: string; revision: string },
  projectDirectory: async (id: string, path: string) => {
    await (await import('../client/resources')).resourceCommand({ kind: 'createDirectory', projectId: id, path });
    return { created: true as const };
  },
  uploadProjectFile: async (id: string, path: string, file: File) => (await import('../client/resources')).uploadResource(id, path, file),
  deleteProjectFile: async (id: string, path: string, revision: string) => {
    await (await import('../client/resources')).resourceCommand({ kind: 'remove', projectId: id, path, revision });
    return { deleted: true as const };
  },
  deleteResourceFile: async (id: string, path: string, revision: string) => {
    await (await import('../client/resources')).resourceCommand({ kind: 'remove', projectId: id, path, revision });
    return { deleted: true as const };
  },
  projectDownloadUrl: (id: string, path: string) => `${API_ROOT}/projects/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`,
  fileDownloadUrl: (id: string) => `${API_ROOT}/files/${encodeURIComponent(id)}`,
  thread: (id: string) => request<ThreadDetail>(`/threads/${encodeURIComponent(id)}`),
  threadSnapshot: (id: string, signal?: AbortSignal, beforeSeq?: number) => request<BotSnapshot>(`/threads/${encodeURIComponent(id)}/snapshot${beforeSeq ? `?beforeSeq=${beforeSeq}` : ''}`, { signal }),
  threadMessages: (id: string, beforeSeq: number, signal?: AbortSignal) => request<BotMessagePage>(`/threads/${encodeURIComponent(id)}/messages?beforeSeq=${beforeSeq}`, { signal }),
  threadSyncState: (id: string, fromSeq?: number, signal?: AbortSignal, toSeq?: number) => request<BotSyncState>(`/threads/${encodeURIComponent(id)}/sync-state?${new URLSearchParams({ ...(fromSeq ? { fromSeq: String(fromSeq) } : {}), ...(toSeq ? { toSeq: String(toSeq) } : {}) })}`, { signal }),
  threadState: (id: string) => request<Pick<ThreadDetail, 'runs' | 'questions' | 'running'>>(`/threads/${encodeURIComponent(id)}/state`),
  stopThread: (id: string) => request<{ stopped: number }>(`/threads/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  sendMessage: (id: string, content: string, clientNonce: string, target?: { kind: 'run' | 'question'; runId?: string; questionId?: string }, replyTo?: string, modelSelection?: import('@wangke/contracts/cloud').TaskModelSelection) => request<MessageDto & { deduplicated?: boolean; receipt?: unknown }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ clientNonce, role: 'user', kind: 'text', content, target, replyTo, modelSelection }) }),
  sendAttachment: (id: string, content: string, clientNonce: string, target?: { kind: 'run' | 'question'; runId?: string; questionId?: string }, replyTo?: string, modelSelection?: import('@wangke/contracts/cloud').TaskModelSelection) => request<MessageDto & { deduplicated?: boolean; receipt?: unknown }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ clientNonce, role: 'user', kind: 'attachment', content, target, replyTo, modelSelection }) }),
  uploadFile: (file: File) => request<FileDto>('/files', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Mime': file.type || 'application/octet-stream' } }),
  deleteFile: (id: string) => request<{ deleted: true }>(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  react: (messageId: string, reaction: string) => request<{ messageId: string; reaction: string; active: boolean }>(`/messages/${encodeURIComponent(messageId)}/reactions`, { method: 'POST', body: JSON.stringify({ reaction }) }),
  approvals: (id: string) => request<ApprovalDto>(`/approvals/${encodeURIComponent(id)}`),
  resolveApproval: (id: string, approved: boolean, resolution?: string) => request<ApprovalDto>(`/approvals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ approved, resolution }) }),
};
