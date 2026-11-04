import type { LearningSegment, LearningTrack, LearningBlock, LearningFrame, LearningCover, LearningHandout, LearningCard, LearningComment, LearningDanmaku, LearningSession, LearningMessage, LearningSkill, LearningSkillReference, LearningInk, LearningBlob } from './client-runtime.js';
import type { RuntimeJson } from './client-runtime.js';

/** Reject unknown legacy fields before the projecting wire codec can drop them.
 * The full source archive remains exportable for explicit manual conversion. */
export const LIBRARY_IMPORT_FIELDS = {
  courses: 'id name size mimeType duration createdAt status transcriptionPaused biliSource lastPosition finished fileDeleted pinned skillOverride folderId kind materialFormat unitCount lastUnit scanned empty htmlView dominantColor coverState',
  folders: 'id name createdAt parentId color', files: 'id blob',
  segments: 'id videoId idx start end text status cues', tracks: 'id videoId lang lanDoc primary cues',
  blocks: 'id materialId idx unit unitLabel text kind', frames: 'id videoId ts blob kind caption',
  covers: 'videoId blob w h ts source createdAt', handouts: 'id videoId createdAt title blob outlineJson sectionsJson usedSkills readPos',
  cards: 'id videoId q a time status createdAt', comments: 'id videoId time author role text parentId createdAt', danmakus: 'id videoId time text',
  sessions: 'id videoId title createdAt contextCourseIds projectFolderId skillIds pinnedSkillIds mcpServerIds pinned archived promptCacheKey contextCheckpoint contextOmissions',
  messages: 'id taskId videoId sessionId role content createdAt modelTrace modelRequests explicitSkillIds images attachments reasoning reasoningMs tools responseSegments quiz ask folderPlan resume interrupted interruptReason widget widgets legacyHtmlWorks widgetState widgetStates',
  skills: 'id name description body enabled builtin updatedAt mcpRequired', references: 'id skillId path body',
  annotations: 'id materialId surface tool color width height points createdAt renderer nib opacity smoothing input anchor rects', studyDays: 'date seconds updatedAt',
} as const;

/** One explicit, create-only legacy library snapshot. No mutations, tombstones,
 * permits, table names or server placement/grant fields are accepted. IDs are
 * preserved, including references inside historical messages. */
export interface LibraryImport {
  sourceId: string;
  courses: {
    id: string; name: string; size: number; mimeType: string; duration: number; createdAt: number;
    status: 'new' | 'transcribing' | 'transcribed' | 'error'; transcriptionPaused?: boolean;
    biliSource?: { bvid: string; aid: number; cid: number; page: number };
    lastPosition?: number; finished?: 0 | 1; fileDeleted?: 1; pinned?: 0 | 1;
    skillOverride?: { pin: number[]; drop: number[] }; folderId?: number;
    kind?: 'video' | 'material'; materialFormat?: 'pdf' | 'docx' | 'md' | 'html';
    unitCount?: number; lastUnit?: number; scanned?: 1; empty?: 1; htmlView?: 'raw' | 'blocks';
    dominantColor?: string; coverState?: 'pending' | 'done' | 'skipped';
  }[];
  folders: { id: number; name: string; createdAt: number; parentId?: number; color?: 'blue' | 'green' | 'yellow' | 'orange' | 'red' | 'purple' | 'gray' }[];
  files: { id: string; blob: LearningBlob }[];
  /** Explicit byte mapping, never permission to use a client-provided path.
   * Destination is create-only; source metadata is inert audit data. */
  fileMappings?: { courseId: string; expected: null; sourceReference: RuntimeJson; blob: LearningBlob; sha256: string; size: number; contentType: string }[];
  segments: LearningSegment[];
  tracks: LearningTrack[];
  blocks: LearningBlock[];
  frames: LearningFrame[];
  covers: LearningCover[];
  handouts: LearningHandout[];
  cards: LearningCard[];
  comments: LearningComment[];
  danmakus: LearningDanmaku[];
  sessions: LearningSession[];
  messages: LearningMessage[];
  skills: LearningSkill[];
  references: LearningSkillReference[];
  annotations: LearningInk[];
  studyDays: { date: string; seconds: number; updatedAt: number }[];
}
