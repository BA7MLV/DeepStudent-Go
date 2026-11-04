import type Database from 'better-sqlite3';

/** Additive, data-preserving schema component. Runs remain Bot's attempt authority. */
export function migrateTaskModels(db: Database.Database) {
  const add = (table: string, column: string, type = 'TEXT') => {
    const saved = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string; type: string; notnull: number; pk: number; dflt_value: unknown }[]).find(c => c.name === column);
    if (!saved) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    else if (saved.type !== type || saved.notnull !== 0 || saved.pk !== 0 || saved.dflt_value !== null) throw new Error(`schema_layout_untrusted_${table}_${column}`);
  };
  add('runs', 'model_snapshot');
  add('runs', 'root_run_id');
  add('cloud_tasks', 'model_snapshot');
  add('cloud_tasks', 'root_task_id');
  add('threads', 'default_model');
  add('messages', 'task_command');
  add('model_observations', 'task_id');
  add('model_observations', 'reserved_tokens', 'INTEGER');
  add('model_observations', 'price_json');
  db.exec(`CREATE INDEX IF NOT EXISTS model_observations_task ON model_observations(owner_id,task_id);
  CREATE TABLE IF NOT EXISTS task_delegations (
    task_id TEXT PRIMARY KEY REFERENCES cloud_tasks(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    parent_task_id TEXT REFERENCES cloud_tasks(id), parent_run_id TEXT REFERENCES runs(id),
    root_id TEXT NOT NULL, dependencies TEXT NOT NULL, promoted_session_id INTEGER,
    delivery TEXT NOT NULL DEFAULT 'foreground'
  );
  CREATE INDEX IF NOT EXISTS task_delegations_root ON task_delegations(owner_id,root_id);
  CREATE TABLE IF NOT EXISTS task_session_commands (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, operation_id TEXT NOT NULL,
    request TEXT NOT NULL, session_id INTEGER NOT NULL, PRIMARY KEY(owner_id,operation_id)
  );
  CREATE TABLE IF NOT EXISTS task_agent_checkpoints (
    task_id TEXT PRIMARY KEY REFERENCES cloud_tasks(id) ON DELETE CASCADE,
    payload TEXT NOT NULL, wait_ids TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_workspace_handoffs (
    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
    payload TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS run_workspace_scopes (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    PRIMARY KEY(run_id,project_id)
  );
  CREATE TABLE IF NOT EXISTS task_root_cancellations (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    root_id TEXT NOT NULL, PRIMARY KEY(owner_id,root_id)
  );
  CREATE TABLE IF NOT EXISTS task_tool_steps (
    task_id TEXT NOT NULL REFERENCES cloud_tasks(id) ON DELETE CASCADE,
    operation_id TEXT NOT NULL,
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    root_kind TEXT NOT NULL CHECK(root_kind IN ('run','task')),
    root_id TEXT NOT NULL,
    PRIMARY KEY(task_id,operation_id)
  );
  CREATE INDEX IF NOT EXISTS task_tool_steps_root ON task_tool_steps(owner_id,root_kind,root_id);`);
}
