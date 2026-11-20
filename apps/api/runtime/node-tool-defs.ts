/** 服务端资料库/课程工具 schema。从 runtime/node.ts 原样搬出:
 * 名称、描述与参数上限同时约束浏览器端契约与服务端校验,不做改写。 */
import type { ToolDef } from '@wangke/study-core/model/client';

export const SEARCH_TRANSCRIPT_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'search_transcript',
    description: '在当前视频课程字幕中按关键词检索相关片段，传关键词或短语，不要传整句问题。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};
export const GET_TRANSCRIPT_RANGE_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'get_transcript_range',
    description: '获取当前视频指定时间范围内的字幕原文，start/end 单位为秒。',
    parameters: { type: 'object', properties: { start: { type: 'number' }, end: { type: 'number' } }, required: ['start', 'end'] },
  },
};
export const SEARCH_MATERIAL_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'search_material',
    description: '在当前阅读材料中按关键词检索相关正文，传关键词或短语，不要传整句问题。',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
};
export const GET_MATERIAL_RANGE_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'get_material_range',
    description: '获取当前阅读材料指定页码或段落范围内的原文，from/to 为闭区间。',
    parameters: { type: 'object', properties: { from: { type: 'number' }, to: { type: 'number' } }, required: ['from'] },
  },
};
export const RESOURCE_GREP_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'grep',
    description: '在当前课程的字幕或材料正文中按关键词检索。query 传关键词或短语；可用 path 指向 transcript 或 material。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, query: { type: 'string' }, offset: { type: 'integer' }, limit: { type: 'integer' } }, required: ['query'] },
  },
};
export const RESOURCE_READ_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'read',
    description: '读取课程字幕或材料正文范围；raw=true 读取 Markdown 原文以便 edit。也可读取 /system/AGENTS.md、具名 /system/memory/*.md、/system/skills 与看板实体文档，返回 revision 和分页。也可 read /skills 获取技能。',
    parameters: { type: 'object', properties: { path: { type: 'string' }, start: { type: 'number' }, end: { type: 'number' }, offset: { type: 'integer' }, column: { type: 'integer' }, limit: { type: 'integer' }, revision: { type: 'integer' }, raw: { type: 'boolean' } }, required: ['path'] },
  },
};
export const LIST_COURSES_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'list_courses',
    description: '列出资料库中的课程，返回真实 courseId、名称、类型和学习进度。',
    parameters: { type: 'object', properties: { status: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'integer' } } },
  },
};
export const SEARCH_LIBRARY_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'search_course_library',
    description: '检索资料库中的视频字幕和阅读材料正文。query 传关键词或短语，可用 courseId 限定课程。',
    parameters: { type: 'object', properties: { query: { type: 'string' }, courseId: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] },
  },
};
export const COURSE_DETAILS_TOOL: ToolDef = {
  type: 'function', function: {
    name: 'get_course_details',
    description: '读取一门课程的详细状态、进度以及已生成内容数量。',
    parameters: { type: 'object', properties: { courseId: { type: 'string' } }, required: ['courseId'] },
  },
};
