import type { TaskStatus } from './task-status.js';
/** JSON is the wire boundary of sandbox-owned state, never arbitrary JS objects. */
export type RuntimeJson = null | boolean | number | string | RuntimeJson[] | { [key: string]: RuntimeJson };
/** A process group followed by its delivered text. String offsets are UTF-16;
 * toolOffset indexes the cumulative tool trace. Anchors are append-only. */
export type ResponseSegment = {
  contentOffset: number;
  reasoningOffset: number;
  toolOffset: number;
  startedAt?: number;
};
export type RuntimeRead =
  | { kind: 'preferences' }
  | { kind: 'permissions' }
  | { kind: 'resources'; projectId?: string; folderId?: number; path: string; archived: boolean; cursor?: string; limit?: number }
  | { kind: 'resourceTrash' }
  | { kind: 'courseDocument'; courseId: string }
  | { kind: 'systemDocument'; path: string }
  | { kind: 'systemDirectory'; path: string; offset: number; query: string }
  | { kind: 'executorRecovery'; taskId?: string; operationIds: string[] }
  | { kind: 'interactionRecovery'; taskId: string; sequence: number }
  | { kind: 'catalog' }
  | { kind: 'pluginScope'; materialId?: string; projectFolderId?: number }
  | { kind: 'tasks' }
  | { kind: 'records'; after: number }
  | { kind: 'recordHead' }
  | { kind: 'recordKeys'; keys: { table: ProjectionTable; key: string | number }[] }
  | { kind: 'collectionPage'; table: ProjectionTable; parent?: string | number; cursor?: string }
  | { kind: 'sessionIndex'; videoId: string; archived: boolean; recentOnly: boolean; cursor?: string }
  | { kind: 'courseCount' }
  | { kind: 'courseReadiness'; videoId: string }
  | { kind: 'courseMetadata'; ids: string[]; covers: boolean }
  | { kind: 'coverCandidates'; cursor?: string }
  | { kind: 'courseColorFrame'; videoId: string }
  | { kind: 'latestHandout'; videoId: string }
  | { kind: 'skillIndex'; cursor?: string }
  | { kind: 'studySummary' }
  | { kind: 'studyOverview'; today: string; from: string; preview: { date: string; seconds: number }[] }
  | { kind: 'fileIntents' }
  | { kind: 'session'; sessionId: number; before?: { createdAt: number; id: number; role?: string }; after?: { createdAt: number; id: number; role?: string } }
  | { kind: 'plugin'; pluginId: string; instanceId: string; revision: number; method: string; args: { [key: string]: RuntimeJson } }
  | { kind: 'pluginQueries'; pluginId: string; instanceId: string; revision: number; queries: { key: string; method: string; args: { [key: string]: RuntimeJson } }[] }
  | { kind: 'task'; taskId: string };
export interface RuntimeSnapshot {
  type: 'snapshot';
  revision: number;
  value: RuntimeJson;
}
export interface RuntimePatch { path: string[]; value?: RuntimeJson; remove?: boolean }
export type RuntimeFrame = RuntimeSnapshot | { type: 'delta'; baseRevision: number; revision: number; changes: RuntimePatch[] };
/** Durable task facts; arbitrary executor payloads are JSON, never JS objects. */
export type RuntimeTask = {
  frozenModel?: import('./model-gateway.js').FrozenTaskModel;
  source?: { kind: 'app' | 'bot'; name?: string };
  resourceName?: string;
  executor?: 'node' | 'browser';
  id: string;
  kind: 'chat' | 'qa' | 'transcribe' | 'handout' | 'cards' | 'comments' | 'danmaku' | 'material' | 'cover' | 'artifactEdit' | 'handoutEdit' | 'modelOnce' | 'bilibiliImport';
  resource: string;
   status: TaskStatus;
  input: { [key: string]: RuntimeJson };
  progress: { [key: string]: RuntimeJson } | null;
  result: RuntimeJson;
  error: string | null;
  createdAt: string;
  /**
   * Terminal-only receipt of the record versions this task's committed
   * mutations touched, so the client can reconcile exactly those keys instead
   * of a global records cycle. Absent on pre-protocol servers, non-terminal
   * tasks, or when a task's effects exceeded the server's cap (fall back to a
   * full sync); an empty array means the task wrote no records at all.
   */
  effects?: { table: string; key: string | number; revision: number }[];
};
export type RuntimeTaskFrame = { type: 'snapshot'; revision: number; value: RuntimeTask } | Exclude<RuntimeFrame, RuntimeSnapshot>;
export type RuntimeTasksFrame = { type: 'snapshot'; revision: number; value: { tasks: RuntimeTask[] } } | Exclude<RuntimeFrame, RuntimeSnapshot>;
export interface RuntimeCommand {
  target?: 'method' | 'action';
  operationId: string;
  pluginId: string;
  instanceId: string;
  revision: number;
  method: string;
  args: { [key: string]: RuntimeJson };
}
/** Missing is not permission to repeat a side effect under a new operation id. */
export type RuntimeReceipt = (
  | { status: 'missing' }
  | { status: 'pending' }
  | { status: 'uncertain'; code: string }
  | { status: 'completed'; value: RuntimeJson }
  | { status: 'failed'; code: string }) & { resourceScope?: string };

export interface RuntimeFileIntent {
  id: string; path: string; content: string | null; expected: string | null; observed: string | null; current: string | null;
  status: 'pending' | 'applied' | 'conflict' | 'superseded' | 'discarded';
  createdAt: string; completedAt: string | null; successorId: string | null;
}
export type RuntimeFileIntentsFrame = { type: 'snapshot'; revision: number; value: { intents: { id: string; path: string; createdAt: string }[] } } | Exclude<RuntimeFrame, RuntimeSnapshot>;
/** Global event IDs are ordered, not contiguous within one authorized thread. */
export type BotJournalFrame =
  | { type: 'ready'; cursor: number }
  | { type: 'event'; cursor: number; event: import('./index.js').SseEvent };

/** Bounded durable cache changes. Cursor advances only after the sink commits. */
export interface RuntimeRecord {
  table: string;
  key: string | number;
  value: { [key: string]: RuntimeJson } | null;
  revision: number;
}
export interface RuntimeRecordsPage { records: RuntimeRecord[]; cursor: number; more: boolean; epoch: string; highWater: number; reset: boolean }
/** Independent, opaque collection cursors; never interchangeable with recordsPage. */
export type ProjectionTable = 'videos' | 'files' | 'segments' | 'frames' | 'handouts' | 'chats' | 'chatSessions'
  | 'skills' | 'skillRefs' | 'danmakus' | 'folders' | 'cards' | 'subtitleTracks' | 'materialBlocks'
  | 'materialInk' | 'covers' | 'studyDays' | 'courseFiles' | 'comments';
export interface CollectionPage {
  records: RuntimeRecord[];
  next?: string;
  version: number;
  epoch: string;
}
/** Head identity a complete multi-page read was verified against. */
export interface CollectionVersion { table: ProjectionTable; version: number; epoch: string }
/** Discovery only. Never publish these partial values as skillDefinition rows. */
export type SkillIndexItem = Omit<LearningSkill, 'body'> & { legacyIds?: number[]; legacyNames?: string[]; refCount: number };
export interface SkillIndexPage {
  skills: SkillIndexItem[]; next?: string; version: number; epoch: string;
}
/** Aggregate only; snapshot is an owner/epoch/version-bound clear precondition. */
export interface StudySummary { totalSeconds: number; activeDays: number; snapshot: string }
/** Explicit-ID display metadata, not complete video/cover records or write baselines. */
export interface CourseMetadata {
  items: { id: string; course: { name: string; kind: 'video' | 'material' } | null;
    cover: { blob: LearningBlob; source: LearningCover['source'] } | null }[];
  epoch: string;
}
/** Bounded backfill keys only; never a course listing or cover bodies. */
export interface CoverCandidates { ids: string[]; next?: string; version: number; epoch: string }
/** One complete selected document, never a scan of every historic version. */
export interface LatestHandout {
  record: RuntimeRecord | null; epoch: string;
  media: { courseName: string; frames: { ts: number; blob: LearningBlob }[] };
}
export interface StudyOverview {
  /** Only the requested calendar interval (<=371 days), never full history. */
  days: { date: string; seconds: number }[];
  /** Includes the explicitly supplied, non-persisted local timer preview. */
  stats: { totalSeconds: number; activeDays: number; todaySeconds: number; weekSeconds: number; weekActiveDays: number;
    currentStreak: number; longestStreak: number; best: { date: string; seconds: number } | null; averageSeconds: number };
}
export interface SessionIndexItem {
  id: number; videoId: string; title: string; pinned: boolean; archived: boolean;
  createdAt: number; activity: number; hasUser: boolean;
}
export interface SessionIndexPage {
  latestId?: number;
  sessions: SessionIndexItem[]; next?: string; previous?: string; version: number; epoch: string;
}
export interface RuntimeRecordMutation {
  id: string;
  table: string;
  key: string | number;
  before: { [key: string]: RuntimeJson } | null;
  after: { [key: string]: RuntimeJson } | null;
  baseRevision?: number;
}
export interface RuntimeRecordsCommit { operationId: string; mutations: RuntimeRecordMutation[] }
/** Account-scoped invalidation metadata, never a replay cursor or a record feed. */
export interface RuntimeRecordHead { epoch: string; version: number }
export interface RuntimeRecordsReceipt { epoch?: string; accepted: string[]; versions: { table: string; key: string | number; revision: number }[] }
/** Local cache adapter input only; never a server write protocol. */
export type ExecutorArtifactChange = RuntimeRecordMutation & { permissionId?: string };
export interface LearningBlob { $file: string; type?: string }
export interface LearningSegment { id: number; videoId: string; idx: number; start: number; end: number; text: string; status: 0 | 1; cues?: { start: number; end: number; text: string }[] }
export interface LearningTrack { id: number; videoId: string; lang: string; lanDoc: string; primary?: 0 | 1; cues: { start: number; end: number; text: string }[] }
export interface LearningBlock { id: number; materialId: string; idx: number; unit: number; unitLabel: string; text: string; kind: 'body' | 'title' | 'table' | 'caption' }
export interface LearningFrame { id: number; videoId: string; ts: number; blob: LearningBlob; kind: 'slide' | 'other'; caption?: string }
export interface LearningCover { videoId: string; blob: LearningBlob; w: number; h: number; ts: number; source: 'user' | 'slide' | 'auto' | 'material-page' | 'material-title'; createdAt: number }
export interface LearningHandout { id: number; videoId: string; createdAt: number; title: string; blob: LearningBlob; outlineJson: string; sectionsJson?: string; usedSkills?: string[]; readPos?: { anchor: string; offset: number } }
export interface LearningCard { id: number; videoId: string; q: string; a: string; time: number; status: 0 | 1 | 2; createdAt: number }
export interface LearningComment { id: number; videoId: string; time: number; author: string; role: 'ask' | 'answer' | 'note'; text: string; parentId?: number; createdAt: number }
export interface LearningDanmaku { id: number; videoId: string; time: number; text: string }
export interface LearningCourseState { status?: 'new' | 'transcribing' | 'transcribed' | 'error'; transcriptionPaused?: boolean; unitCount?: number; scanned?: 1; empty?: 1; coverState?: 'pending' | 'done' | 'skipped'; dominantColor?: string }
export interface LearningSession { id: number; videoId: string; title: string; createdAt: number; contextCourseIds?: string[]; courseReferenceEnabled?: boolean; webSearchEnabled?: boolean; projectFolderId?: number; skillIds?: number[]; pinnedSkillIds?: number[]; mcpServerIds?: string[]; pinned?: boolean; archived?: boolean; promptCacheKey?: string; contextCheckpoint?: { fromId: number; source: string; prefixHash?: string }; contextOmissions?: [number, string][]; defaultModel?: import('./cloud.js').TaskModelSelection | null }
export interface LearningMessage { id: number; taskId?: string; videoId: string; sessionId: number; role: 'user' | 'assistant'; content: string; createdAt: number; modelTrace?: RuntimeJson; modelRequests?: RuntimeJson[]; explicitSkillIds?: number[]; images?: RuntimeJson[]; attachments?: RuntimeJson[]; reasoning?: string; reasoningMs?: number; tools?: RuntimeJson[]; responseSegments?: ResponseSegment[]; quiz?: RuntimeJson; ask?: RuntimeJson; folderPlan?: RuntimeJson; resume?: RuntimeJson; interrupted?: boolean; interruptReason?: string; widget?: RuntimeJson; widgets?: RuntimeJson[]; legacyHtmlWorks?: RuntimeJson[]; widgetState?: RuntimeJson; widgetStates?: RuntimeJson }
/** Closed product schemas: no table selector, resource identity/file/folder
 * writes, account preferences, or permit-based escape into arbitrary records. */
export type LearningProduct =
  | { kind: 'conversationMessage'; expected: LearningMessage | null; value: LearningMessage | null }
  | { kind: 'conversationSession'; expected: LearningSession | null; value: LearningSession | null }
  | { kind: 'transcriptSegment'; expected: LearningSegment | null; value: LearningSegment | null }
  | { kind: 'subtitleTrack'; expected: LearningTrack | null; value: LearningTrack | null }
  | { kind: 'materialBlock'; expected: LearningBlock | null; value: LearningBlock | null }
  | { kind: 'slideFrame'; expected: LearningFrame | null; value: LearningFrame | null }
  | { kind: 'courseCover'; expected: LearningCover | null; value: LearningCover | null }
  | { kind: 'handoutDocument'; expected: LearningHandout | null; value: LearningHandout | null }
  | { kind: 'candidateCard'; expected: LearningCard | null; value: LearningCard | null }
  | { kind: 'courseComment'; expected: LearningComment | null; value: LearningComment | null }
  | { kind: 'courseDanmaku'; expected: LearningDanmaku | null; value: LearningDanmaku | null }
  | { kind: 'courseDerivation'; courseId: string; expected: LearningCourseState; value: LearningCourseState };
export type LearningProductCommand = LearningProduct & { mutationId: string; permissionId?: string; baseRevision?: number };
export interface LearningSkill { id: number; name: string; description: string; body: string; enabled: 0 | 1; builtin: 0 | 1; updatedAt: number; mcpRequired?: string[] }
export interface LearningSkillReference { id: number; skillId: number; path: string; body: string }
export interface LearningInk { id: string; materialId: string; surface: string; tool: 'pen' | 'highlight'; color: string; width: number; height: number; points: { x: number; y: number; pressure: number }[]; createdAt: number; renderer?: 'freehand-v1'; nib?: 'pressure' | 'ballpoint' | 'brush'; opacity?: number; smoothing?: number; input?: 'touch' | 'pen' | 'mouse'; anchor?: { start: number; end: number; exact: string; prefix: string; suffix: string; unit: number; endUnit?: number; unitLabel: string; source: 'pdf' | 'docx' | 'md' | 'html' }; rects?: { x: number; y: number; w: number; h: number }[] }
export type ClientLearningEdit = (
  | Extract<LearningProduct, { kind: 'conversationMessage' | 'conversationSession' | 'handoutDocument' }>
  | { kind: 'skillDefinition'; expected: LearningSkill | null; value: LearningSkill | null; referencesSnapshot?: { epoch: string; version: number } }
  | { kind: 'skillReference'; expected: LearningSkillReference | null; value: LearningSkillReference | null }
  | { kind: 'materialAnnotation'; expected: LearningInk | null; value: LearningInk | null }
  | { kind: 'reviewCard'; courseId: string; cardId: number; expected: 0 | 1 | 2; status: 0 | 1 | 2 }
  | { kind: 'handoutReading'; courseId: string; handoutId: number; position: { anchor: string; offset: number } }
  | { kind: 'studyTime'; date: string; seconds: number; updatedAt: number }
  | { kind: 'clearStudyTime'; expected: { date: string; seconds: number; updatedAt: number }[] }
  | { kind: 'clearStudySnapshot'; snapshot: string }
) & { mutationId: string; baseRevision?: number };
export interface ClientLearningCommand { operationId: string; edits: ClientLearningEdit[] }
export interface ExecutorResourceCommand {
  taskId: string;
  operationId: string;
  permissionId: string;
  operation: Extract<import('./resources.js').ResourceOperation, { kind: 'saveMarkdown' | 'organizeCourses' }>;
}
export type RuntimeSessionRow = {
  id: number;
  sessionId: number;
  createdAt: number;
  role: string;
  content: string;
  taskId?: string;
  data: { [key: string]: RuntimeJson };
}
export type RuntimeSessionProjection = {
  session: { [key: string]: RuntimeJson };
  rows: RuntimeSessionRow[];
  hasOlder: boolean;
  tasks: RuntimeTask[];
}
export type RuntimeSessionFrame = { type: 'snapshot'; revision: number; value: RuntimeSessionProjection } | Exclude<RuntimeFrame, RuntimeSnapshot>;

/** Rows are journal facts, not a latest-window projection. Cursor is committed
 * only after the consumer applies a complete baseline or event batch. */
export type SessionJournalRequest = { sessionId: number; after?: number };
export type SessionJournalFrame =
  | { type: 'resync-required'; cursor: number; reason: 'cursor-expired' | 'journal-gap' }
  | { type: 'baseline'; cursor: number; session: { [key: string]: RuntimeJson }; tasks: RuntimeTask[]; hasOlder: boolean }
  | { type: 'rows'; cursor: number; rows: RuntimeSessionRow[] }
  | { type: 'ready'; cursor: number }
  | { type: 'events'; baseCursor: number; cursor: number; events: { cursor: number; rowId: number; row: RuntimeSessionRow | null }[]; session: { [key: string]: RuntimeJson }; tasks: RuntimeTask[] };
export interface RuntimeTaskSubmit {
  operationId: string;
  kind: RuntimeTask['kind'];
  resource: string;
  input: { [key: string]: RuntimeJson };
}
/** Commands share one durable backend across Chat, Bot and IM. IDs are exact, never display names. */
export type DelegationCommand =
  | { action: 'bot.default'; threadId: string; expected: import('./model-gateway.js').TaskModelSelection | null; value: import('./model-gateway.js').TaskModelSelection | null }
  | { action: 'bot.read'; threadId: string }
  | { action: 'models'; query?: string }
  | { action: 'create'; operationId: string; parentTaskId?: string; parentRunId?: string; goal: string; constraints: string[]; completionCriteria: string[]; context: { source: string; version: string; text: string }[]; modelSelection?: import('./model-gateway.js').TaskModelSelection; dependsOn?: string[]; background?: boolean }
  | { action: 'read' | 'cancel' | 'promote'; taskId: string }
  | { action: 'session.create'; operationId: string; title: string; defaultModel?: import('./model-gateway.js').TaskModelSelection; sourceSessionId?: number; sourceMessageId?: number; originTaskId?: string; originRunId?: string }
  | { action: 'session.read'; sessionId: number }
  | { action: 'session.default'; sessionId: number; expected: import('./model-gateway.js').TaskModelSelection | null; value: import('./model-gateway.js').TaskModelSelection | null }
  | { action: 'session.send'; operationId: string; sessionId: number; text: string; modelSelection?: import('./model-gateway.js').TaskModelSelection; parentTaskId?: string; parentRunId?: string; background?: boolean };
export type RuntimeTaskAdmission = { status: 'missing' } | { status: 'accepted'; task: RuntimeTask };

export type PreferenceKey = 'contextWindow' | 'asrConcurrency' | 'thinkingEnabled' | 'thinkingEffort' | 'captionScale'
  | 'agentRounds' | 'agentInstructions' | 'danmakuEnabled' | 'customRates' | 'shortcuts' | 'theme' | 'uiLanguage' | 'accentColor' | 'fontScale'
  | 'dynamicColor' | 'studyTrackingEnabled' | 'studyIdleMinutes' | 'htmlRemoteAssets' | 'favorites' | 'savedModels' | 'userName';
export interface PreferencesCommand {
  operationId: string;
  changes: { key: PreferenceKey; value: RuntimeJson; expected: RuntimeJson }[];
}
export interface PreferencesProjection { values: { [key: string]: RuntimeJson } }
