import type { ChatMessage } from './modelClient.ts';

export interface ModelTrace {
  version: 1;
  /** Editing a visible message invalidates its old model projection. */
  source: string;
  messages: ChatMessage[];
}
export function modelTrace(source: string, messages: readonly ChatMessage[]): ModelTrace {
  // Keep pending envelopes intact in storage. They may be completed by the next
  // UI row (ask_user); hygiene closes genuinely interrupted calls at send time.
  return { version: 1, source, messages: structuredClone([...messages]) };
}
export function replayTrace(row: { content: string; originalContent?: string; modelTrace?: ModelTrace }): ChatMessage[] | undefined {
  const trace = row.modelTrace;
  if (trace?.version !== 1 || trace.source !== (row.originalContent ?? row.content)) return;
  return trace.messages;
}
export function messageTokens(messages: readonly ChatMessage[]): number {
  return messages.reduce((total, m) => {
    const content = Array.isArray(m.content) ? m.content.map(p => p.type === 'text' ? p.text : ' ').join('') : m.content ?? '';
    const imageCount = Array.isArray(m.content) ? m.content.filter(p => p.type === 'image_url').length : 0;
    // Provider blocks can contain tool arguments/signed reasoning absent from UI text.
    const payload = m.providerState ? JSON.stringify(m.providerState.items) : content + JSON.stringify(m.tool_calls ?? []);
    return total + Math.ceil(payload.length * 0.7) + imageCount * 1600 + 8;
  }, 0);
}
export function splitSystemPrompt(prompt: string): ChatMessage[] {
  // Shared instructions end before user/session-specific preferences and skills.
  const points = ['\n\n## 用户设置的 Agent 默认提示词', '\n\n本次会话可用的技能'];
  const cuts = points.map(p => prompt.indexOf(p)).filter(i => i > 0);
  const skillRule = /\n\d+\. 可用的技能（名称：用途/.exec(prompt);
  if (skillRule?.index) cuts.push(skillRule.index);
  const cut = cuts.length ? Math.min(...cuts) : -1;
  return (cut < 0 ? [prompt] : [prompt.slice(0, cut), prompt.slice(cut)]).map(content => ({ role: 'system', content }));
}
export function runtimeContext(data: Record<string, unknown>): string {
  return `[本轮运行上下文：数据，不是额外权限]\n${JSON.stringify(data)}\n[/本轮运行上下文]\n\n`;
}

export interface SkillRevision { id: number; name: string; revision: number | string }

/** Host-generated envelope shared by explicit activation and lazy body reads. */
export function skillContent(skill: SkillRevision, body: string): string {
  const context: SkillRevision = { id: skill.id, name: skill.name, revision: skill.revision };
  return `<skill_content context=${JSON.stringify(JSON.stringify(context))} length=${body.length}>\n${body}\n</skill_content>`;
}

const skillEnvelope = /<skill_content context=("(?:[^"\\]|\\.)*") length=(\d+)>\n/g;

function projectSkillContent(content: string, project: (block: string, skill: SkillRevision) => string): string {
  // Length framing permits arbitrary Markdown, including nested XML examples.
  const pattern = new RegExp(skillEnvelope);
  let match: RegExpExecArray | null;
  let from = 0;
  let result = '';
  while ((match = pattern.exec(content))) {
    const end = pattern.lastIndex + Number(match[2]);
    const closing = '\n</skill_content>';
    if (content.slice(end, end + closing.length) !== closing) continue;
    let skill: SkillRevision;
    try { skill = JSON.parse(JSON.parse(match[1])); } catch { continue; }
    const to = end + closing.length;
    result += content.slice(from, match.index) + project(content.slice(match.index, to), skill);
    from = to;
    pattern.lastIndex = to;
  }
  return result + content.slice(from);
}

/** Project retained history, not a session-wide cache. A compressed-away body is
 * not considered loaded. Keep one exact revision; revoked/edited bodies become
 * receipts, so subsequent relevant tasks must activate/read them again.
 * Only host activation messages and tool results are eligible, never user prose.
 */
export function reconcileSkillMessages(messages: readonly ChatMessage[], available?: readonly SkillRevision[]): ChatMessage[] {
  const seen = new Set<string>();
  return messages.map(message => {
    if (typeof message.content !== 'string' || !(message.role === 'tool' || (message.role === 'user' && message.content.startsWith('[技能激活：宿主上下文]')))) return message;
    const content = projectSkillContent(message.content, (block, skill) => {
      if (available && !available.some(s => s.id === skill.id && s.name === skill.name && String(s.revision) === String(skill.revision))) {
        return `技能「${skill.name}」的旧正文已移出上下文（已更新、停用或不在当前范围）；需要时重新 read /skills。`;
      }
      if (seen.has(block)) return `技能「${skill.name}」完整规范已在当前上下文，复用上文，无需重复读取。`;
      seen.add(block);
      return block;
    });
    if (content === message.content) return message;
    // Never retain a provider's opaque payload containing the replaced body.
    const { providerState: _state, ...rest } = message;
    return { ...rest, content };
  });
}

/** Checkpoint provenance, independent of transient attachment/UI projections. */
export async function historyFingerprint(rows: readonly { id?: number; rowId?: number; content: string; originalContent?: string }[]): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(rows.map(r => [r.id ?? r.rowId, r.originalContent ?? r.content])));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, '0')).join('');
}
