/** 课程资料的只读访问原语:行过滤、单元文本与 QA 工具集。
 * 从 runtime/node.ts 原样搬出;资料行来自同步记录,字段读取沿用原来的 Number/String 归一。 */
import type { ToolDef } from '@wangke/study-core/model/client';
import { taskRows, type TaskContext } from '../src/cloud/execution.js';
import { RESOURCE_GREP_TOOL, RESOURCE_READ_TOOL } from './node-tool-defs.js';
import { clip } from './node-common.js';
export { clip };

export function rowsFor(context: TaskContext, table: string) {
  return taskRows(context, table);
}

export function videoFor(context: TaskContext, id: string) {
  return context.records.get(context.owner, 'videos', id);
}

export function materialKindOf(video: Record<string, any> | null): 'page' | 'para' | undefined {
  if (video?.kind !== 'material') return undefined;
  return video.materialFormat === 'pdf' ? 'page' : 'para';
}

export function unitText(row: Record<string, any>, kind: 'page' | 'para') {
  return `[第${Number(row.unit)}${kind === 'page' ? '页' : '段'}] ${String(row.text ?? '')}`;
}

export function transcriptRows(context: TaskContext, videoId: string) {
  return rowsFor(context, 'segments')
    .filter(row => row.videoId === videoId && row.status === 1 && typeof row.text === 'string' && row.text)
    .sort((a, b) => Number(a.idx ?? 0) - Number(b.idx ?? 0));
}

export function materialRows(context: TaskContext, videoId: string) {
  return rowsFor(context, 'materialBlocks')
    .filter(row => row.materialId === videoId && typeof row.text === 'string' && row.text)
    .sort((a, b) => Number(a.idx ?? 0) - Number(b.idx ?? 0));
}

export function qaTools(kind: 'page' | 'para' | undefined): ToolDef[] {
  // These names match the prompt and the browser-side resource contract. The
  // server executor below resolves them from CloudRecords instead of Dexie.
  return [RESOURCE_GREP_TOOL, RESOURCE_READ_TOOL, NODE_EDIT_TOOL, NODE_ASK_TOOL];
}

export const NODE_ASK_TOOL: ToolDef = { type: 'function', function: { name: 'ask_user', description: '向用户提出一个需要回答的问题，等待回答后继续。', parameters: { type: 'object', properties: { question: { type: 'string' }, type: { type: 'string', enum: ['single', 'multiple', 'text', 'confirm'] }, options: { type: 'array', items: { type: 'string' } } }, required: ['question'] } } };
export const NODE_EDIT_TOOL: ToolDef = { type: 'function', function: {
  name: 'edit', description: '按唯一原文修改已有 /courses/<courseId>/material Markdown，课程写入遵守一次审批及原文 CAS，单课程 QA 仅可编辑当前课程（可用 current）。也可编辑 /system/AGENTS.md、具名记忆、已有技能及看板实体文档；系统新建/修改免常规审批，但显式 deny 保留。系统修改先 read 并带 revision；create=true + content 可初始化空文档或新建具名记忆，不能覆盖已有非空内容。禁止 MCP 配置、任意路径、删除或 shell。不支持 regex。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    path: { type: 'string' }, revision: { type: 'integer', minimum: 0 }, create: { type: 'boolean' }, content: { type: 'string', maxLength: 100000 },
    edits: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object', additionalProperties: false, properties: { old_string: { type: 'string', minLength: 1, maxLength: 100000 }, new_string: { type: 'string', maxLength: 100000 }, replace_all: { type: 'boolean' } }, required: ['old_string', 'new_string'] } },
  }, required: ['path'] },
} };

