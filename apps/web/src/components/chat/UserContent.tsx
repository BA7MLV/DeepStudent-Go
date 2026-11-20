/**
 * 用户气泡内容：把开头的**引用块**（`> ` 前缀的连续行）单独渲染成引用样式。
 *
 * 为什么要拆：引用块落库时存的是 Markdown blockquote 原文，而用户气泡是**纯文本渲染**
 * （不走 markdown），直接吐出来会把 `> ` 露在脸上。拆开渲染既好看，也让人一眼分清
 * 「这是我引的原文」与「这是我问的问题」。
 *
 * 没有引用块时行为与从前完全一致（原样渲染 `content`），既有消息与 e2e 都不受影响。
 */
export function UserContent({ content }: { content: string }) {
  const lines = content.split('\n');
  const quoted: string[] = [];
  let i = 0;
  while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
    quoted.push((lines[i] ?? '').slice(2));
    i++;
  }
  if (quoted.length === 0) return <>{content}</>;
  const rest = lines.slice(i).join('\n').trim();
  // formatCitation 的首行固定是「[选自 位置]」，抽出来单独当来源标签
  const src = /^\[选自\s*(.+?)\]$/.exec(quoted[0] ?? '');
  const body = src ? quoted.slice(1).join('\n') : quoted.join('\n');
  return (
    <>
      <span className="chat-quote" data-testid="chat-quote">
        <span className="chat-quote__src">{src ? `选自 ${src[1]}` : '引用原文'}</span>
        <span className="chat-quote__text">{body}</span>
      </span>
      {rest && <span className="chat-quote__ask">{rest}</span>}
    </>
  );
}
