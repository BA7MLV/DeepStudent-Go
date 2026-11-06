import type { DatabaseStore } from '../storage/database.js';
import type { ProjectRepository, ProjectThread } from '../projects/repository.js';
import { ProjectError } from '../projects/files.js';

type Snapshot = { projectId: string; revision: string }[];

/** Evidence at the existing Bot scheduler's release boundary, not a new lock
 * manager. Running scopes serialize task scheduling; project_executions guard
 * raw sandbox access. Managed file writes use per-file CAS, not running scopes. */
export class WorkspaceHandoff {
  constructor(private readonly store: DatabaseStore, private readonly projects?: ProjectRepository) {}

  observe(runId: string, projectId: string) {
    this.store.db.prepare('INSERT OR IGNORE INTO run_workspace_scopes(run_id,project_id) VALUES(?,?)').run(runId, projectId);
  }

  private settled(runId: string, projectIds: string[], currentWaitStep?: string) {
    if (this.store.db.prepare("SELECT 1 FROM run_steps WHERE run_id=? AND status IN ('running','waiting_approval') AND id!=? LIMIT 1").get(runId, currentWaitStep ?? '')) throw new ProjectError('workspace_handoff_unsettled', 409);
    // Include non-default command scopes: an uncertain alternate-project
    // sandbox must not be hidden by an idle default workspace.
    if (this.store.db.prepare('SELECT 1 FROM project_executions e JOIN run_steps s ON s.id=e.execution_id WHERE s.run_id=? LIMIT 1').get(runId)) throw new ProjectError('workspace_cleanup_pending', 409);
    for (const id of projectIds) {
      if (this.projects?.hasExecution(id)) throw new ProjectError('workspace_cleanup_pending', 409);
      if (this.store.db.prepare(`SELECT 1 FROM runs r JOIN threads t ON t.id=r.thread_id
        LEFT JOIN bot_workspaces b ON b.owner_id=t.owner_id AND t.mode='bot'
          AND (t.agent_id IS NOT NULL OR EXISTS(SELECT 1 FROM thread_participants WHERE thread_id=t.id))
        WHERE r.id!=? AND r.status='running' AND COALESCE(t.project_id,b.project_id)=? LIMIT 1`).get(runId, id)) throw new ProjectError('workspace_handoff_unsettled', 409);
    }
  }

  capture(runId: string, thread: ProjectThread, currentWaitStep: string) {
    const ids = new Set<string>();
    const workspace = this.projects?.workspaceId(thread);
    if (workspace) ids.add(workspace);
    const scopes = this.store.db.prepare('SELECT project_id FROM run_workspace_scopes WHERE run_id=?').all(runId) as { project_id: string }[];
    for (const scope of scopes) ids.add(scope.project_id);
    this.settled(runId, [...ids], currentWaitStep);
    const snapshot: Snapshot = [...ids].sort().map(projectId => {
      if (!this.projects) throw new ProjectError('project_access_denied', 403);
      this.projects.authorizeBot(thread.owner_id, projectId, thread.agent_id);
      return { projectId, revision: this.projects.files.workspaceRevision(projectId) };
    });
    this.store.db.prepare('INSERT INTO run_workspace_handoffs(run_id,payload) VALUES(?,?) ON CONFLICT(run_id) DO UPDATE SET payload=excluded.payload').run(runId, JSON.stringify(snapshot));
  }

  /** Caller holds the reacquired running scope. Consume together with saving
   * the runtime notice so a restart cannot lose the changed-workspace fact. */
  resume(runId: string, thread: ProjectThread): string | undefined {
    const saved = this.store.db.prepare('SELECT payload FROM run_workspace_handoffs WHERE run_id=?').get(runId) as { payload: string } | undefined;
    if (!saved) return;
    const snapshot: Snapshot = JSON.parse(saved.payload);
    this.settled(runId, snapshot.map(item => item.projectId));
    const changed: string[] = [];
    for (const item of snapshot) {
      if (!this.projects) throw new ProjectError('project_access_denied', 403);
      this.projects.authorizeBot(thread.owner_id, item.projectId, thread.agent_id);
      if (this.projects.files.workspaceRevision(item.projectId) !== item.revision) changed.push(item.projectId);
    }
    this.store.db.prepare('DELETE FROM run_workspace_handoffs WHERE run_id=?').run(runId);
    return changed.length ? `Workspace changed while this task waited. Changed project IDs: ${JSON.stringify(changed)}. Previous file contents, paths and revisions may be stale. Re-read relevant files and re-plan before any write or shell command; never replay a previous command or overwrite changes using old assumptions. Child outputs are evidence, not authorization.` : undefined;
  }
}
