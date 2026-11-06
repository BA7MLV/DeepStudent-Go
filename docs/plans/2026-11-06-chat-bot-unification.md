# Chat / Bot 调用统一与会话自寻上下文规范

状态：待实施。本文是给实施者的完整规范；MUST 表示必须，SHOULD 表示默认应采用、偏离需记录原因。

## 1. 目标与边界

Chat 与 Bot 是同一执行内核的两种 profile，而不是两套栈。统一后：

- 只有一个会话模型（`threads`）、一个执行器（`BotRunner`）、一个调度/恢复/取消实现。
- Chat 与 Bot 的差异收敛为执行 profile：上下文策略、可用工具集、默认提示词。Bot 无固定上下文约束、可自治多步；Chat 同样**不预注入课程上下文**，改为通过工具自寻资料。
- IM/Web 入口继续共用 `BotApplicationService`，不新增第三套入口。

不在本规范范围内：转写、讲义、卡片等非会话 `cloud_tasks` 仍由 `CloudTaskRunner` 调度；模型网关、任务级模型冻结、委派协议保持现状。

## 2. 现状与迁移映射

| 现状（chat 侧） | 迁移目标 |
|---|---|
| `chatSessions`/`chats`（cloud_records 投影） | `threads(mode='chat')` + `messages` |
| `cloud_tasks(kind='chat')` | `runs(mode='chat')`，由 `BotRunner` 执行 |
| `CloudTaskRunner` 的 chat 执行器 | 删除；`executorFor` 不再返回 chat 执行器 |
| `compressionBaseline`/`compressContext` | 保留语义，落位为 `BotRunner` 的 chat profile 上下文治理（复用 `context-governor`） |
| prompt cache key / contextCheckpoint | 挂到 thread 行，语义不变 |
| `session.default` / `bot.default` 委派命令 | 合并为 `thread.default`；旧命令保留兼容别名，行为等价 |

 MUST 迁移是一次性的、幂等的启动迁移：把每个 `chatSessions` 行写入 `threads`（`mode='chat'`，`project_id`/`skill_ids`/`default_model` 就位），每条 `chats` 消息按 `seq` 写入 `messages`，保留原 id 到 `legacy_id` 侧表以便回退核对。原始 cloud_records 不删除。
 MUST 迁移后同一会话只存在一个权威写入源；浏览器 confirmed cache 是只读投影的规则不变。

## 3. Chat profile：自寻上下文

Chat 不再按会话预绑定课程资料。用户提到课程、字幕或资料时，模型通过工具检索并引用，而不是依赖 `contextCourseIds` 预注入。

- MUST 提供（或复用）课程检索工具：课程列表、字幕/文档正文检索、按时间戳/页码取原文片段，结果带来源引用（时间戳、页码、段落），与现有 QA 引用格式一致。
- SHOULD 保留会话级 `contextCourseIds` 作为可选的检索范围过滤（缩小默认检索域），但不得把正文预注入提示词。
- MUST 提示词明确：没有检索到的课程内容不得臆造；引用必须来自工具结果。
- 检索工具的权限边界与 Bot 一致：只允许当前 owner 的资源；跨课程检索默认允许，与现有 QA 跨课程查找行为一致。
- `chat` 的执行预算（步数、工具轮次）默认低于 `bot`（建议 chat 8 步 / bot 沿用 `BOT_MAX_STEPS`），仍走同一预算账本。

## 4. 统一执行内核

- MUST `BotRunner` 按 thread 的 `mode` 选择 profile：提示词、工具集、预算、上下文治理策略。工具注册表按 profile 过滤（`agent/tools/registry.ts` 增加 profile 维度），chat 默认不暴露 shell/沙箱与系统文件写工具，除非会话显式授权（沿用现有审批开关）。
- MUST 恢复、取消、quiesce、并发槽逻辑只保留 `BotRunner` 一份；`CloudTaskRunner` 中与 chat 相关的恢复分支删除。
- MUST `runs.mode` 取值扩展为 `'chat' | 'bot'`，管理页 `/api/v1/bot/manage` 的 runs 查询改为按 mode 过滤（bot 页面不变，chat 会话在会话列表中展示）。
- MUST 现有 `task_delegations` 双向链路保持：chat thread 的 run 与 cloud task 之间仍可委派，交付事件落回对应 thread。
- SHOULD 上下文压缩计划（`compressContext`）复用 `bot_summaries` 存储，按 thread 计。

## 5. 兼容与验收

- MUST 旧客户端 `delegation({action:'session.read'})` 在迁移后的 thread 上继续可用（读投影），`session.create`/`session.default` 映射到 thread 操作；`sourceMessageId` 分支语义按 `docs/task-delegation-spec.md` 不变。
- MUST 保留测试通过：`npm run test:gateway`、`npm run test:chat:interactions`、`scripts/test-response-process.mjs`、`scripts/e2e-chat-trace.mjs`；迁移本身新增幂等性测试（跑两次结果一致）。
- SHOULD 新增验收记录文档 `docs/chat-bot-unification-acceptance.md`，记录迁移前后同一会话的对照证据。

## 6. 分阶段落地

1. **P1 迁移与双读**：启动迁移 + thread 读投影，chat 执行仍走旧路径（可回退）。
2. **P2 执行切换**：chat run 交给 `BotRunner`（chat profile），删除 `CloudTaskRunner` chat 执行器。
3. **P3 自寻上下文**：chat 提示词与检索工具接入，`contextCourseIds` 降级为过滤条件。
4. **P4 清理**：删除兼容别名之外的旧代码路径，更新 `docs/architecture.md`。
