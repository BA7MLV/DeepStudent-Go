# 当前架构

当前产品仅支持服务端模式。Web 是经过认证的客户端，API 是业务执行和持久数据的权威；API 不可用不得启动本地静态应用。开发时同时启动 API 与 Web 代理。

## 数据与执行

- SQLite 保存业务事实和命令收据，文件保存真实资料；跨介质操作沿用文件意图。
- 浏览器 confirmed cache 是只读投影。离线草稿、待提交命令、附件及历史资料保全不属于静态执行模式，继续保留。
- 模型任务由服务器执行，页面只提交、观察与处理用户交互；关闭观察不取消任务。
- 卡片审核通过 `apps/api/src/learning/card-review.ts` 统一普通面板、插件和 Bot 的状态校验。调用方必须传原始 `expected` 状态；冲突不能改用最新状态盲重试。
- 账户根身份由 `client/account-lifecycle.ts` 的 `AccountLifetime` 管理；runtime、数据库、偏好与插件句柄共同失效。局部异步 incarnation 仍用于拒绝已结束订阅的晚回调，A→B→A 不复用旧身份。
- contracts 的 `plugin-dependencies.ts` 纯解析 manifest；API 的可信插件动作、provider、账户句柄由 Cordis 4 `Context.effect/provide` 托管。已删除自研 `PluginRegistry`。
- `realtime/runtime-domains.ts` 显式装配插件、资源、活动与记录领域的读取和失效匹配，公共认证、观察与收据保留在 `ClientRuntimeDomain`。
- 学习时长清空使用 `clearStudyTime` 完整快照 CAS；原收据重试不清除之后新增的时长。
- `handoutEdit/action=persist` 在服务器校验原始 IR/outline/blob 基线、重建 DOCX 与帧图，并在发布前再次 CAS；失败时原文件不变，浏览器保留编辑草稿。
- `chat/action=compressContext` 在服务器冻结完整历史基线，持久化保守的整轮省略计划。普通 chat、QA 和续写共用历史准备入口消费计划；内容改变、工具轮次、未完成轮次和最近两轮受保护，原始消息不删除。
- 历史恢复仅由显式操作加载，旧 journal 保存在历史档案，不回灌活动队列。未登录 Gate 可按需打开本机只读导出；无 API 不等于未缓存站点也能首次离线加载。详见[历史恢复](client-runtime/history-recovery.md)。

## 收敛状态

实施与验收以[服务端模式与能力收敛](plans/2026-11-05-server-only-consolidation.md)和[进度记录](client-runtime/server-only-progress.md)为准。聊天本地执行器、自研插件注册器及浏览器模型直连已退役；结构化讲义保存、上下文压缩、清空时长与历史恢复均已接入服务端模式。

## 规范与历史

- 云端数据不变量及已有验收：[唯一真相源](client-runtime/single-source-of-truth.md)。
- 任务执行：[服务器任务执行](server-task-execution.md)。
- `docs/client-runtime/ADR.md`、`stage-status.md`、`final-acceptance.md` 及 `docs/plugins/implementation.md` 是对应版本的历史实施证据，不代表本次收敛验收。历史记录和原始数据均保留。
