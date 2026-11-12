import crypto from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { ToolDef } from '@wangke/study-core/model/client';
import type { TaskContext } from '../src/cloud/execution.js';
import { shellDecision } from '../src/agent/permissions.js';
import { cancelSandbox, executeSandbox, SandboxFailure, shellTimeoutSeconds, shellToolTimeoutMs } from '../src/agent/sandbox.js';

const shellTool: ToolDef = { type: 'function', function: {
  name: 'shell',
  description: '在当前聊天独立的 Linux 沙盒中执行 bash、Python 或 Node，用于计算、数据处理和运行脚本。/workspace 文件跨轮保留，但每条命令都是新容器，cd、export、后台进程不会延续；依赖请装在 /workspace。默认120秒，最长600秒。仅 /workspace 和 /tmp 可写，/system 只读，不挂载课程原文件或其他 Bot 工作区。附件原件不会自动出现在沙盒，不能编造附件路径。大输出请重定向到 /workspace 文件，再分段查看。network 默认为 false；联网仍须账户允许。删除或有对外影响的命令设 requiresApproval=true；直接调用，由宿主显示审批，不要另行 ask_user。',
  parameters: { type: 'object', additionalProperties: false, properties: {
    command: { type: 'string', minLength: 1, maxLength: 16000 },
    description: { type: 'string', minLength: 1, maxLength: 2000, description: '向用户说明执行目的，审批时显示。' },
    network: { type: 'boolean' },
    timeoutSeconds: { type: 'integer', minimum: 1, maximum: 600 },
    requiresApproval: { type: 'boolean' },
  }, required: ['command', 'description'] },
} };

/** A separate namespace from Bot UUIDs; neither the model nor task input can
 * select another owner's/session's workspace or a resource project mount. */
export function chatShellWorkspace(owner: string, sessionId: number) {
  const key = crypto.createHash('sha256').update(`chat-shell\0${owner}\0${sessionId}`).digest('hex').slice(0, 32);
  return `${key.slice(0, 8)}-${key.slice(8, 12)}-${key.slice(12, 16)}-${key.slice(16, 20)}-${key.slice(20)}`;
}

export function sessionShell(context: TaskContext) {
  const sessionId = context.task.input.sessionId;
  const nested = () => Boolean(context.store.db.prepare('SELECT 1 FROM task_delegations WHERE task_id=?').get(context.task.id));
  const assertScope = () => {
    context.checkActive();
    const task = context.store.db.prepare('SELECT kind,parent_run_id,status FROM cloud_tasks WHERE id=? AND owner_id=?').get(context.task.id, context.owner) as { kind: string; parent_run_id: string | null; status: string } | undefined;
    const session = typeof sessionId === 'number' && Number.isSafeInteger(sessionId) && sessionId > 0
      ? context.records.get(context.owner, 'chatSessions', sessionId) : null;
    if (!task || task.kind !== 'chat' || task.parent_run_id || nested() || !['running', 'waiting_user'].includes(task.status)
      || !session || session.archived || session.videoId !== '__library_assistant__') throw new Error('chat_shell_scope_denied');
  };
  const eligible = context.task.kind === 'chat' && !nested() && !context.store.db.prepare('SELECT 1 FROM cloud_tasks WHERE id=? AND owner_id=? AND parent_run_id IS NOT NULL').get(context.task.id, context.owner);
  return {
    tools: eligible ? [shellTool] : [],
    prompt: eligible ? '\n\n需要精确计算或执行脚本时可直接调用 shell，结果会返回同一聊天工具循环。工作目录属于本会话，文件保留但进程状态不保留。上传附件只提供已有提取内容，原件不自动挂载；本轮不支持把沙盒产物直接作为聊天下载附件。不要声称未执行的命令已成功，也不要把 /workspace 路径当成用户可下载链接。' : '',
    wrap(execute: (name: string, args: Record<string, unknown>) => Promise<string>) {
      return async (name: string, args: Record<string, unknown>) => {
        if (name !== 'shell') return execute(name, args);
        assertScope();
        if (Object.keys(args).some(key => !['command', 'description', 'network', 'timeoutSeconds', 'requiresApproval'].includes(key))
          || typeof args.command !== 'string' || !args.command.trim() || args.command.length > 16000 || args.command.includes('\0')
          || typeof args.description !== 'string' || !args.description.trim() || args.description.length > 2000
          || ['network', 'requiresApproval'].some(key => args[key] !== undefined && typeof args[key] !== 'boolean')) throw new Error('invalid_chat_shell_arguments');
        const command = args.command, description = args.description;
        const timeoutSeconds = shellTimeoutSeconds(args.timeoutSeconds as number | undefined);
        const network = args.network === true, requiresApproval = args.requiresApproval === true;
        const decision = () => {
          assertScope();
          const policy = context.configuration.taskPolicy(context.owner, context.task.id);
          // The broker mounts the owner's notebook read-only. A shell permit
          // must never silently bypass a read denial or a read confirmation.
          if (policy.read === 'deny' || network && policy.network !== 'allow') return 'deny';
          const result = shellDecision(policy, command, requiresApproval).permission;
          return result === 'allow' && policy.read === 'ask' ? 'ask' : result;
        };
        if (decision() === 'deny') throw new Error('shell_permission_denied');
        const sandbox = context.sandbox ?? executeSandbox;
        if (sandbox === executeSandbox && (!process.env.SANDBOX_URL || !process.env.SANDBOX_TOKEN)) throw new SandboxFailure('sandbox_not_configured');
        const id = crypto.randomUUID(), db = context.store.db;
        const serialized = JSON.stringify({ command, description, network, timeoutSeconds, requiresApproval });
        const ask = decision() === 'ask';
        db.prepare('INSERT INTO cloud_permissions(id,owner_id,task_id,capability,arguments,created_at,status) VALUES(?,?,?,?,?,?,?)')
          .run(id, context.owner, context.task.id, 'shell', serialized, new Date().toISOString(), ask ? 'pending' : 'consumed');
        try {
          if (ask) {
            db.prepare("UPDATE cloud_tasks SET status='waiting_user' WHERE id=? AND owner_id=? AND status='running'").run(context.task.id, context.owner);
            for (;;) {
              if (decision() === 'deny') throw new Error('shell_permission_revoked');
              const permission = db.prepare('SELECT status FROM cloud_permissions WHERE id=? AND owner_id=? AND task_id=? AND capability=? AND arguments=?')
                .get(id, context.owner, context.task.id, 'shell', serialized) as { status: string } | undefined;
              if (permission?.status === 'approved') {
                if (!db.prepare("UPDATE cloud_permissions SET status='consumed' WHERE id=? AND owner_id=? AND task_id=? AND status='approved'").run(id, context.owner, context.task.id).changes) throw new Error('permission_already_consumed');
                break;
              }
              if (permission?.status !== 'pending') throw new Error('shell_permission_rejected');
              await delay(100, undefined, { signal: context.signal });
            }
            db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(context.task.id);
          }
          if (decision() === 'deny') throw new Error('shell_permission_revoked');
          context.configuration.audit(context.owner, 'permission.consumed', { id, taskId: context.task.id, capability: 'shell' });
          const signal = AbortSignal.any([context.signal, AbortSignal.timeout(shellToolTimeoutMs({ timeoutSeconds }))]);
          try {
            const result = await sandbox({ owner: context.owner, threadId: chatShellWorkspace(context.owner, sessionId as number), executionId: id, command, network, timeoutSeconds }, signal);
            context.checkActive();
            // Chat has no Bot artifact journal. Do not advertise an artifact
            // that wasn't saved; large logs should be redirected by the command.
            const preview = (text: string) => text.replace('[Output preview truncated; read the saved artifact for full output.]', '[Output preview truncated; redirect large logs to /workspace and inspect smaller chunks.]');
            return JSON.stringify({ ...result, stdout: preview(result.stdout), stderr: preview(result.stderr) });
          } catch (error) {
            try { await (context.sandboxCleanup ?? cancelSandbox)(id); }
            catch { throw new SandboxFailure('sandbox_cleanup_pending'); }
            throw error;
          }
        } finally {
          db.prepare("UPDATE cloud_permissions SET status='finished' WHERE id=? AND status='consumed'").run(id);
          db.prepare("UPDATE cloud_permissions SET status='expired' WHERE id=? AND status IN ('pending','approved')").run(id);
          db.prepare("UPDATE cloud_tasks SET status='running' WHERE id=? AND status='waiting_user'").run(context.task.id);
        }
      };
    },
  };
}
