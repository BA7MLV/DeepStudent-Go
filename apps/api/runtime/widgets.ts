import { randomUUID } from 'node:crypto';
import { MAX_HTML, validateWidgetArgs, widgetAcceptedText, widgetRejectedText, type WidgetPayload } from '@wangke/study-core/widgets';
import { SHOW_WIDGET_TOOL } from '@wangke/study-core/widget-tool';
import { validateDiagram } from '@wangke/study-core/diagram-schema';
import { compileExpression } from '@wangke/study-core/diagram-expression';
import { applyArtifactReply } from '@wangke/study-core/artifact-edit';

/** Only the native task executor offers the optional in-memory assembly fields. */
export const SERVER_SHOW_WIDGET_TOOL = {
  ...SHOW_WIDGET_TOOL,
  function: { ...SHOW_WIDGET_TOOL.function, parameters: {
    ...SHOW_WIDGET_TOOL.function.parameters,
    additionalProperties: false,
    properties: { ...(SHOW_WIDGET_TOOL.function.parameters.properties as Record<string, unknown>),
      action: { type: 'string', enum: ['append', 'read', 'patch', 'complete', 'discard'], description: '仅 html 任务内存：append 追加（code为1~6000 UTF-16字符，建议1000~2000，libs仅首段），read 只读片段，patch 精确局部修改，complete 校验交付，discard 清空。不传 action 仍直接完整 code；非 append 动作 code 必须为 ""。禁止无关字段，无跨任务恢复。' },
      revision: { type: 'integer', minimum: 0, description: 'append/patch/complete/discard 必填，首次0，后续用最新回执 revision；read 可省略以获取当前基线，传入则必须匹配。每次成功写入/清空/完成递增，失败不变，同轮多调用按顺序执行且各自校验，不是整轮事务。' },
      offset: { type: 'integer', minimum: 0, description: 'append/complete 必填且等于回执 length；read 必填片段起点（UTF-16，不能切开代理对）。其他动作禁止。' },
      limit: { type: 'integer', minimum: 1, maximum: 4000, description: '仅 read，可选，默认2000，最多4000 UTF-16字符；返回 content/nextOffset，末端避开代理对。' },
      edits: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object', additionalProperties: false, required: ['search', 'replace'], properties: { search: { type: 'string', minLength: 1 }, replace: { type: 'string' } } }, description: '仅 patch：1~20项，search+replace 合计最多6000 UTF-16字符，JSON序列化最多40000字符；建议1000~2000。全部针对同一原文精确唯一匹配，无重叠，原子提交。用唯一非空锚点插入/删除，不支持模糊匹配。' },
    },
  } },
};

/** One bounded buffer per invocation of runServerAgent, never persisted or shared. */
export function createTaskWidgetExecutor() {
  let pending: { code: string; libs?: string[] } | undefined;
  let revision = 0;
  const unicode = (text: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
  const receipt = (status: string, extra = {}) => JSON.stringify({ status, revision, length: pending?.code.length ?? 0, offsetUnit: 'UTF-16', ...extra });
  return (args: Record<string, unknown>, accept: (payload: WidgetPayload) => void): string => {
    if (args.action === undefined) {
      if (Object.keys(args).some(key => !['format', 'code', 'title', 'libs'].includes(key))) throw new Error('invalid_widget_assembly: action required for assembly fields');
      return executeServerWidget(args, accept);
    }
    const fields: Record<string, string[]> = { append: ['offset', 'libs'], read: ['offset', 'limit'], patch: ['edits'], complete: ['offset'], discard: [] };
    if (args.format !== 'html' || typeof args.action !== 'string' || !Object.hasOwn(fields, args.action)
      || Object.keys(args).some(key => !['format', 'action', 'revision', 'code', ...fields[args.action as string]].includes(key))
      || (args.action !== 'append' && args.code !== '')) throw new Error('invalid_widget_assembly');
    const length = pending?.code.length ?? 0;
    if (!(args.action === 'read' && args.revision === undefined)
      && (!Number.isSafeInteger(args.revision) || args.revision !== revision)) throw new Error(`widget_assembly_revision_conflict: revision=${revision}, length=${length}; read 当前基线后重新提交完整小操作，禁止盲目重试`);
    if (args.action === 'read') {
      const offset = args.offset as number, limit = (args.limit ?? 2000) as number;
      const source = pending?.code ?? '';
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > length || !Number.isSafeInteger(limit) || limit < 1 || limit > 4000) throw new Error('invalid_widget_assembly_read');
      if (offset < length && /[\uDC00-\uDFFF]/.test(source[offset])) throw new Error('widget_assembly_unicode_boundary');
      let end = Math.min(length, offset + limit);
      if (end < length && /[\uDC00-\uDFFF]/.test(source[end])) end--;
      if (end === offset && offset < length) throw new Error('widget_assembly_read_limit: increase limit to include whole Unicode character');
      return receipt(pending ? 'assembling-not-runnable' : 'empty', { offset, content: source.slice(offset, end), nextOffset: end < length ? end : null });
    }
    if (args.action === 'discard') {
      pending = undefined;
      revision++;
      return receipt('discarded');
    }
    if (args.action === 'patch') {
      if (!pending || !Array.isArray(args.edits) || !args.edits.length || args.edits.length > 20) throw new Error('invalid_widget_assembly_patch: 1~20 edits and a pending source required');
      let size = 0;
      for (const edit of args.edits) {
        if (!edit || typeof edit !== 'object' || Array.isArray(edit) || Object.keys(edit).some(key => !['search', 'replace'].includes(key))
          || typeof edit.search !== 'string' || !edit.search || typeof edit.replace !== 'string') throw new Error('invalid_widget_assembly_patch_edit');
        if (!unicode(edit.search) || !unicode(edit.replace)) throw new Error('widget_assembly_unicode_boundary');
        size += edit.search.length + edit.replace.length;
      }
      if (size > 6000 || JSON.stringify(args.edits).length > 40000) throw new Error('widget_assembly_patch_too_large: search+replace limit=6000; JSON limit=40000');
      // Reuse the editor's SAME-base, unique-match, non-overlapping algorithm.
      // Compute and validate everything before changing either content or revision.
      const next = applyArtifactReply(pending.code, { edits: args.edits }, 'patch');
      if (next.length > MAX_HTML) throw new Error(`widget_assembly_too_large: limit=${MAX_HTML}`);
      if (!unicode(next)) throw new Error('widget_assembly_unicode_boundary');
      pending = { ...pending, code: next };
      revision++;
      return receipt('assembling-not-runnable');
    }
    if (!Number.isSafeInteger(args.offset) || args.offset !== length) throw new Error(`widget_assembly_offset_conflict: length=${length}; 本任务内存偏移不匹配，勿盲目重复追加；丢弃后可从0重新组装`);
    if (args.action === 'append') {
      if (typeof args.code !== 'string' || !args.code.length || args.code.length > 6000) throw new Error('invalid_widget_assembly_chunk: complete code must contain 1~6000 UTF-16 characters');
      if (!unicode(args.code)) throw new Error('widget_assembly_unicode_boundary: submit whole Unicode characters');
      if (length + args.code.length > MAX_HTML) throw new Error(`widget_assembly_too_large: limit=${MAX_HTML}; simplify or split into separate pages`);
      if (pending && args.libs !== undefined) throw new Error('widget_assembly_libs_only_on_first_chunk');
      const parsed = validateWidgetArgs({ format: 'html', code: '<div></div>', libs: pending?.libs ?? args.libs });
      if (!parsed.ok) throw new Error(parsed.error);
      pending = { code: (pending?.code ?? '') + args.code, libs: parsed.args.libs };
      revision++;
      return receipt('assembling-not-runnable');
    }
    if (!pending || args.code !== '' || args.libs !== undefined) throw new Error('invalid_widget_assembly_complete');
    // Failures leave this task-local buffer intact, never alter earlier chat pages.
    for (const tag of ['script', 'style']) {
      if ([...pending.code.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].length !== [...pending.code.matchAll(new RegExp(`</${tag}\\s*>`, 'gi'))].length) throw new Error(`widget_assembly_incomplete: unclosed ${tag}; read then patch/append to repair, or discard and restart`);
    }
    const accepted = executeServerWidget({ format: 'html', ...pending }, accept);
    pending = undefined;
    revision++;
    return accepted + '\n' + receipt('completed');
  };
}

/** No generated code is evaluated here. Browser sandbox/render checks remain mandatory. */
export function executeServerWidget(raw: unknown, accept: (payload: WidgetPayload) => void): string {
  const parsed = validateWidgetArgs(raw);
  if (!parsed.ok) throw new Error(`预检参数不合法：${parsed.error}。请修正后重新调用 show_widget。`);
  const args = parsed.args;
  try {
    if (args.format === 'html') {
      const id = randomUUID();
      const payload: WidgetPayload = { kind: 'html', schemaVersion: 1, revision: 1, source: 'tool', id, ref: id, html: args.code,
        ...(args.libs?.length ? { libs: args.libs } : {}) };
      // The caller commits this payload before a successful receipt reaches the model.
      accept(payload);
      return widgetAcceptedText(args, id);
    }
    if (args.format === 'diagram') {
      let input: unknown;
      try { input = JSON.parse(args.code); }
      catch { throw new Error('diagram 围栏里不是合法的 JSON，请检查逗号、引号和多余说明'); }
      const doc = validateDiagram(input);
      if (doc.type === 'plot') for (const curve of doc.curves ?? []) compileExpression(curve.fn);
    } else if (args.format === 'svg') {
      if (!/^<svg\b[^>]*\bviewBox\s*=/i.test(args.code)) throw new Error('SVG 必须以 <svg 开头并带 viewBox');
      if (!/<\/svg>\s*$/i.test(args.code)) throw new Error('SVG 没有闭合（缺少 </svg>）');
      if (/<\s*(?:script|iframe|object|embed|foreignObject|image|use|a|style|animate\w*|set)\b|\son[a-z]+\s*=|\b(?:href|src)\s*=|javascript:/i.test(args.code)
        || [...args.code.matchAll(/url\(\s*['"]?\s*([^'")]*)/gi)].some(match => !match[1].trim().startsWith('#'))) {
        throw new Error('SVG 包含脚本或外部嵌入内容，已阻止渲染');
      }
    } else {
      // Mermaid's complete parser/rendering needs a DOM. Do not claim a server
      // render succeeded or import a Web runtime into the API for that purpose.
      if (!/^(?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|mindmap|pie|gantt|journey|gitGraph|timeline|quadrantChart|xychart-beta)\b/.test(args.code)) {
        throw new Error('mermaid 需以支持的图种声明开头，如 flowchart / sequenceDiagram / stateDiagram-v2 / mindmap / pie');
      }
    }
    return `服务器已完成参数与结构预检；完整图形语法、净化和渲染仍由客户端检查。\n${widgetAcceptedText(args)}`;
  } catch (error) {
    // Never convert persistence/cancellation failures into a success receipt.
    if (args.format === 'html') throw error;
    throw new Error(widgetRejectedText(error));
  }
}
