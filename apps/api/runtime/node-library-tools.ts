/** 课程内部检索与资料库检索的执行器。
 * 从 runtime/node.ts 原样搬出:作用域拒绝码、截断提示与行排序都不改,
 * 因为客户端按这些字符串展示"课程不在范围"等结论。 */
import { fmtTime } from '@wangke/study-core/text/vtt';
import { lexicalSearch } from '@wangke/study-core/search';
import { folderCourseScope } from '@wangke/study-core/folder-scope';
import type { ToolDef } from '@wangke/study-core/model/client';
import type { TaskContext } from '../src/cloud/execution.js';
import { editNodeDocument, readNodeDocument, readRawCourse } from './node-documents.js';
import { materialKindOf, materialRows, rowsFor, transcriptRows, unitText } from './node-course-access.js';
export { rowsFor, materialKindOf };
import { RESOURCE_READ_TOOL, LIST_COURSES_TOOL, SEARCH_LIBRARY_TOOL, COURSE_DETAILS_TOOL } from './node-tool-defs.js';
import { NODE_ASK_TOOL, NODE_EDIT_TOOL } from './node-course-access.js';

export function qaExecutor(context: TaskContext, videoId: string, kind: 'page' | 'para' | undefined) {
  return async (name: string, args: Record<string, unknown>) => {
    if (name === 'edit') return editNodeDocument(context, args);
    if (name === 'read') {
      const system = readNodeDocument(context, args);
      if (system !== null) return system;
      if (typeof args.path === 'string' && ![`/courses/${encodeURIComponent(videoId)}/material`, `/courses/${encodeURIComponent(videoId)}/transcript`, '/courses/current/material', '/courses/current/transcript'].includes(args.path)) throw new Error('course_outside_task_scope');
      if (args.raw === true) {
        if (args.path !== `/courses/${encodeURIComponent(videoId)}/material` && args.path !== '/courses/current/material') throw new Error('course_outside_task_scope');
        return readRawCourse(context, args, videoId);
      }
    }
    if (name === 'grep') {
      const query = String(args.query ?? '').trim();
      if (!query) return '请提供检索关键词。';
      if (kind) {
        const hits = lexicalSearch(materialRows(context, videoId), row => String(row.text), query, 8);
        return hits.length ? hits.map(hit => `${unitText(hit.doc, kind)}\npath=/courses/${encodeURIComponent(videoId)}/material`).join('\n') : '未检索到相关材料内容。';
      }
      const hits = lexicalSearch(transcriptRows(context, videoId), row => String(row.text), query, 8);
      return hits.length ? hits.map(hit => `[${fmtTime(Number(hit.doc.start))}] ${hit.doc.text}\npath=/courses/${encodeURIComponent(videoId)}/transcript`).join('\n') : '未检索到相关字幕内容。';
    }
    if (name === 'read') {
      if (kind) {
        const from = Math.max(1, Math.floor(Number(args.start ?? 1)));
        const rawTo = Math.max(from, Math.floor(Number(args.end ?? from + 1)));
        const to = Math.min(rawTo, from + 19);
        const rows = materialRows(context, videoId).filter(row => Number(row.unit) >= from && Number(row.unit) <= to);
        return rows.length ? `${rows.map(row => unitText(row, kind)).join('\n')}${rawTo > to ? '\n（读取范围已截断。）' : ''}` : '该材料范围内没有内容。';
      }
      const start = Number(args.start ?? 0);
      const end = Number(args.end ?? start + 60);
      const rows = transcriptRows(context, videoId).filter(row => Number(row.end) >= start && Number(row.start) <= end);
      return rows.length ? rows.map(row => `[${fmtTime(Number(row.start))}] ${row.text}`).join('\n') : '该时间范围内没有字幕内容。';
    }
    if (name === 'search_transcript') {
      if (kind) return '当前课程是阅读材料，没有视频字幕。';
      const query = String(args.query ?? '').trim();
      if (!query) return '请提供检索关键词。';
      const rows = transcriptRows(context, videoId);
      const hits = lexicalSearch(rows, row => String(row.text), query, 8);
      return hits.length ? hits.map(hit => `[${fmtTime(Number(hit.doc.start))}] ${hit.doc.text}`).join('\n') : '未检索到相关字幕内容。';
    }
    if (name === 'get_transcript_range') {
      if (kind) return '当前课程是阅读材料，没有视频字幕。';
      const start = Number(args.start);
      const end = Number(args.end ?? start + 60);
      if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return '时间范围无效。';
      const rows = transcriptRows(context, videoId).filter(row => Number(row.end) >= start && Number(row.start) <= end);
      return rows.length ? rows.map(row => `[${fmtTime(Number(row.start))}] ${row.text}`).join('\n') : '该时间范围内没有字幕内容。';
    }
    if (name === 'search_material') {
      if (!kind) return '当前课程是视频课程，没有阅读材料正文。';
      const query = String(args.query ?? '').trim();
      if (!query) return '请提供检索关键词。';
      const hits = lexicalSearch(materialRows(context, videoId), row => String(row.text), query, 8);
      return hits.length ? hits.map(hit => unitText(hit.doc, kind)).join('\n') : '未检索到相关材料内容。';
    }
    if (name === 'get_material_range') {
      if (!kind) return '当前课程是视频课程，没有阅读材料正文。';
      const from = Math.max(1, Math.floor(Number(args.from) || 1));
      const rawTo = Math.max(from, Math.floor(Number(args.to) || from + 1));
      const to = Math.min(rawTo, from + 19);
      const rows = materialRows(context, videoId).filter(row => Number(row.unit) >= from && Number(row.unit) <= to);
      if (!rows.length) return `第 ${from}~${to}${kind === 'page' ? '页' : '段'}没有内容。`;
      return `${rows.map(row => unitText(row, kind)).join('\n')}${rawTo > to ? `\n（一次最多读取 20 个${kind === 'page' ? '页' : '段'}，已截断。）` : ''}`;
    }
    throw new Error('tool_not_available');
  };
}

export function courseProgress(row: Record<string, any>) {
  if (row.finished === 1) return '已学完';
  if (row.kind === 'material') return row.lastUnit ? `读到第${row.lastUnit}${row.materialFormat === 'pdf' ? '页' : '段'}` : '尚未开始';
  if (row.lastPosition) return `已学到 ${fmtTime(Number(row.lastPosition))}`;
  return '尚未开始';
}

export function libraryExecutor(context: TaskContext, session: Record<string, any> | null, courseReference = true) {
  const contextIds = new Set<string>((Array.isArray(session?.contextCourseIds) ? session.contextCourseIds : []).filter((id): id is string => typeof id === 'string' && id.length > 0));
  const referenceDenied = '本会话已关闭课程引用，课程内容不可用；请基于通用知识回答。';
  return async (name: string, args: Record<string, unknown>) => {
    const courses = rowsFor(context, 'videos');
    const projectScope = folderCourseScope(rowsFor(context, 'folders'), courses as Array<{ id: string; folderId?: number }>, session?.projectFolderId);
    const inSessionScope = (id: string) => !contextIds.size || contextIds.has(id);
    const inProjectScope = (id: string) => !projectScope || projectScope.has(id);
    if (name === 'edit') {
      if (!courseReference && typeof args.path === 'string' && args.path.startsWith('/courses/')) return referenceDenied;
      return editNodeDocument(context, args);
    }
    if (name === 'read') {
      const system = readNodeDocument(context, args);
      if (system !== null) return system;
      const match = typeof args.path === 'string' && /^\/courses\/([^/]+)\/(material|transcript)$/.exec(args.path);
      if (match) {
        if (!courseReference) return referenceDenied;
        const id = decodeURIComponent(match[1]);
        if (!inProjectScope(id)) throw new Error('course_outside_project_scope');
        if (!inSessionScope(id)) throw new Error('course_outside_session_scope');
        const course = courses.find(course => course.id === id);
        if (!course) throw new Error('course_not_found');
        if (args.raw === true) return readRawCourse(context, args, id);
        return qaExecutor(context, id, materialKindOf(course))('read', args);
      }
    }
    if (name === 'list_courses') {
      if (!courseReference) return referenceDenied;
      const status = String(args.status ?? 'all');
      const kind = String(args.kind ?? 'all');
      const limit = Math.min(50, Math.max(1, Number(args.limit) || 20));
      const filtered = courses.filter(row => {
        const id = String(row.id);
        const resourceKind = row.kind === 'material' ? 'material' : 'video';
        const state = row.finished === 1 ? 'completed' : (row.lastPosition || row.lastUnit) ? 'in_progress' : 'unstarted';
        return inProjectScope(id) && inSessionScope(id) && (kind === 'all' || kind === resourceKind) && (status === 'all' || status === state);
      });
      return filtered.length ? filtered.slice(0, limit).map(row => `- 《${String(row.name)}》 · ${row.kind === 'material' ? `阅读材料 ${String(row.materialFormat ?? '').toUpperCase()}` : '视频课程'} · ${courseProgress(row)} · courseId=${row.id}`).join('\n') : '没有符合筛选条件的课程。';
    }
    if (name === 'search_course_library') {
      if (!courseReference) return referenceDenied;
      const query = String(args.query ?? '').trim();
      if (!query) return '请提供检索关键词。';
      const requested = typeof args.courseId === 'string' && args.courseId ? args.courseId : '';
      if (requested && (!inProjectScope(requested) || !inSessionScope(requested))) return '当前会话课程范围内没有该 courseId。';
      const defaultScope = contextIds.size ? contextIds : projectScope;
      const allowed = requested ? new Set([requested]) : args.scope === 'all' && !contextIds.size ? null : defaultScope;
      const courseMap = new Map(courses.map(row => [String(row.id), row]));
      const docs: Array<Record<string, any>> = [];
      for (const row of rowsFor(context, 'segments')) {
        if (row.status !== 1 || !row.text || (allowed && !allowed.has(String(row.videoId)))) continue;
        const course = courseMap.get(String(row.videoId));
        if (course) docs.push({ ...row, _course: course, _location: fmtTime(Number(row.start)), _kind: 'video' });
      }
      for (const row of rowsFor(context, 'materialBlocks')) {
        if (!row.text || (allowed && !allowed.has(String(row.materialId)))) continue;
        const course = courseMap.get(String(row.materialId));
        if (course) docs.push({ ...row, _course: course, _location: row.unitLabel ?? `第${row.unit}段`, _kind: 'material' });
      }
      const limit = Math.min(15, Math.max(1, Number(args.limit) || 8));
      const hits = lexicalSearch(docs, row => String(row.text), query, limit);
      return hits.length ? hits.map(hit => {
        const row = hit.doc; const course = row._course;
        return `[${course.name} · ${row._location}] ${row.text} · courseId=${course.id}`;
      }).join('\n') : '资料库中没有检索到相关内容。';
    }
    if (name === 'get_course_details') {
      if (!courseReference) return referenceDenied;
      const id = String(args.courseId ?? '');
      if (!inProjectScope(id) || !inSessionScope(id)) return '当前会话课程范围内没有该 courseId。';
      const course = courses.find(row => String(row.id) === id);
      if (!course) return '没有找到该 courseId。';
      const count = (table: string, field: string) => rowsFor(context, table).filter(row => String(row[field]) === id).length;
      return [`课程：${course.name}`, `类型：${course.kind === 'material' ? `阅读材料 ${course.materialFormat ?? ''}` : '视频课程'}`, `进度：${courseProgress(course)}`, `字幕段数：${count('segments', 'videoId')}`, `材料块数：${count('materialBlocks', 'materialId')}`, `卡片数：${count('cards', 'videoId')}`].join('\n');
    }
    throw new Error('tool_not_available');
  };
}


export function libraryTools(hasCourses: boolean): ToolDef[] {
  return [RESOURCE_READ_TOOL, NODE_ASK_TOOL, NODE_EDIT_TOOL, ...(hasCourses ? [LIST_COURSES_TOOL, SEARCH_LIBRARY_TOOL, COURSE_DETAILS_TOOL] : [])];
}
