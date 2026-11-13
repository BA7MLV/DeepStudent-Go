import { runCloudTask } from '../cloud/tasks';
import type { ArtifactKind } from '../utils/artifactEdit';
import { validateDiagram } from '../components/mermaid/diagramSchema';
import { sanitizeSvg } from '../components/mermaid/svgRender';
import { renderMermaid } from '../components/mermaid/mermaidRender';
import { validateWidgetArgs } from '../harness/widget';

/** A separate, tool-free request: no chat history, other figures, or generated runtime libraries. */
export async function editArtifact(input: {
  kind: ArtifactKind; source: string; instruction: string; context: string;
  libraries?: readonly string[];
  mode: 'patch' | 'rewrite'; signal: AbortSignal;
}): Promise<string> {
  const { signal, ...data } = input;
  return runCloudTask('artifactEdit', crypto.randomUUID(), data, undefined, signal);
}

export async function validateArtifact(kind: ArtifactKind, source: string, executableWidget = false): Promise<void> {
  if (kind === 'diagram') {
    let diagram: unknown;
    try { diagram = JSON.parse(source); } catch {
      throw new Error('修改后的图形 JSON 不完整或格式不正确，原内容未修改；请重新生成修改');
    }
    // dagre 布局库只在这一步需要,动态 import 避免它随对话首屏分包下载。
    const { renderDiagram } = await import('../components/mermaid/diagramRender');
    sanitizeSvg(renderDiagram(validateDiagram(diagram)).svg);
  } else if (kind === 'svg') {
    sanitizeSvg(source);
  } else if (kind === 'mermaid') {
    await renderMermaid(source);
  } else {
    // Widgets frequently begin with <style> or <script>; static-answer routing has
    // a narrower root list and must not be reused to reject valid widget payloads.
    if (!/^\s*(?:<!--|<!doctype\s+html\b|<[a-z][\w:-]*(?:\s|\/?>))/i.test(source)) throw new Error('修改结果不是 HTML 源码');
    if (executableWidget) {
      const result = validateWidgetArgs({ format: 'html', code: source }, true);
      if (!result.ok) throw new Error(`修改后的 HTML 未通过预检：${result.error}`);
    }
  }
}
