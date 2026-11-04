import type { ExecutorResourceCommand } from '@wangke/contracts/client-runtime';
import { CloudRecords } from '../cloud/records.js';

/** Bind a tool approval to the concrete semantic effect, not merely 'write'. */
export function taskFilePermit(records: CloudRecords, owner: string, taskInput: string, operation: ExecutorResourceCommand['operation'], serialized: string) {
  const permit = JSON.parse(serialized), input = JSON.parse(taskInput);
  if (operation.kind === 'organizeCourses') return permit.tool === 'apply_folder_plan' && JSON.stringify(permit.plan?.folders) === JSON.stringify(operation.folders);
  if (!['edit', 'edit_markdown'].includes(permit.tool)) return false;
  const args = permit.arguments ?? {};
  const row = records.get(owner, 'videos', operation.courseId);
  let creationName: string | undefined, creationFolder: number | undefined;
  let approved = false;
  if (permit.tool === 'edit_markdown') approved = input.videoId === operation.courseId;
  else if (typeof args.path === 'string') {
    let path: string;
    try { path = decodeURIComponent(args.path); } catch { return false; }
    const match = /^\/courses\/([^/]+)\/(material|handout\.md|questions\.md)$/.exec(path);
    if (match) {
      const courseId = match[1] === 'current' ? input.videoId : match[1];
      const id = match[2] === 'material' ? courseId : `${match[2] === 'handout.md' ? '__course_handout__' : '__course_questions__'}${encodeURIComponent(courseId)}`;
      approved = id === operation.courseId;
      if (match[2] !== 'material') {
        const source = records.get(owner, 'videos', courseId);
        if (!source || source.fileDeleted) return false;
        creationFolder = source.folderId;
        creationName = `${source.name.replace(/\.(?:mp4|webm|mkv|mov|pdf|docx|md|html?)$/i, '')} · ${match[2] === 'handout.md' ? '讲义' : '题库'}.md`;
      }
    } else {
      approved = path === `/${operation.courseId}` || !!row && [row.name, `${row.name}.md`].some(name => path === `/${name}`);
      creationName = path.slice(1);
    }
  }
  if (!approved) return false;
  if (args.create === true) return operation.createOnly === true && operation.expected === '' && args.content === operation.text
    && operation.folderId === creationFolder && (operation.name === undefined || operation.name === creationName);
  if (!Array.isArray(args.edits) || !args.edits.length) return false;
  const changes: { start: number; end: number; text: string }[] = [];
  for (const edit of args.edits) {
    if (!edit || typeof edit !== 'object' || Array.isArray(edit)) return false;
    if (typeof edit.old_string !== 'string' || !edit.old_string || typeof edit.new_string !== 'string') return false;
    const hits: { start: number; end: number }[] = [];
    if (edit.regex === true) {
      if (edit.old_string.length > 1000 || typeof (edit.flags ?? 'm') !== 'string' || !/^[imsu]*$/.test(edit.flags ?? 'm')) return false;
      let re: RegExp;
      try { re = new RegExp(edit.old_string, `${edit.flags ?? 'm'}g`); } catch { return false; }
      for (const match of operation.expected.matchAll(re)) { if (!match[0]) return false; hits.push({ start: match.index!, end: match.index! + match[0].length }); }
    } else {
      for (let start = operation.expected.indexOf(edit.old_string); start >= 0; start = operation.expected.indexOf(edit.old_string, start + edit.old_string.length)) hits.push({ start, end: start + edit.old_string.length });
    }
    // Exact edits use planAgentEdits' strict boolean; regex edits retain the
    // existing editMarkdownText protocol's truthy replace_all semantics.
    const replaceAll = edit.regex === true ? !!edit.replace_all : edit.replace_all === true;
    if (!hits.length || !replaceAll && hits.length !== 1) return false;
    changes.push(...hits.map(hit => ({ ...hit, text: edit.new_string })));
  }
  changes.sort((a, b) => a.start - b.start);
  if (changes.some((change, i) => i > 0 && change.start < changes[i - 1].end)) return false;
  let text = operation.expected;
  for (const change of changes.reverse()) text = text.slice(0, change.start) + change.text + text.slice(change.end);
  return text === operation.text;
}
