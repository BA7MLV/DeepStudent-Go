import type { ProjectDto, ProjectFileDto } from './projects.js';
export type { LibraryImport } from './library-import.js';
export { LIBRARY_IMPORT_FIELDS } from './library-import.js';

export const RESOURCE_FOLDER_COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'gray'] as const;
export type ResourceFolderColor = (typeof RESOURCE_FOLDER_COLORS)[number];

/** A real file/directory. Project IDs remain internal, stable permission scopes. */
export interface ResourceEntry extends ProjectFileDto {
  projectId: string;
  courseId?: string;
  scope?: ProjectDto;
  missing?: boolean;
  folderId?: number;
  color?: ResourceFolderColor;
}
export interface ResourceDirectory {
  project: ProjectDto | null;
  rootId: string;
  path: string;
  folderId?: number;
  entries: ResourceEntry[];
  /** Forward cursor of a paged listing; absent when every entry is included.
   * A cursor is only valid for the same directory contents; the projection
   * replaces the whole page on change, so stale cursors never mix snapshots. */
  next?: string;
}

/** Explicit filesystem operations, not table mutations. */
export type ResourceOperation =
  | { kind: 'importLibraryBlob'; sourceId: string; size: number; sha256: string; contentType: string }
  | { kind: 'importLibrary'; library: import('./library-import.js').LibraryImport }
  | { kind: 'createFolder'; name: string }
  | { kind: 'createDirectory'; projectId: string; path: string }
  | { kind: 'upload'; projectId: string; path: string; size: number; sha256: string; contentType: string }
  | { kind: 'recordMediaDuration'; courseId: string; duration: number }
  | { kind: 'recordPlayback'; courseId: string; position: number; finished?: boolean }
  | { kind: 'recordReadingPosition'; courseId: string; unit: number }
  | { kind: 'setReadingView'; courseId: string; view: 'raw' | 'blocks' }
  | { kind: 'setCourseSkills'; courseId: string; pin: number[]; drop: number[] }
  | { kind: 'setCoursePinned'; courseId: string; pinned: boolean }
  | { kind: 'pauseTranscription'; courseId: string }
  | { kind: 'setVideoSource'; courseId: string; source: { bvid: string; aid: number; cid: number; page: number } }
  | { kind: 'importSubtitles'; courseId: string; primary: boolean; segments: { idx: number; start: number; end: number; text: string; status: 0 | 1; cues?: { start: number; end: number; text: string }[] }[]; tracks: { lang: string; lanDoc: string; primary?: 0 | 1; cues: { start: number; end: number; text: string }[] }[] }
  | { kind: 'renameFolder'; projectId: string; name: string }
  | { kind: 'folderColor'; projectId: string; path: string; color: ResourceFolderColor }
  | { kind: 'move'; projectId: string; path: string; targetProjectId: string; target: string; revision: string }
  | { kind: 'remove'; projectId: string; path: string; revision: string }
  | { kind: 'trash' | 'restore' | 'deleteTrash'; projectId: string }
  | { kind: 'saveCourseText'; courseId: string; text: string; expected: string }
  | { kind: 'saveMarkdown'; courseId: string; text: string; expected: string; name?: string; folderId?: number; createOnly?: boolean }
  | { kind: 'organizeCourses'; folders: { name: string; courseIds: string[] }[] }
  | { kind: 'moveLibrarySelection'; placements: { key: string; parent: number | null; target: number | null }[] }
  | { kind: 'saveProjectText'; projectId: string; path: string; text: string; expectedRevision: string | null };
export interface ResourceCommand {
  operationId: string; operation: ResourceOperation;
  /** Persisted database identity: a restored/reset account must not receive an
   * old browser's queued destructive operations. Absent on legacy commands. */
  scope?: string;
  /** Monotonic per browser stream, shared by its tabs. Progress is replacement
   * state (not an increment); delayed older updates must not rewind it. */
  delivery?: { stream: string; sequence: number };
}
