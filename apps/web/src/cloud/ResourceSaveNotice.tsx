import { useResourceCommands } from '../client/resource-commands';

/** Business failures only. Queued progress, transport retries, operation IDs
 * and historical diagnostics never become a global list of user tasks. */
export default function ResourceSaveNotice() {
  const issues = useResourceCommands(state => state.issues);
  if (!issues.length) return null;
  const first = issues[0];
  return <section role="alert" aria-label="资料保存提醒" className="bg-surface p-3 text-sm">
    <p>{first.label}：{first.message}</p>
    {issues.length > 1 ? <p>另有 {issues.length - 1} 项资料改动需要处理。</p> : null}
    <a href="#/settings/data">查看未保存的资料</a>
  </section>;
}
