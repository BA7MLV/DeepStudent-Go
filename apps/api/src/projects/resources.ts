import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CloudRecords } from '../cloud/records.js';
import { ProjectError } from './files.js';
import { importBotAttachments } from './attachments.js';
import { safeFileName } from '../cloud/file-names.js';
import type { ProjectRepository } from './repository.js';
import type { ResourceDirectory, ResourceEntry } from '@wangke/contracts/resources';
import { RESOURCE_FOLDER_COLORS, type ResourceFolderColor } from '@wangke/contracts/resources';
import { extractMdUnits } from '@wangke/study-core/materials/markdown';
import { chunkUnits, countChars, judgeMaterialText } from '@wangke/study-core/materials/chunk';

type Placement = { owner_id: string; course_id: string; project_id: string; path: string; identity: string; revision: string; source_file: string | null };
type Folder = { folder_id: number; project_id: string; path: string };
const cleanName = (name: string) => name.replace(/[\\/\u0000-\u001f\u007f]/g, '_').replace(/^\.+$/, '_').slice(0, 70) || 'Untitled';
const join = (parent: string, name: string) => parent ? `${parent}/${name}` : name;
const formats: Record<string, string> = { md: 'md', markdown: 'md', pdf: 'pdf', docx: 'docx', html: 'html', htm: 'html' };
const video = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi', 'flv', 'ts', 'm2ts', 'mpeg', 'mpg', 'wmv', '3gp', 'rmvb', 'rm']);
const mime: Record<string, string> = { md: 'text/markdown', pdf: 'application/pdf', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', html: 'text/html' };
const videoExtension: Record<string, string> = { 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv' };
const learningTables = ['videos', 'files', 'segments', 'subtitleTracks', 'frames', 'handouts', 'chats', 'chatSessions', 'materialBlocks', 'materialInk', 'covers', 'comments', 'danmakus', 'cards', 'courseFiles'];

/** Files are authoritative; learning records are stable IDs and derived indexes.
 * Existing project directories/grants stay in place. Legacy blobs are copied once,
 * never hard-linked or removed, and are no longer used as live editable copies. */
export class ResourceFiles {
  readonly records: CloudRecords;
  constructor(readonly projects: ProjectRepository, readonly filesDir: string) {
    this.records = new CloudRecords(projects.store);
    projects.onChange = (owner, id) => {
      const folder = this.db.prepare("SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=? AND path='' ").get(owner, id) as { folder_id: number } | undefined;
      const row = folder && this.records.get(owner, 'folders', folder.folder_id);
      if (row) this.put(owner, 'folders', row.id, { ...row, name: projects.get(owner, id).name });
    };
  }
  private get db() { return this.projects.store.db; }
  private rows(owner: string, table: string): any[] {
    return (this.db.prepare('SELECT value FROM cloud_records WHERE owner_id=? AND table_name=? AND value IS NOT NULL').all(owner, table) as { value: string }[]).map(r => JSON.parse(r.value));
  }
  private put(owner: string, table: string, key: string | number, after: Record<string, any> | null) {
    const before = this.records.get(owner, table, key);
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const baseRevision = (this.db.prepare('SELECT revision FROM cloud_records WHERE owner_id=? AND table_name=? AND record_key=?').get(owner, table, JSON.stringify(key)) as { revision: number } | undefined)?.revision;
    this.records.apply(owner, [{ id: crypto.randomUUID(), table, key, before, after, baseRevision }]);
  }
  private next(owner: string, table: string) { return this.rows(owner, table).reduce((max, r) => Math.max(max, Number(r.id) || 0), 0) + 1; }
  private defaultAgent(owner: string) {
    return this.projects.defaultAgent(owner);
  }
  root(owner: string) {
    return this.projects.resourceRoot(owner);
  }
  listFolder(owner: string, folderId: number) {
    this.migrate(owner);
    const folder = this.folder(owner, folderId);
    if (!folder) throw new ProjectError('project_file_not_found', 404);
    return this.list(owner, folder.project_id, folder.path);
  }
  private folder(owner: string, id: number): Folder | undefined {
    return this.db.prepare('SELECT folder_id,project_id,path FROM resource_folders WHERE owner_id=? AND folder_id=?').get(owner, id) as Folder | undefined;
  }
  private folderId(owner: string, projectId: string, directory: string) {
    const existing = this.db.prepare('SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=? AND path=?').get(owner, projectId, directory) as { folder_id: number } | undefined;
    if (existing) return existing.folder_id;
    if (!directory && projectId === this.root(owner)) return undefined;
    const parent = directory ? this.folderId(owner, projectId, path.posix.dirname(directory) === '.' ? '' : path.posix.dirname(directory)) : undefined;
    const id = this.next(owner, 'folders');
    this.put(owner, 'folders', id, { id, name: directory ? path.posix.basename(directory) : this.projects.get(owner, projectId).name, parentId: parent, createdAt: Date.now() });
    this.db.prepare('INSERT INTO resource_folders(owner_id,folder_id,project_id,path) VALUES(?,?,?,?)').run(owner, id, projectId, directory);
    return id;
  }
  private unique(projectId: string, directory: string, name: string) {
    const names = new Set(this.projects.files.list(projectId, directory).map(f => f.name));
    const ext = path.posix.extname(name), stem = name.slice(0, name.length - ext.length);
    let candidate = name, n = 2;
    while (names.has(candidate)) candidate = `${stem} (${n++})${ext}`;
    return join(directory, candidate);
  }
  placement(owner: string, id: string): Placement | undefined {
    return this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND course_id=?').get(owner, id) as Placement | undefined;
  }
  private remember(owner: string, id: string, projectId: string, filename: string, source: string | null, preserveMetadata = false) {
    const opened = this.projects.files.open(projectId, filename);
    let identity: string;
    try { const stat = fs.fstatSync(opened.fd); identity = `${stat.dev}:${stat.ino}`; }
    finally { fs.closeSync(opened.fd); }
    this.db.prepare(`INSERT INTO resource_files(owner_id,course_id,project_id,path,identity,revision,source_file) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(owner_id,course_id) DO UPDATE SET project_id=excluded.project_id,path=excluded.path,identity=excluded.identity,revision=excluded.revision,source_file=excluded.source_file`)
      .run(owner, id, projectId, filename, identity, opened.revision, source);
    const previous = this.records.get(owner, 'courseFiles', id);
    const course = this.records.get(owner, 'videos', id);
    if (course && !preserveMetadata) this.put(owner, 'videos', id, { ...course, name: path.posix.basename(filename).replace(/\.[^.]+$/, ''),
      folderId: this.folderId(owner, projectId, path.posix.dirname(filename) === '.' ? '' : path.posix.dirname(filename)), size: opened.size });
    this.put(owner, 'courseFiles', id, { ...previous, id, resourceProjectId: projectId, resourcePath: filename, resourceRevision: opened.revision,
      mimeType: course?.mimeType ?? previous?.mimeType ?? 'application/octet-stream', size: opened.size });
    return opened.revision;
  }
  /** Lazy, resumable migration: no startup move, no deletion of original data. */
  migrate(owner: string) {
    const root = this.root(owner);
    // A legacy title/size is not a filesystem name/stat. Preserve those source
    // fields while materializing the explicit mapping; actual bytes and paths
    // live in courseFiles. In particular sanitizing or disambiguating a filename
    // must not rename the imported logical course on the next lazy migration.
    const imported = this.db.prepare("SELECT json_extract(result,'$.sourceMetadata') AS metadata FROM client_commands WHERE owner_id=? AND json_extract(result,'$.librarySource') IS NOT NULL LIMIT 1").get(owner) as { metadata: string | null } | undefined;
    const sourceMetadata = new Map<string, { id: string; name: string; folderId?: number }>((JSON.parse(imported?.metadata ?? '[]') as { id: string; name: string; folderId?: number }[]).map(row => [row.id, row]));
    const trashed = new Set((this.db.prepare('SELECT project_id FROM resource_trash WHERE owner_id=?').all(owner) as { project_id: string }[]).map(row => row.project_id));
    // Old clients remove courseFiles before marking the learning row deleted.
    // Consume that request once, using the last observed disk revision so a
    // concurrent Bot edit is never silently unlinked. Empty revision is a
    // tombstone, not a request to delete a future file at the same path.
    for (const mapped of this.db.prepare('SELECT * FROM resource_files WHERE owner_id=?').all(owner) as Placement[]) {
      if (trashed.has(mapped.project_id)) continue;
      const course = this.records.get(owner, 'videos', mapped.course_id);
      const reference = this.records.get(owner, 'courseFiles', mapped.course_id);
      if (course && !course.fileDeleted && reference) continue;
      if (mapped.revision) {
        this.projects.writable(owner, mapped.project_id); this.projects.assertIdle(mapped.project_id);
        try { this.projects.files.remove(mapped.project_id, mapped.path, mapped.revision); }
        catch (error) { if (!(error instanceof ProjectError) || error.status !== 404) throw error; }
      }
      this.put(owner, 'files', mapped.course_id, null);
      this.put(owner, 'courseFiles', mapped.course_id, null);
      if (course) {
        if (!course.fileDeleted) this.put(owner, 'videos', mapped.course_id, { ...course, fileDeleted: 1 });
        this.db.prepare("UPDATE resource_files SET revision='' WHERE owner_id=? AND course_id=?").run(owner, mapped.course_id);
      } else this.db.prepare('DELETE FROM resource_files WHERE owner_id=? AND course_id=?').run(owner, mapped.course_id);
    }
    const folders = new Map(this.rows(owner, 'folders').map(f => [f.id, f]));
    const visiting = new Set<number>();
    const locate = (id: number): Folder => {
      const folder = folders.get(id);
      if (!folder || visiting.has(id)) throw new ProjectError('invalid_resource_folder');
      visiting.add(id);
      const parent = folder.parentId != null && folders.has(folder.parentId) ? locate(folder.parentId) : null;
      const mapped = this.folder(owner, id);
      if (mapped) {
        if (!mapped.path) {
          // Permission scopes cannot be nested without silently changing grants.
          if (parent) throw new ProjectError('invalid_resource_folder');
          if (this.projects.get(owner, mapped.project_id).name !== folder.name) this.projects.update(owner, mapped.project_id, { name: folder.name });
        } else {
          const targetId = parent?.project_id ?? root;
          const target = join(parent?.path ?? '', path.posix.basename(mapped.path) === folder.name ? folder.name : cleanName(String(folder.name)));
          if (mapped.project_id !== targetId || mapped.path !== target) {
            this.move(owner, mapped.project_id, mapped.path, targetId, target, this.entry(mapped.project_id, mapped.path).revision);
            visiting.delete(id); return this.folder(owner, id)!;
          }
        }
        visiting.delete(id); return mapped;
      }
      // Root folders are permission/sandbox scopes; nested folders are plain directories.
      const location = parent ? { folder_id: id, project_id: parent.project_id, path: this.unique(parent.project_id, parent.path, cleanName(String(folder.name))) }
        : { folder_id: id, project_id: this.projects.create(owner, String(folder.name), this.defaultAgent(owner)).id, path: '' };
      if (parent) this.projects.files.mkdir(location.project_id, location.path);
      this.db.prepare('INSERT INTO resource_folders(owner_id,folder_id,project_id,path) VALUES(?,?,?,?)').run(owner, id, location.project_id, location.path);
      visiting.delete(id); return location;
    };
    for (const id of folders.keys()) {
      const mapped = this.folder(owner, id);
      if (!mapped || !trashed.has(mapped.project_id)) locate(id);
    }
    for (const course of this.rows(owner, 'videos')) {
      if (course.fileDeleted) continue;
      const original = sourceMetadata.get(course.id);
      const preserveMetadata = Boolean(original && original.name === course.name && original.folderId === course.folderId);
      let mapped = this.placement(owner, course.id);
      if (mapped && trashed.has(mapped.project_id)) continue;
      if (mapped && !preserveMetadata) {
        const parent = course.folderId != null ? this.folder(owner, course.folderId) : undefined;
        const targetId = parent?.project_id ?? root;
        const basename = path.posix.basename(mapped.path), title = basename.replace(/\.[^.]+$/, '');
        const name = course.name === title ? basename : cleanName(String(course.name)) + path.posix.extname(basename);
        const target = join(parent?.path ?? '', name);
        if (mapped.project_id !== targetId || mapped.path !== target) {
          this.move(owner, mapped.project_id, mapped.path, targetId, target, this.entry(mapped.project_id, mapped.path).revision);
          mapped = this.placement(owner, course.id);
        }
      }
      const edited = this.records.get(owner, 'files', course.id);
      const reference = this.records.get(owner, 'courseFiles', course.id);
      const sourceId = edited?.blob?.$file ?? (!mapped || !reference?.resourceProjectId ? reference?.fileId : undefined);
      if (!sourceId || mapped?.source_file === sourceId) {
        if (edited && sourceId && mapped?.source_file === sourceId) this.put(owner, 'files', course.id, null);
        continue;
      }
      const source = this.db.prepare('SELECT storage_name FROM files WHERE id=? AND owner_id=?').get(sourceId, owner) as { storage_name: string } | undefined;
      if (!source) continue;
      const sourcePath = path.resolve(this.filesDir, source.storage_name);
      if (path.dirname(sourcePath) !== path.resolve(this.filesDir) || !fs.existsSync(sourcePath)) continue;
      const location = mapped ? { project_id: mapped.project_id, path: path.posix.dirname(mapped.path) === '.' ? '' : path.posix.dirname(mapped.path) }
        : course.folderId != null ? this.folder(owner, course.folderId) : undefined;
      const projectId = location?.project_id ?? root;
      this.projects.writable(owner, projectId);
      this.projects.assertIdle(projectId);
      const originalExtension = path.extname(String(course.name)).toLowerCase();
      const extension = course.materialFormat ? `.${course.materialFormat}` : video.has(originalExtension.slice(1)) ? originalExtension
        : course.mimeType?.startsWith('video/') ? videoExtension[course.mimeType] ?? '.mp4' : '';
      const title = cleanName(String(course.name));
      const filename = mapped?.path ?? this.unique(projectId, location?.path ?? '', title.toLowerCase().endsWith(extension) ? title : title + extension);
      this.projects.files.copy(projectId, filename, sourcePath, mapped?.revision ?? null);
      this.remember(owner, course.id, projectId, filename, sourceId, preserveMetadata);
      if (edited) this.put(owner, 'files', course.id, null);
    }
    this.importChatAttachments(owner);
    importBotAttachments(this.projects, this.filesDir, owner);
  }
  /** Accepted chat uploads are library files even if generation later fails.
   * Draft uploads stay private. Receipts survive moves/deletion and prevent
   * retries, forks and lazy history scans from resurrecting existing copies. */
  private importChatAttachments(owner: string) {
    const sources = this.db.prepare(`
      SELECT DISTINCT f.id,f.storage_name,f.original_name,f.sha256,refs.session_id
      FROM (
        SELECT json_extract(c.value,'$.sessionId') session_id,json_extract(a.value,'$.serverId') file_id
        FROM cloud_records c,json_each(c.value,'$.attachments') a
        WHERE c.owner_id=? AND c.table_name='chats' AND json_extract(c.value,'$.role')='user'
        UNION
        SELECT json_extract(t.input,'$.sessionId'),json_extract(a.value,'$.serverId')
        FROM cloud_tasks t,json_each(t.input,'$.attachments') a
        WHERE t.owner_id=? AND t.kind='chat'
      ) refs JOIN files f ON f.id=refs.file_id AND f.owner_id=?
      JOIN cloud_records s ON s.owner_id=f.owner_id AND s.table_name='chatSessions' AND s.record_key=CAST(refs.session_id AS TEXT) AND s.value IS NOT NULL
      WHERE NOT EXISTS (SELECT 1 FROM chat_resource_attachments r WHERE r.owner_id=f.owner_id AND r.session_id=refs.session_id AND r.file_id=f.id AND r.status='done')
      ORDER BY refs.session_id,f.created_at,f.id
    `).all(owner, owner, owner) as { id: string; storage_name: string; original_name: string; sha256: string; session_id: number }[];
    for (const source of sources) {
      const original = path.resolve(this.filesDir, source.storage_name);
      if (path.dirname(original) !== path.resolve(this.filesDir) || !fs.existsSync(original)) continue;
      let binding = this.db.prepare(`SELECT f.* FROM chat_resource_sessions s LEFT JOIN resource_folders f
        ON f.owner_id=s.owner_id AND f.folder_id=s.folder_id WHERE s.owner_id=? AND s.session_id=?`).get(owner, source.session_id) as Folder | undefined;
      // A deleted/moved-to-trash grouping is the user's decision, not a request
      // to reconstruct it from the retained chat/task history.
      if (binding && !binding.project_id) continue;
      if (!binding) {
        let root = this.db.prepare('SELECT project_id FROM chat_resource_roots WHERE owner_id=?').get(owner) as { project_id: string } | undefined;
        if (!root) {
          const names = new Set(this.projects.list(owner).map(item => item.name));
          let name = '聊天附件', n = 2;
          while (names.has(name)) name = `聊天附件 (${n++})`;
          const project = this.projects.create(owner, name);
          this.db.prepare('INSERT INTO chat_resource_roots VALUES(?,?)').run(owner, project.id);
          root = { project_id: project.id };
        }
        if (!this.db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived=0 AND id NOT IN (SELECT project_id FROM resource_trash)').get(root.project_id, owner)) continue;
        this.projects.assertIdle(root.project_id);
        const session = this.records.get(owner, 'chatSessions', source.session_id);
        const first = this.db.prepare("SELECT json_extract(input,'$.text') text FROM cloud_tasks WHERE owner_id=? AND kind='chat' AND json_extract(input,'$.sessionId')=? ORDER BY created_at LIMIT 1").get(owner, source.session_id) as { text?: string } | undefined;
        const title = cleanName(String(session?.title && session.title !== '新会话' ? session.title : first?.text || '新会话')).slice(0, 40);
        const directory = this.unique(root.project_id, '', title);
        this.projects.files.mkdir(root.project_id, directory);
        const folderId = this.folderId(owner, root.project_id, directory)!;
        this.db.prepare('INSERT INTO chat_resource_sessions VALUES(?,?,?)').run(owner, source.session_id, folderId);
        binding = this.folder(owner, folderId)!;
      }
      if (!this.db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived=0 AND id NOT IN (SELECT project_id FROM resource_trash)').get(binding.project_id, owner)) continue;
      // Do not revive a directory removed outside the app either.
      try { this.projects.files.list(binding.project_id, binding.path); }
      catch (error) { if (error instanceof ProjectError && error.status === 404) continue; throw error; }
      this.projects.writable(owner, binding.project_id); this.projects.assertIdle(binding.project_id);
      let receipt = this.db.prepare('SELECT project_id,path,status FROM chat_resource_attachments WHERE owner_id=? AND session_id=? AND file_id=?')
        .get(owner, source.session_id, source.id) as { project_id: string; path: string; status: string } | undefined;
      const allocate = () => this.unique(binding!.project_id, binding!.path, safeFileName(source.original_name));
      if (!receipt) {
        receipt = { project_id: binding.project_id, path: allocate(), status: 'pending' };
        this.db.prepare("INSERT INTO chat_resource_attachments VALUES(?,?,?,?,?,'pending')").run(owner, source.session_id, source.id, receipt.project_id, receipt.path);
      }
      if (!this.db.prepare('SELECT 1 FROM projects WHERE id=? AND owner_id=? AND archived=0 AND id NOT IN (SELECT project_id FROM resource_trash)').get(receipt.project_id, owner)) continue;
      this.projects.writable(owner, receipt.project_id); this.projects.assertIdle(receipt.project_id);
      const parent = path.posix.dirname(receipt.path);
      const entry = this.projects.files.list(receipt.project_id, parent === '.' ? '' : parent).find(item => item.path === receipt!.path);
      let installed = false;
      if (entry?.kind === 'file') {
        const file = this.projects.files.open(receipt.project_id, receipt.path);
        try { installed = crypto.createHash('sha256').update(fs.readFileSync(file.fd)).digest('hex') === source.sha256; }
        finally { fs.closeSync(file.fd); }
      }
      if (entry && !installed) {
        receipt = { ...receipt, project_id: binding.project_id, path: allocate() };
        this.db.prepare('UPDATE chat_resource_attachments SET project_id=?,path=? WHERE owner_id=? AND session_id=? AND file_id=?').run(receipt.project_id, receipt.path, owner, source.session_id, source.id);
      }
      if (!installed) this.projects.files.copy(receipt.project_id, receipt.path, original);
      this.db.prepare("UPDATE chat_resource_attachments SET status='done' WHERE owner_id=? AND session_id=? AND file_id=?").run(owner, source.session_id, source.id);
    }
  }
  private entry(projectId: string, filename: string) {
    const parent = path.posix.dirname(filename) === '.' ? '' : path.posix.dirname(filename);
    const entry = this.projects.files.list(projectId, parent).find(f => f.path === filename);
    if (!entry) throw new ProjectError('project_file_not_found', 404);
    return entry;
  }

  trashList(owner: string) {
    return (this.db.prepare('SELECT project_id,deleted_at FROM resource_trash WHERE owner_id=? ORDER BY deleted_at DESC').all(owner) as { project_id: string; deleted_at: string }[])
      .map(row => ({ ...this.projects.get(owner, row.project_id, true), deletedAt: row.deleted_at }));
  }

  trash(owner: string, id: string) {
    const project = this.projects.get(owner, id);
    if (id === this.root(owner) || this.db.prepare('SELECT 1 FROM bot_workspaces WHERE project_id=?').get(id)) throw new ProjectError('protected_resource_folder', 409);
    this.projects.assertIdle(id);
    if (this.db.prepare("SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id WHERE t.project_id=? AND r.status IN ('queued','running','waiting_user','paused')").get(id)) throw new ProjectError('project_busy', 409);
    this.projects.store.transaction(() => {
      this.db.prepare('INSERT INTO resource_trash(project_id,owner_id,archived,deleted_at) VALUES(?,?,?,?)').run(id, owner, Number(project.archived), new Date().toISOString());
      this.db.prepare('UPDATE projects SET archived=1 WHERE id=?').run(id);
    });
  }

  restoreTrash(owner: string, id: string) {
    const row = this.db.prepare('SELECT archived FROM resource_trash WHERE owner_id=? AND project_id=?').get(owner, id) as { archived: number } | undefined;
    if (!row) throw new ProjectError('project_not_found', 404);
    this.projects.store.transaction(() => {
      this.db.prepare('UPDATE projects SET archived=0 WHERE id=?').run(id);
      this.db.prepare('DELETE FROM resource_trash WHERE owner_id=? AND project_id=?').run(owner, id);
    });
  }

  deleteTrash(owner: string, id: string) {
    if (!this.db.prepare('SELECT 1 FROM resource_trash WHERE owner_id=? AND project_id=?').get(owner, id)) throw new ProjectError('project_not_found', 404);
    this.projects.assertIdle(id);
    if (this.db.prepare("SELECT 1 FROM cloud_tasks c JOIN runs r ON r.id=c.parent_run_id JOIN threads t ON t.id=r.thread_id WHERE t.project_id=? AND c.status IN ('queued','running','waiting_user')").get(id)) throw new ProjectError('project_busy', 409);
    const courses = new Set((this.db.prepare('SELECT course_id FROM resource_files WHERE owner_id=? AND project_id=?').all(owner, id) as { course_id: string }[]).map(row => row.course_id));
    this.projects.files.removeWorkspace(id, () => this.projects.store.transaction(() => {
      for (const table of learningTables) for (const row of this.rows(owner, table)) {
        if (courses.has(row.id) || courses.has(row.videoId) || courses.has(row.materialId)) this.put(owner, table, table === 'covers' ? row.videoId : row.id, null);
      }
      for (const row of this.db.prepare('SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=?').all(owner, id) as { folder_id: number }[]) this.put(owner, 'folders', row.folder_id, null);
      for (const row of this.db.prepare('SELECT id FROM threads WHERE project_id=? AND owner_id=?').all(id, owner) as { id: string }[]) {
        const thread = row.id;
        this.db.prepare('DELETE FROM approvals WHERE thread_id=?').run(thread);
        this.db.prepare('DELETE FROM bot_operations WHERE step_id IN (SELECT id FROM run_steps WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?))').run(thread);
        this.db.prepare('UPDATE bot_requests SET run_id=NULL,step_id=NULL WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread);
        this.db.prepare('DELETE FROM bot_artifacts WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread);
        this.db.prepare('DELETE FROM bot_summaries WHERE run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread);
        this.db.prepare('DELETE FROM cloud_tasks WHERE parent_run_id IN (SELECT id FROM runs WHERE thread_id=?)').run(thread);
        this.db.prepare('DELETE FROM threads WHERE id=?').run(thread);
      }
      for (const table of ['resource_files', 'resource_folders', 'resource_attachments', 'resource_trash']) this.db.prepare(`DELETE FROM ${table} WHERE owner_id=? AND project_id=?`).run(owner, id);
      this.db.prepare('DELETE FROM projects WHERE owner_id=? AND id=?').run(owner, id);
    }));
  }
  private invalidate(owner: string, id: string) {
    for (const block of this.rows(owner, 'materialBlocks').filter(b => b.materialId === id)) this.put(owner, 'materialBlocks', block.id, null);
    this.put(owner, 'files', id, null);
    const row = this.records.get(owner, 'videos', id);
    if (row?.kind === 'material') this.put(owner, 'videos', id, { ...row, status: 'new', unitCount: undefined, lastUnit: undefined });
  }
  private index(owner: string, projectId: string, entry: ResourceEntry): ResourceEntry {
    if (entry.kind === 'directory') return { ...entry, ...this.folderMetadata(owner, projectId, entry.path) };
    const ext = path.extname(entry.name).slice(1).toLowerCase(), format = formats[ext];
    if (!format && !video.has(ext)) return entry;
    const identity = this.projects.files.identity(projectId, entry.path);
    // Inode identity follows external renames inside the same permission scope.
    const existing = this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=? AND (path=? OR identity=?) ORDER BY path=? DESC LIMIT 1').get(owner, projectId, entry.path, identity, entry.path) as Placement | undefined;
    const id = existing?.course_id ?? crypto.randomUUID();
    let current = this.records.get(owner, 'videos', id);
    if (existing && existing.revision !== entry.revision) this.invalidate(owner, id);
    if (existing && existing.revision !== entry.revision) current = this.records.get(owner, 'videos', id);
    const folderId = this.folderId(owner, projectId, path.posix.dirname(entry.path) === '.' ? '' : path.posix.dirname(entry.path));
    this.put(owner, 'videos', id, { ...current, id, fileDeleted: undefined, name: entry.name.replace(/\.[^.]+$/, ''), folderId, size: entry.size,
      mimeType: format ? mime[format] : current?.mimeType ?? `video/${ext}`, duration: current?.duration ?? 0,
      createdAt: current?.createdAt ?? Date.parse(entry.updatedAt), status: existing && existing.revision !== entry.revision && format ? 'new' : current?.status ?? 'new',
      ...(format ? { kind: 'material', materialFormat: format } : {}) });
    this.remember(owner, id, projectId, entry.path, existing?.source_file ?? null);
    return { ...entry, courseId: id };
  }
  list(owner: string, projectId?: string, directory = '', archived = false): ResourceDirectory {
    this.migrate(owner);
    const rootId = this.root(owner), id = projectId ?? rootId;
    const project = this.projects.get(owner, id);
    if (process.platform !== 'linux') this.projects.assertIdle(id);
    const entries = this.projects.files.list(id, directory).map(file => this.index(owner, id, { ...file, projectId: id }));
    for (const mapped of this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=?').all(owner, id) as Placement[]) {
      const parent = path.posix.dirname(mapped.path) === '.' ? '' : path.posix.dirname(mapped.path);
      if (parent !== directory || entries.some(entry => entry.courseId === mapped.course_id || entry.path === mapped.path)) continue;
      const course = this.records.get(owner, 'videos', mapped.course_id);
      if (course) entries.push({ name: path.posix.basename(mapped.path), path: mapped.path, projectId: id, kind: 'file', size: course.size ?? 0,
        updatedAt: new Date(course.createdAt || 0).toISOString(), revision: '', courseId: mapped.course_id, missing: true });
    }
    if (!projectId) {
      for (const scope of this.projects.list(owner).filter(p => p.id !== rootId && (archived || !p.archived))) {
        entries.push({ name: scope.name, path: '', projectId: scope.id, kind: 'directory', size: 0, updatedAt: scope.updatedAt, revision: scope.updatedAt, scope, ...this.folderMetadata(owner, scope.id, '') });
      }
      // Remote/subtitle-only courses remain reachable; no fake empty files are made.
      for (const course of this.rows(owner, 'videos').filter(c => !this.placement(owner, c.id))) {
        entries.push({ name: course.name, path: '', projectId: rootId, kind: 'file', size: course.size ?? 0, updatedAt: new Date(course.createdAt || 0).toISOString(), revision: '', courseId: course.id, missing: true });
      }
    }
    return { project: projectId ? project : null, rootId, path: directory, folderId: this.folderId(owner, id, directory), entries };
  }
  private folderMetadata(owner: string, projectId: string, directory: string) {
    const folderId = this.folderId(owner, projectId, directory);
    const color = folderId == null ? undefined : this.records.get(owner, 'folders', folderId)?.color as ResourceFolderColor | undefined;
    return { folderId, color };
  }
  setFolderColor(owner: string, projectId: string, directory: string, color: ResourceFolderColor) {
    if (!RESOURCE_FOLDER_COLORS.includes(color)) throw new ProjectError('invalid_folder_color');
    this.projects.writable(owner, projectId);
    this.projects.assertIdle(projectId);
    if (directory && this.entry(projectId, directory).kind !== 'directory') throw new ProjectError('invalid_resource_folder');
    const { folderId } = this.folderMetadata(owner, projectId, directory);
    if (folderId == null) throw new ProjectError('invalid_resource_folder');
    const folder = this.records.get(owner, 'folders', folderId)!;
    this.put(owner, 'folders', folderId, { ...folder, color });
    return { folderId, color };
  }
  course(owner: string, id: string) {
    this.migrate(owner);
    const mapped = this.placement(owner, id);
    if (!mapped) throw new ProjectError('project_file_not_found', 404);
    this.projects.get(owner, mapped.project_id);
    if (process.platform !== 'linux') this.projects.assertIdle(mapped.project_id);
    const parent = path.posix.dirname(mapped.path) === '.' ? '' : path.posix.dirname(mapped.path);
    const file = this.projects.files.list(mapped.project_id, parent).find(f => f.path === mapped.path);
    if (!file) throw new ProjectError('project_file_not_found', 404);
    this.index(owner, mapped.project_id, { ...file, projectId: mapped.project_id });
    return mapped;
  }
  /** Playback is read-only: no migration, indexing or directory scans per seek. */
  openCourse(owner: string, id: string) {
    const course = this.records.get(owner, 'videos', id);
    const reference = this.records.get(owner, 'courseFiles', id);
    if (!course || course.fileDeleted || !reference) throw new ProjectError('project_file_not_found', 404);
    const mapped = this.placement(owner, id);
    if (mapped) {
      this.projects.get(owner, mapped.project_id);
      if (process.platform !== 'linux') this.projects.assertIdle(mapped.project_id);
      return { ...this.projects.files.open(mapped.project_id, mapped.path), mimeType: course.mimeType ?? reference.mimeType ?? 'application/octet-stream' };
    }
    // Old uploads can play before the resource library has migrated them. Never
    // fall back to the backup after a mapped resource is removed from disk.
    const edited = this.records.get(owner, 'files', id);
    const sourceId = edited?.blob?.$file ?? reference.fileId;
    const source = this.db.prepare('SELECT storage_name,mime_type FROM files WHERE id=? AND owner_id=?').get(sourceId ?? '', owner) as { storage_name: string; mime_type: string } | undefined;
    if (!source) throw new ProjectError('project_file_not_found', 404);
    const filename = path.resolve(this.filesDir, source.storage_name);
    if (path.dirname(filename) !== path.resolve(this.filesDir)) throw new ProjectError('project_file_not_found', 404);
    let fd: number;
    try { fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
    catch (error) {
      if (['ENOENT', 'ELOOP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new ProjectError('project_file_not_found', 404);
      throw error;
    }
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1) { fs.closeSync(fd); throw new ProjectError('project_path_denied', 403); }
    return { fd, size: stat.size, revision: `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`, mimeType: source.mime_type };
  }
  saveText(owner: string, id: string, text: string, expected: string) {
    const mapped = this.course(owner, id);
    this.projects.writable(owner, mapped.project_id); this.projects.assertIdle(mapped.project_id);
    const current = this.projects.files.read(mapped.project_id, mapped.path);
    if (typeof expected !== 'string' || current.text !== expected) throw new ProjectError('project_file_conflict', 409);
    this.projects.files.write(mapped.project_id, mapped.path, text, current.revision);
    this.invalidate(owner, id);
    return { revision: this.remember(owner, id, mapped.project_id, mapped.path, mapped.source_file) };
  }
  /** Application Markdown is a real resource, including the wrongbook. The
   * caller supplies original text, never rows or a replacement course object. */
  saveMarkdown(owner: string, input: { courseId: string; text: string; expected: string; name?: string; folderId?: number; createOnly?: boolean }) {
    const { courseId: id, text, expected } = input;
    if (!id || id.length > 200 || typeof text !== 'string' || text.length > 2000000 || typeof expected !== 'string') throw new ProjectError('invalid_markdown');
    this.migrate(owner);
    const course = this.records.get(owner, 'videos', id);
    if (course && (course.kind !== 'material' || course.materialFormat !== 'md' || course.fileDeleted)) throw new ProjectError('invalid_markdown_course');
    let mapped = this.placement(owner, id);
    if (input.createOnly && course) throw new ProjectError('project_file_conflict', 409);
    if (mapped) this.saveText(owner, id, text, expected);
    else {
      // Existing unmapped bytes cannot be replaced under a guessed empty CAS.
      if (course || expected !== '') throw new ProjectError('project_file_conflict', 409);
      const folder = input.folderId === undefined ? undefined : this.folder(owner, input.folderId);
      if (input.folderId !== undefined && !folder) throw new ProjectError('project_file_not_found', 404);
      const projectId = folder?.project_id ?? this.root(owner);
      this.projects.writable(owner, projectId); this.projects.assertIdle(projectId);
      const filename = this.unique(projectId, folder?.path ?? '', `${cleanName(input.name ?? id).replace(/\.md$/i, '')}.md`);
      this.projects.files.write(projectId, filename, text, null);
      this.put(owner, 'videos', id, { id, name: input.name ?? id, kind: 'material', materialFormat: 'md', mimeType: 'text/markdown', duration: 0, size: Buffer.byteLength(text), createdAt: Date.now(), status: 'transcribed', coverState: 'pending' });
      this.remember(owner, id, projectId, filename, null);
      mapped = this.placement(owner, id)!;
    }
    const blocks = chunkUnits(extractMdUnits(text), 'para');
    const totalChars = countChars(blocks), unitCount = new Set(blocks.map(block => block.unit)).size;
    const { scanned, empty } = judgeMaterialText('md', totalChars, unitCount);
    this.projects.store.transaction(() => {
      for (const block of this.rows(owner, 'materialBlocks').filter(row => row.materialId === id)) this.put(owner, 'materialBlocks', block.id, null);
      let next = this.next(owner, 'materialBlocks');
      for (const block of blocks) { const key = next++; this.put(owner, 'materialBlocks', key, { ...block, id: key, materialId: id }); }
      const current = this.records.get(owner, 'videos', id)!;
      const after: Record<string, any> = { ...current, unitCount, status: 'transcribed' };
      delete after.scanned; delete after.empty;
      if (scanned) after.scanned = 1;
      if (empty) after.empty = 1;
      this.put(owner, 'videos', id, after);
    });
    return { unitCount, blockCount: blocks.length, totalChars, scanned, empty };
  }
  /** Preflight the whole selection, then one index transaction. Roll back file
   * renames on a synchronous failure. Process death/external rollback conflicts
   * remain an admitted uncertain batch: never split or auto-replay it. */
  moveSelection(owner: string, placements: { key: string; parent: number | null; target: number | null }[]) {
    if (!placements.length || placements.length > 10000 || new Set(placements.map(item => item.key)).size !== placements.length) throw new ProjectError('invalid_resource_selection');
    this.migrate(owner);
    const root = this.root(owner);
    const moves = placements.map(item => {
      const folder = item.key.startsWith('folder:') ? this.folder(owner, Number(item.key.slice(7))) : undefined;
      const file = item.key.startsWith('file:') ? this.placement(owner, item.key.slice(5)) : undefined;
      const source = folder ?? file;
      if (!source || !source.path) throw new ProjectError('protected_resource_folder', 409);
      const record = folder ? this.records.get(owner, 'folders', folder.folder_id) : this.records.get(owner, 'videos', item.key.slice(5));
      const parent = folder ? record?.parentId : record?.folderId;
      if ((parent ?? null) !== item.parent) throw new ProjectError('project_file_conflict', 409);
      const target = item.target == null ? undefined : this.folder(owner, item.target);
      if (item.target != null && !target) throw new ProjectError('project_file_not_found', 404);
      const targetId = target?.project_id ?? root, destination = join(target?.path ?? '', path.posix.basename(source.path));
      this.projects.writable(owner, source.project_id); this.projects.writable(owner, targetId);
      this.projects.assertIdle(source.project_id); this.projects.assertIdle(targetId);
      if (source.project_id === targetId && (destination === source.path || destination.startsWith(`${source.path}/`))) throw new ProjectError('invalid_resource_move');
      const entry = this.entry(source.project_id, source.path);
      if (this.projects.files.list(targetId, target?.path ?? '').some(entry => entry.path === destination)) throw new ProjectError('project_file_exists', 409);
      return { sourceId: source.project_id, source: source.path, targetId, destination, revision: entry.revision, placement: item };
    }).filter((move, _index, all) => !all.some(parent => parent !== move && parent.sourceId === move.sourceId && move.source.startsWith(`${parent.source}/`)));
    const destinations = moves.map(move => `${move.targetId}:${move.destination}`);
    if (new Set(destinations).size !== destinations.length) throw new ProjectError('project_file_exists', 409);
    const completed: typeof moves = [];
    try {
      this.projects.store.transaction(() => {
        for (const move of moves) this.move(owner, move.sourceId, move.source, move.targetId, move.destination, move.revision, () => completed.push(move));
      });
    } catch (error) {
      for (const move of completed.reverse()) {
        const current = this.entry(move.targetId, move.destination);
        this.projects.files.move(move.targetId, move.destination, move.sourceId, move.source, current.revision);
      }
      throw error;
    }
    return moves.map(move => move.placement);
  }
  organizeCourses(owner: string, folders: { name: string; courseIds: string[] }[]) {
    if (folders.length > 1000 || folders.some(folder => !folder.name.trim() || cleanName(folder.name) !== folder.name || folder.courseIds.length > 10000)) throw new ProjectError('invalid_folder_plan');
    this.migrate(owner);
    const root = this.root(owner), result = { createdFolders: [] as string[], moved: 0, missing: [] as string[], perFolder: [] as { name: string; count: number }[] };
    const moves = new Map<string, { key: string; parent: number | null; target: number | null }>();
    const missing = new Set<string>();
    const created: string[] = [];
    this.projects.writable(owner, root); this.projects.assertIdle(root);
    try {
      return this.projects.store.transaction(() => {
      for (const folder of folders) {
        if (!folder.courseIds.length) continue;
        let entry = this.list(owner).entries.find(entry => entry.kind === 'directory' && entry.name === folder.name);
        if (!entry) {
          this.projects.files.mkdir(root, folder.name); created.push(folder.name);
          entry = this.list(owner).entries.find(entry => entry.kind === 'directory' && entry.name === folder.name)!;
          result.createdFolders.push(folder.name);
        }
        let count = 0;
        for (const id of folder.courseIds) {
          const row = this.records.get(owner, 'videos', id);
          if (!row || row.fileDeleted || !this.placement(owner, id)) { missing.add(id); continue; }
          count++;
          moves.set(id, { key: `file:${id}`, parent: row.folderId ?? null, target: entry.folderId ?? null });
        }
        result.perFolder.push({ name: folder.name, count });
      }
      const changed = [...moves.values()].filter(move => move.parent !== move.target);
      if (changed.length) this.moveSelection(owner, changed);
      result.moved = moves.size; result.missing = [...missing];
      return result;
      });
    } catch (error) {
      for (const directory of created.reverse()) {
        if (this.projects.files.list(root, directory).length) continue;
        this.projects.files.remove(root, directory, this.entry(root, directory).revision);
      }
      throw error;
    }
  }
  /** Delete a resource and its learning records as one Resource Library action. */
  remove(owner: string, projectId: string, filename: string, expected: string) {
    this.migrate(owner);
    this.projects.writable(owner, projectId); this.projects.assertIdle(projectId);
    const placement = this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=? AND path=?').get(owner, projectId, filename) as Placement | undefined;
    const courseId = placement?.course_id;
    const mutations: Array<{ id: string; table: string; key: string | number; before: Record<string, any>; after: null }> = [];
    if (courseId) {
      for (const table of learningTables) {
        for (const row of this.rows(owner, table)) {
          const matches = table === 'materialInk'
            ? row.materialId === courseId
            : row.id === courseId || row.videoId === courseId || row.materialId === courseId;
          if (!matches) continue;
          const key = table === 'covers' ? row.videoId : row.id;
          if (typeof key !== 'string' && typeof key !== 'number') continue;
          mutations.push({ id: crypto.randomUUID(), table, key, before: row, after: null });
        }
      }
    }
    // Validate and remove the authoritative file first. A conflict leaves all learning records intact.
    this.projects.files.remove(projectId, filename, expected);
    if (mutations.length) this.records.apply(owner, mutations);
    if (courseId) this.db.prepare('DELETE FROM resource_files WHERE owner_id=? AND course_id=?').run(owner, courseId);
  }
  move(owner: string, id: string, filename: string, targetId: string, target: string, revision: string, moved: () => void = () => {}) {
    this.projects.writable(owner, id); this.projects.writable(owner, targetId);
    this.projects.assertIdle(id); this.projects.assertIdle(targetId);
    const placements = this.db.prepare('SELECT * FROM resource_files WHERE owner_id=? AND project_id=?').all(owner, id) as Placement[];
    const folders = this.db.prepare('SELECT folder_id,project_id,path FROM resource_folders WHERE owner_id=? AND project_id=?').all(owner, id) as Folder[];
    // Tombstoned learning paths still have stable identities. Detect collisions
    // before changing the filesystem, not halfway through updating the index.
    for (const row of placements.filter(row => row.path === filename || row.path.startsWith(`${filename}/`))) {
      const existing = this.db.prepare('SELECT course_id FROM resource_files WHERE owner_id=? AND project_id=? AND path=?').get(owner, targetId, target + row.path.slice(filename.length)) as { course_id: string } | undefined;
      if (existing && existing.course_id !== row.course_id) throw new ProjectError('project_file_exists', 409);
    }
    for (const folder of folders.filter(folder => folder.path === filename || folder.path.startsWith(`${filename}/`))) {
      const existing = this.db.prepare('SELECT folder_id FROM resource_folders WHERE owner_id=? AND project_id=? AND path=?').get(owner, targetId, target + folder.path.slice(filename.length)) as { folder_id: number } | undefined;
      if (existing && existing.folder_id !== folder.folder_id) throw new ProjectError('project_file_exists', 409);
    }
    this.projects.files.move(id, filename, targetId, target, revision);
    moved();
    this.projects.store.transaction(() => {
      for (const folder of folders) {
        if (folder.path === filename || folder.path.startsWith(`${filename}/`)) this.db.prepare('UPDATE resource_folders SET project_id=?,path=? WHERE owner_id=? AND folder_id=?').run(targetId, target + folder.path.slice(filename.length), owner, folder.folder_id);
      }
      // Keep compatibility indexes pointing at the moved directory, never a second tree.
      for (const folder of this.db.prepare('SELECT folder_id,project_id,path FROM resource_folders WHERE owner_id=? AND project_id=?').all(owner, targetId) as Folder[]) {
        if (folder.path !== target && !folder.path.startsWith(`${target}/`)) continue;
        const row = this.records.get(owner, 'folders', folder.folder_id);
        if (row) this.put(owner, 'folders', folder.folder_id, { ...row, name: path.posix.basename(folder.path),
          parentId: this.folderId(owner, targetId, path.posix.dirname(folder.path) === '.' ? '' : path.posix.dirname(folder.path)) });
      }
      for (const row of placements) {
        if (row.path === filename || row.path.startsWith(`${filename}/`)) this.remember(owner, row.course_id, targetId, target + row.path.slice(filename.length), row.source_file);
      }
    });
  }
}
