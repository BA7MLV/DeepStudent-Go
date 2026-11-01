import type {
  AgentProfileDto,
  BootstrapStatusDto,
  MessageDto,
  SseEvent,
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
export interface FileDto { id: string; originalName: string; mimeType: string; sizeBytes: number; sha256: string; createdAt: string }
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
  writeProjectText: (id: string, path: string, text: string, expectedRevision: string | null) => request<{ path: string; revision: string }>(`/projects/${encodeURIComponent(id)}/text?path=${encodeURIComponent(path)}`, { method: 'PUT', body: JSON.stringify({ text, expectedRevision }) }),
  projectDirectory: (id: string, path: string) => request<{ created: true }>(`/projects/${encodeURIComponent(id)}/directories?path=${encodeURIComponent(path)}`, { method: 'POST' }),
  uploadProjectFile: (id: string, path: string, file: File) => request<{ path: string; size: number }>(`/projects/${encodeURIComponent(id)}/uploads?path=${encodeURIComponent(path)}`, { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream' } }),
  deleteProjectFile: (id: string, path: string, revision: string) => request<{ deleted: true }>(`/projects/${encodeURIComponent(id)}/files?path=${encodeURIComponent(path)}&revision=${encodeURIComponent(revision)}`, { method: 'DELETE' }),
  deleteResourceFile: (id: string, path: string, revision: string) => request<{ deleted: true }>(`/resources/file?projectId=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}&revision=${encodeURIComponent(revision)}`, { method: 'DELETE' }),
  projectDownloadUrl: (id: string, path: string) => `${API_ROOT}/projects/${encodeURIComponent(id)}/download?path=${encodeURIComponent(path)}`,
  fileDownloadUrl: (id: string) => `${API_ROOT}/files/${encodeURIComponent(id)}`,
  thread: (id: string) => request<ThreadDetail>(`/threads/${encodeURIComponent(id)}`),
  threadSnapshot: (id: string, signal?: AbortSignal, beforeSeq?: number) => request<BotSnapshot>(`/threads/${encodeURIComponent(id)}/snapshot${beforeSeq ? `?beforeSeq=${beforeSeq}` : ''}`, { signal }),
  threadMessages: (id: string, beforeSeq: number, signal?: AbortSignal) => request<BotMessagePage>(`/threads/${encodeURIComponent(id)}/messages?beforeSeq=${beforeSeq}`, { signal }),
  threadSyncState: (id: string, fromSeq?: number, signal?: AbortSignal, toSeq?: number) => request<BotSyncState>(`/threads/${encodeURIComponent(id)}/sync-state?${new URLSearchParams({ ...(fromSeq ? { fromSeq: String(fromSeq) } : {}), ...(toSeq ? { toSeq: String(toSeq) } : {}) })}`, { signal }),
  threadState: (id: string) => request<Pick<ThreadDetail, 'runs' | 'questions' | 'running'>>(`/threads/${encodeURIComponent(id)}/state`),
  stopThread: (id: string) => request<{ stopped: number }>(`/threads/${encodeURIComponent(id)}/stop`, { method: 'POST' }),
  sendMessage: (id: string, content: string, clientNonce: string, target?: { kind: 'run' | 'question'; runId?: string; questionId?: string }, replyTo?: string) => request<MessageDto & { deduplicated?: boolean; receipt?: unknown }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ clientNonce, role: 'user', kind: 'text', content, target, replyTo }) }),
  sendAttachment: (id: string, content: string, clientNonce: string, target?: { kind: 'run' | 'question'; runId?: string; questionId?: string }, replyTo?: string) => request<MessageDto & { deduplicated?: boolean; receipt?: unknown }>(`/threads/${encodeURIComponent(id)}/messages`, { method: 'POST', body: JSON.stringify({ clientNonce, role: 'user', kind: 'attachment', content, target, replyTo }) }),
  uploadFile: (file: File) => request<FileDto>('/files', { method: 'POST', body: file, headers: { 'Content-Type': 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-File-Mime': file.type || 'application/octet-stream' } }),
  deleteFile: (id: string) => request<{ deleted: true }>(`/files/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  react: (messageId: string, reaction: string) => request<{ messageId: string; reaction: string; active: boolean }>(`/messages/${encodeURIComponent(messageId)}/reactions`, { method: 'POST', body: JSON.stringify({ reaction }) }),
  approvals: (id: string) => request<ApprovalDto>(`/approvals/${encodeURIComponent(id)}`),
  resolveApproval: (id: string, approved: boolean, resolution?: string) => request<ApprovalDto>(`/approvals/${encodeURIComponent(id)}/resolve`, { method: 'POST', body: JSON.stringify({ approved, resolution }) }),
  async events(id: string, after: number, onEvent: (event: SseEvent, id: number) => void, signal?: AbortSignal, live = false, onOpen?: () => void) {
    const response = await fetch(`${API_ROOT}/threads/${encodeURIComponent(id)}/${live ? 'stream' : 'events'}?after=${after}`, { credentials: 'include', headers: { Accept: 'text/event-stream', 'Last-Event-ID': String(after) }, signal });
    if (!response.ok || !response.body) {
      const error = new ServerApiError(response.status, `events_${response.status}`);
      const retry = response.headers.get('retry-after');
      if (retry) error.retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Math.max(0, Date.parse(retry) - Date.now());
      throw error;
    }
    onOpen?.();
    const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = ''; let eventId = after;
    const consume = (block: string) => {
      let data = '';
      let nextType = '';
      let nextId = eventId;
      let hasId = false;
      for (const line of block.split('\n')) {
        if (line.startsWith('id:')) {
          const parsed = Number(line.slice(3).trim());
          if (Number.isSafeInteger(parsed) && parsed > 0) { nextId = parsed; hasId = true; }
        } else if (line.startsWith('event:')) nextType = line.slice(6).trim();
        else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trim();
      }
      if (!data || !nextType) return;
      let parsed;
      try { parsed = JSON.parse(data); } catch { throw new Error('invalid_sync_event'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('invalid_sync_event');
      const event = { ...parsed, type: nextType } as SseEvent;
      if (!['message.pending', 'message.accepted', 'message.updated', 'message.reaction', 'run.started', 'run.progress', 'run.waiting_user', 'run.completed', 'run.failed', 'thread.state_invalidated', 'resync.required'].includes(nextType)) {
        onEvent({ type: nextType } as SseEvent, nextId); eventId = nextId; return;
      }
      if (nextType !== 'resync.required' && !hasId) throw new Error('invalid_sync_event');
      if (['message.pending', 'message.accepted', 'message.updated'].includes(nextType)) {
        const message = 'message' in event ? event.message : null;
        if (nextId <= 0 || !message || typeof message.id !== 'string' || message.threadId !== id || !Number.isSafeInteger(message.seq) || message.seq < 1 || typeof message.content !== 'string' || typeof message.createdAt !== 'string' || !Number.isFinite(Date.parse(message.createdAt)) || !['user', 'assistant', 'tool', 'system'].includes(message.role) || !['text', 'progress', 'attachment', 'widget', 'question', 'approval', 'web_sources'].includes(message.kind)) throw new Error('invalid_sync_event');
      }
      // Only advance after the consumer successfully validated/applied the event.
      onEvent(event, nextId);
      eventId = nextId;
    };
    try {
      for (;;) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const part = await Promise.race([reader.read(), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('sync_timeout')), 45_000); })]).finally(() => clearTimeout(timer));
        if (part.done) break;
        buffer = (buffer + decoder.decode(part.value, { stream: true })).replace(/\r\n/g, '\n');
        if (buffer.length > 2 * 1024 * 1024) throw new Error('sync_event_too_large');
        const blocks = buffer.split('\n\n'); buffer = blocks.pop() ?? ''; blocks.forEach(consume);
      }
      buffer += decoder.decode();
      // An incomplete frame is replayed from the last applied ID, never applied partially.
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  },
};
