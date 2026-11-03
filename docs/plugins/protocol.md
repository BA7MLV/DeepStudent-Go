# 插件协议 v2（渐进实施）

此文档描述已落地的契约，不表示全部业务迁移已完成。类型与校验器：`packages/contracts/src/plugins.ts`。

## 包与身份

- 包：`/system/plugins/<id>/manifest.json`，`apiVersion:2`，唯一 slug ID、名称、版本、enabled、capabilities、views。
- HTML 视图：`views/<name>.html`，支持受校验的嵌套目录；仅内联脚本/CSS，禁止网络、宿主 DOM、任意文件读取。
- `defaults.json`：可选初始 JSON 状态。视图独立声明 surfaces 和 height，可选 `title/description` 用于可读展示方式；旧包未声明时使用功能名与展示方式序号，不暴露内部 view ID。
- 布局：`/system/plugin-layout.json`，含 `instances`、`placements` 和可选 `sources/navigation`。同 ID v1/v2 冲突时须显式选用来源。
- 实例状态：`/system/plugin-data/<pluginId>/instances/<instanceId>/state.json`。布局保存引用，不包含学习领域数据。
- 范围：账户、项目、资料。项目使用权威 ProjectRepository.writable 验证 owner、归档与回收站；资料使用原 CloudRecords 与 resource_files 映射，并检查原项目文件可用性。不接受客户端 ID 作为授权依据。

项目实例仅可挂在同项目或其资料范围，不能挂到账户默认或其他项目；资料实例不能挂到另一资料/不相关项目。不可用实例保留数据但禁止 RPC 和执行，布局只允许原样保留或移除旧行，不允许新增不可用范围。恢复项目后原实例恢复。

`GET /plugins` 及 `plugins list` 返回宿主解析的 `scopes`（projects/materialProjects/projectFolders/unavailableInstances，以及可读 materials 名称）。看板与插件总页通过 URL 的 `project` 显式选择项目；Chat 使用当前选择的资源项目，reader/资源动作由资料映射推导，不将项目自动挂到所有账户页面。独立实例页与历史消息使用已验证实例的范围。`resolvePluginPlacements` 按 surface + pluginId/viewId 执行资料 → 项目 → 账户替换，同层显式排序。

项目学习动作仅列出和操作项目内资料；任务、Bot thread 选择及持久调度同样检查范围，归档/回收站后调度停止派发。上下文 revision 包含项目/资料，内置视图切换时重建，旧动作仍绑定原实例与资源。

实例 ID 与挂载 ID 不同：复用实例共享状态；新实例隔离。挂载级草稿通过 `plugin.draft` 保存于当前标签页 sessionStorage，退出账户清除。移除挂载不删除实例；实例原插件/范围不可悄然重绑定。

## v1 兼容

`/system/board/plugins/<id>` 注册为 `default` 视图。`legacy-<id>` 默认实例直接读取原 state/schedules 文件，不复制、不迁移历史数据。新增 v1 包自动导入一次；隐藏入口不自动恢复。自定义 v1 实例建立独立状态，只读可选独立 `defaults.json`（未提供时 `{}`）；绝不将原包的**实时用户 state.json**复制为新内容。此调整不清空或迁移任何已存在实例。原目录包的修改/删除规则保持不变。

## 侧边栏导航

```json
{
  "navigation": [{ "id": "my-page", "placementId": "page-placement", "title": "每日计划", "order": 0 }]
}
```

`navigation` 是可选数组（最多 100 项），每项有唯一内部 id、引用 app.page 挂载的 placementId、可选可读 title 和整数 order。不能引用缺失/非页面挂载；新建或改变入口时服务端验证包、具体视图及项目/资料范围。无 navigation 的旧布局照常读取，不自动固定全部实例。

完整 URL：`/plugins/:instanceId?view=<viewId>&placement=<placementId>`。显式请求的 view/placement 不存在或不可用时不回退另一个视图。旧的无 view URL 仍可打开该包默认完整页，但新增导航始终使用明确视图。导航固定到所选挂载和实例的宿主上下文，不继承当前聊天的其他项目。名称/顺序/移除通过创造模式调用原布局工具，仅更新配置；移除 navigation 引用不删除数据，不再提供页面固定/管理向导。

使用 `plugins layout/configure` 即可由 Chat/Bot/HTTP 写入相同导航；保存仍需原文与 revision CAS。导航复用全局目录订阅，不为每个入口加载 React/HTML 视图或增加轮询。账户退出/切换同步清空旧快照并拒绝迟到结果。

`window.board` 继续可用；`window.plugin` 增加以下接口：

```js
const context = await plugin.context.get();
const before = await plugin.state.read();
await plugin.state.write({ ...before.data, count: 1 }, before);
const off = plugin.events.subscribe('state.changed', reload);
await plugin.draft.write({ search: '未提交文本' });
const draft = await plugin.draft.read();
```

生命周期事件：mount、contextChanged、visibilityChanged、dispose。沙盒按包来源、实例、挂载与精确 view 隔离，切换身份重新挂载，不复用上一份内容的画面。主题首帧注入并实时同步；容器宽度按 iframe 实际尺寸提供，同身份内不因主题、尺寸或无关布局变化重建。上下文含 revision，异步操作必须捕获原 resourceId，不把旧结果写入新资料。

任务接口沿用 `tasks.start/get/watch/wait/open/cancel`。服务端重新校验账户、实例、包修订及能力；watch/wait 只是页面订阅。服务端调度以实例为单位，而不是以挂载为单位。插件停用仅停止新调度，已运行任务按自己的状态完成。

## 服务端入口

- `GET /api/v1/plugins`：包、冲突诊断、布局文档（含修订与完整内容）。
- `POST /api/v1/plugins/layout`：`content/expected/revision` CAS。
- `POST /api/v1/plugins/:id/lifecycle`：账户级 `source/status/expected/revision`；持久卸载墓碑与显式恢复。详见 [可插拔契约](pluggability.md)。
- `GET /api/v1/plugins/:id/views/:view`：受控 HTML 与包修订。
- `POST /api/v1/plugins/:id/instances/:instance/rpc`：`revision/method/args`，每次重新解析权限。
- `POST /api/v1/plugins/:id/instances/:instance/actions/:action`：命名动作；manifest 只选择宿主已有处理器，最终 schema/权限由宿主决定。
- `POST /api/v1/plugins/tool`：Web Chat、native Chat、Bot 共用 `plugins` 工具协议：`list / describe / layout / configure / invoke / reference`。describe 按需返回完整宿主 schema，configure 复用布局 CAS，invoke 按命名动作路由。Bot 写操作仍走原 read/write 策略与审批；native 调用需 allow，不能将 ask 当成授权。
- 通用 system files、Bot notebook 与 native Chat board 工具读取同一目录。原看板 API 保留。

所有写入复用 SystemFiles 的 SQLite 意图日志、原文比较、原子替换及崩溃重放；内容哈希修订不是递增计数。服务声明绝不是授权；未知方法拒绝，不回退为任意资源调用。

## 注册器

`packages/contracts/src/plugin-registry.ts` 不依赖浏览器。注册返回幂等 disposer；provide 拒绝重复名/非法版本；requires 按最低接口版本解析，缺失时可恢复；卸载依赖释放下游 effects，重新提供后重挂。optional 通过 get 读取，不阻止启动。任务持久性不绑定 provider disposer。

包 manifest 的 `requires / optional` 以**包 ID → 最低已发布主版本号**描述依赖（例如 `{"counter":1}`）；这与宿主代码注册器的服务接口版本分别管理。目录发现会在来源冲突消解后，用注册器解析启用包依赖：缺失、停用、版本不足或循环 required 依赖产生 `plugin_dependency_unavailable`，附 `dependencies.required`；optional 缺失只报告 `dependencies.optional`，不阻塞。恢复 provider 后下次目录快照自动恢复动作和挂载。依赖不会授予被依赖包的权限，也不会允许动态包执行服务端代码。非数字/0.x 版本不能满足要求最低 1 的已发布依赖。

## 已交付学习领域适配

- `flashcards`：生成使用原 native cards 执行器、默认 Gateway；解析资料使用 materialBlocks，视频使用 segments。读写仍是原 `cards` CloudRecords。已存在卡片需显式 replaceRevision；生成提交前再次 CAS，保护期间的审核与修改。
- `practice`：AI 练习复用 modelOnce 的受信任务关联分支；输出答案强制标为 ai。原题从实际 Markdown 读取，保存原 `chats.quiz` 历史快照，保留题库 path/offset/revision。Markdown 原资料含 quiz 块时直接使用 `/material`；否则读取 `questions.md`，原资料的无效 quiz 块不能被另一个题库掩盖。自定义输入继续使用 QuestionInput 隔离 iframe，不下发答案键。
- `review`：读取原 wrongbook Markdown/FSRS 与卡片审核记录；开始复习保存原 chats 快照，再提交时沿用原 questionId，不能新建一套复习清单。首次作答与主观自评分开，已提交答案不能覆盖；AI/missing 不入分数或错题本。
- `material-tools`：`handout / comments / danmaku / transcribe / material / cover` 命名动作映射到原 Cloud 任务。宿主从可信资料解析 format、videoId、执行位置，不接受任意 input/owner/path；nonce 同时绑定实例、动作和原参数。Markdown/Word 解析、文字资料讲义及评论/弹幕使用原 native 执行器；视频讲义、转写、PDF 解析、封面仍需浏览器。任务来源持久记录在同一关联表，状态不冒充所有产物已成功生成。

原 Web 流水线的远程分支通过 `plugins/legacy-actions.ts` 复用命名动作，CAS 创建/复用资料实例，等待**同一任务**，不二次提交。封面的 force 默认值及用户手选封面保护保留。cards 重新生成显式确认并提交 replaceRevision。本地/浏览器 worker 分支仍是原执行器，但分别通过本地安装配置与服务端已受理快照准入，不能静默绕过停用；详见可插拔契约。

旧阅读问答的“出题考我 / 提取原题为题库 / 开始做原题 / 错题与复习清单”在云端模式通过 `useMaterialPluginView` 打开注册视图，CAS 复用资料实例；不导航、不发送提示词，也不清空原聊天草稿。停用或更新时撤销旧弹窗。离线模式保留原出题/原题提示词入口。

`practice.extract`（命名动作 `extract`）只接受 materialId/clientNonce，由宿主建立绑定资料的原 QA 会话和持久任务，nonce 重放返回同一任务，不允许并发重复提取。执行明确为 **browser**：复用原 QA 的技能、read/edit、图片工具和精确编辑/CAS，不把 native QA 的只读能力冒称为可提取保存。浏览器离线时排队，重新在线后按原 lease 机制执行；模型轮次的完整覆盖由原技能报告，不保证全文已提取。原工具授权继续生效，动态 HTML 包无此 trusted-only 能力。

题库收据由服务端启动恢复/定时投递：工具持久检查点确认实际成功 edit、权威 Markdown 相对发起时已变化、题库解析及资料来源校验通过，才保存 path/revision/count/sessionId 等引用。仅 completed 或模型声称成功不算产物；错误通过 learning.results.deliveryError 查询。count 是当前题库总数，不是本次新增数；已保存部分可打开题库，不能等同全文覆盖。投递不重写题库、不复制题目、不改已有作答快照。

生成任务来源、持久产物收据与提交投递队列只保存引用/操作元数据。cards 或练习快照提交与产物收据在同 SQLite 事务；登记由启动恢复和服务端定时重试完成，不依赖页面 watch。错题 Markdown 的 blob 指针与派生索引 CAS 提交；已映射的错题本通过 ResourceFiles.saveText 更新原项目文件。失败可查询，恢复服务后幂等补投；API 关闭先等待当前投递。

原执行器在服务器重启时把运行中模型任务标为 interrupted，不承诺自动续跑模型调用；已提交产物和收据可以恢复。模型 fixture 验证软件行为，不代表实际生成质量。

## 上下文操作与消息引用

`contributions` 是按 ID 索引的原生控件声明：title、surfaces，以及二选一的 viewId/actionId。仅支持 chat.composer.actions、reader.selection.actions、resource.actions；ID 不得与 view 重名。viewId 打开宿主 dialog；actionId 调用宿主 schema 校验的命名动作。可声明固定 args，contextArgs 仅允许 materialId、selectionText、clientNonce，不求值代码或任意模板字符串。挂载的 viewId 此时填写 contribution ID。布局控制顺序/范围/隐藏；停用、包更新和依赖失效撤销贡献。

宿主固定打开时的资料、选区与 revision；切换上下文关闭旧视图，迟到操作只绑定原资料且不向新上下文显示结果。输入区保留原聊天草稿。内置学习包提供打开视图贡献，可由管理面板挂到上述位置。

`plugins reference` 返回 `{reference, markdown}`，Markdown 使用 `wbw-plugin` JSON 围栏，包含 apiVersion、pluginId、instanceId、viewId、revision、summary。Chat/Bot 共用 AssistantContent 解析；历史正文持久保存摘要。只有包修订匹配、实例仍可访问、用户展开且在可视区域时才挂载插件；收起/离屏卸载。卸载、更新或停用后仅保留摘要与当前实例链接，不执行旧包代码。引用不是会话权限凭据。

完整可安装示例见 [templates/README.md](templates/README.md)；实际执行证据见 [acceptance.md](acceptance.md)。
