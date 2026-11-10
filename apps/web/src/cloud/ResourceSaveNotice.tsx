import { useResourceCommands } from '../client/resource-commands';
import { useState } from 'react';

/** Business failures only. Queued progress, transport retries, operation IDs
 * and historical diagnostics never become a global list of user tasks. */
export default function ResourceSaveNotice() {
  const issues = useResourceCommands(state => state.issues);
  const [collapsed, setCollapsed] = useState('');
  const signature = JSON.stringify(issues.map(issue => [issue.id, issue.message]));
  if (!issues.length) return null;
  // Collapse presentation only: never archive commands or discard their drafts.
  // A newly reported issue expands the reminder again.
  if (collapsed === signature) return null;
  const first = issues[0];
  return <section role="alert" aria-label="资料保存提醒" className="bg-surface p-3 text-sm">
    <p>{first.label}：{first.message}</p>
    {issues.length > 1 ? <p>另有 {issues.length - 1} 项资料改动需要处理。</p> : null}
    <a href="#/settings/data">查看未保存的资料</a>
    <button type="button" onClick={() => setCollapsed(signature)}>收起提醒</button>
  </section>;
}
