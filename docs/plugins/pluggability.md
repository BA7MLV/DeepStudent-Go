# 全功能可插拔契约

## 包与执行边界

当前功能包：`flashcards`、`practice`、`review`、`material-tools`，以及原文件包 `todo`、`pomodoro`、`tasks`、`schedules`。它们使用同一目录发现、来源选择、安装状态、依赖解析、实例与挂载协议。

- 原生 manifest 分别位于 `packages/contracts/src/learning/{flashcards,practice,review,material-tools}.ts`。
- 原生服务分别由 `apps/api/src/plugins/providers/` 注册；`registerProvider` 收集该模块的动作 disposers，退出后实际撤销处理器。`providers/index.ts` 是编译期白名单，不是文件包代码加载器。
- 前端每包在 `apps/web/src/plugins/providers/*.provider.ts` 声明 lazy 视图；宿主扫描描述文件，通用路由/页面不按新插件 ID 分支。停用后宿主卸载视图，其 subscriptions、observer 和 iframe 生命周期由原有 cleanup 释放。
- 文件包仍仅执行受 CSP 与 sandbox 限制的 HTML/JS；不能加载任意服务器模块、取得宿主 DOM 或升级为受信 React。编译期原生包的代码仍在部署产物中，账户卸载不等于删除整个进程的代码。

## 安装、停用、卸载和删除

`/system/plugin-layout.json` 的 `installations` 记录 `source:id → enabled | disabled | uninstalled`。账户目录独立，使用原 SystemFiles 意图日志、原子写与 `expected/revision` CAS。未明确操作的新包遵循 manifest 的初始 enabled；明确状态优先于默认种子和 manifest，卸载墓碑不会在刷新、服务重建或包文件重新出现时自动消失。

1. **隐藏入口**：仅移除一个 placement；不撤销包的其他挂载、动作或原实例。
2. **停用**：撤销该账户的新业务调用、菜单贡献、视图、依赖服务和未来调度。保留实例、挂载引用与领域数据。
3. **卸载（保留数据）**：持久 `uninstalled` 墓碑，同样撤销执行。保留包描述/文件以便明确重新安装；原生代码不从另一个账户或全局进程卸载。
4. **重新安装并恢复/启用**：显式改回 enabled，依赖满足后原实例与仍兼容的挂载恢复。不会重发模型任务、复制作答或重新创建一份错题本。
5. **删除业务数据**：是原资料/记录管理中的独立明确操作；创造模式不能把“卸载”偷换为删除学习历史。原包文件可在系统文件管理中单独删除；要恢复动态包必须先恢复有效文件，再明确启用。

创建与管理入口统一为聊天的 **技能 → 创造模式**。日常页面不再提供手动添加、挂载管理向导或页面固定按钮，只显示简短使用指引。指引没有副作用，不自动发送、不替换草稿、不改变会话技能范围。已有功能界面、侧边栏、手机导航抽屉继续使用原宿主；配置工具与共享目录/lifecycle 仍保留。

## 创造模式与侧边栏页面

1. 打开聊天的技能选择器，选择“创造模式”，再发送自然语言需求，例如“做一个持久计数器，放在左侧侧边栏”。选择技能本身不发消息，也不扩大当前会话的可用范围。
2. Chat/Bot 从真实目录发现已有功能、内容和作用域，优先复用；需要新功能时，用现有 Web read/edit、native board 或 Bot read/edit 写持久 HTML 包。先视图/默认值，最后 manifest，重新发现有效包后才挂载。
3. 可以继续说“把这份内容也放到聊天右侧，共用内容”“另建一份独立待办”“重命名为每日计划”“从侧边栏移除”“停用/恢复”。实例、精确 view、位置、导航和 CAS 内部处理，不要求用户填写技术 ID。
4. 生成的实际功能使用宿主 `window.plugin` SDK、语义主题与窄栏布局。临时交互讲解仍属于 `show_widget/window.__wbw`，不会因展示一个作品就宣称已安装长期工具。
5. 只有真实工具核验文件、包和布局后才能报告完成并给实际页面链接；没有浏览器能力不声称视觉验收。技能不授权任意服务器脚本、trustedOnly 方法、修改宿主 React 或绕过原审批。

添加到侧边栏后，桌面左侧导航出现，手机从现有导航菜单访问。移除入口不删除内容，恢复复用原实例；只有明确要求独立使用才新建实例，不复制实时旧状态。

标准资产：[create-mode/SKILL.md](../../packages/study-core/assets/builtin/create-mode/SKILL.md)，附 tools-and-layout、runtime、design 三份按需 references。云账户实际路径 `/system/skills/create-mode/SKILL.md`；Web 的逻辑读取路径 `/skills/创造模式`，参考路径以激活/读取返回值为准。Web/native/Bot 使用同一资产，禁用及会话 allowlist 继续生效；不是 OpenCode harness 技能，也不常驻全局 system prompt。

侧边栏不是浏览器私有收藏：共享布局的 `navigation` 明确引用 `app.page` placement，后者绑定所选 view 和 instance，复用账户归属、CAS、持久存储与范围校验。HTTP/Web Chat/native Chat/Bot 的 configure 保存同一配置，其他客户端订阅后生成同一导航。可打开完整页不等于自动加入导航。停用、卸载、依赖丢失、来源冲突、项目归档/回收站会隐藏不可用入口；恢复后沿用原引用和内容。

首次发现资源文件时，资源菜单动作会等待共享目录确认资料归属后出现，避免以不完整上下文打开、随后又关闭视图；无需反复点击或重新添加。正常目录刷新保留已打开且仍有效的视图。

HTTP：`POST /api/v1/plugins/:id/lifecycle`，参数 `{ source, status, expected, revision }`。`plugins` 工具的 `lifecycle` 操作接受 `pluginId/status/expected/revision`，对当前选定来源执行；与 configure/invoke 一样属于 **write**，不能绕过 Chat/Bot 的策略与审批。

## 每次调用重新授权

原始 RPC 与命名动作、Chat/Bot 工具都通过 `PluginService.resolve`：

1. 当前账户的包已启用、无来源冲突、依赖可用，实例与项目/资料授权有效。
2. 宿主确实注册了方法，包修订相符，参数通过**宿主** schema；包提供的宽松 schema 不能降级校验。
3. `state/tasks/schedules` 的标准 SDK 保留原协议；其他业务方法必须被调用包 `actions[*].service` 显式列出。
4. 学习领域存储必须声明 `services: { "learning-data": 1 }`。未知或版本不足的宿主服务进入 `plugin_service_dependency_unavailable`。
5. 若方法归另一个原生 provider 所有，还必须声明 `requires: { "提供者包ID": 最低主版本 }`，对应原生 provider 在该账户实际可用，并有该方法的激活句柄。相同 `learning` capability 不等于拥有所有学习方法。
6. `trustedOnly` 仍只允许编译期原生包：动态 HTML 即使声明依赖也不能读受信练习快照或调用练习提交/提取能力。

`review` 明确 required `practice:2`；后者停用时复习消费者进入可恢复不可用态。复习可以读取原卡片审核元数据，不依赖卡片生成执行器；这种共享数据查询与调用已停用的生成动作不同。

账户激活 registry 只持有该账户的服务句柄，按目录快照更新并释放旧句柄；不通过全局卸载实现账户开关。原生 provider 的进程级 disposer 用于代码注册退出，另外有专项重复释放/重新注册测试。持久投递服务不挂到这些句柄下。

`GET /plugins` 的可调用服务及工具 list/describe 过滤实际可用方法。停用包仍出现在可管理目录，但工具动作、视图和贡献为空。Bot 的旧 `study_task` 创建种类随账户状态收紧；执行时再次校验。旧 `/board/plugins/:id/rpc` 与 HTML 加载也遵循统一安装状态，不能从旧看板入口绕过。

## 旧 UI、本地、离线与任务

- 旧卡片生成/审核、讲义、评论、弹幕、字幕、封面、资料解析及讲义模型改写，在接纳新工作前检查原包；远程生成继续转同一命名动作。`/cloud/tasks` 与 Bot `study_task` 的旧派发入口也检查相同包，不能直接提交旧任务 kind 绕过插件。
- 旧阅读按钮随目录状态禁用；练习/复习菜单同样禁用。`present_quiz` 工具发现过滤及实际工具执行均检查 practice；历史卡片、题目、答案结果、消息摘要仍然可读，卡片可导出。
- 未启用云账户时，本地内部配置使用同源 `wangke:local-plugin-layout:v2`。**本地配置独立于云账户，不自动继承或覆盖任何账户开关**。云账户启用后每次新工作读服务端目录，网络不可达则拒绝，绝不自动退回本地默认 enabled。离线时可以读缓存历史，但不能以离线为由绕过已登录账户开关。
- 本地原生管道使用该本地配置准入，不递归派发服务器任务；本地配置的 storage 事件更新其他同源标签页。云插件视图/挂载与持久云任务本身仍需云账户；没有真实云文件工具时，创造模式只能交付未安装草案，不能冒称完成。没有新增本地配置 UI 或离线安装能力。
- 浏览器 Worker 不按当前开关中断已受理任务：服务端接纳任务时写 `_pluginProviders` 快照，覆盖客户端伪造值；Worker 仅在该任务生命周期中使用快照，结束即清除。新任务仍需当前启用状态。快照不授权任意 RPC、项目或模型策略。
- 停用/卸载不是取消任务。已受理任务按原 queued/running/waiting/failed/cancelled/interrupted 生命周期推进。原执行器、任务 lease、权限审批、重启中断语义不变。产物收据、原题提取保存确认和错题投递由宿主持久协调服务处理，不依赖页面或包保持挂载。
- 收据以原任务 ID、提交以原操作/题目身份去重；恢复只读同一权威 cards、chats.quiz、Markdown/FSRS。不能据任务 queued/finished 冒称模型产物或全文提取已成功保存。

## 替代实现与兼容性

可复制 `docs/plugins/templates/cards-reader/` 到 `/system/plugins/cards-reader/`。它使用另一套纯 HTML 展示，以显式 `flashcards:2` 依赖调用同一个 `cards.list`；无新业务页面分支、无复制权威卡片、无生成权限。它在 board/chat/reader/完整页使用同一挂载协议；停用 flashcards 后消费者不可用，启用后读取原产物。

同 ID 多来源必须在布局中明确选定 `sources[id]`，未选来源不能执行。保存新挂载时检查视图 ID、surfaces 与范围，required 依赖检查最低主版本；不兼容挂载保留引用但不会强行运行。动态实现不能通过同 ID 选源伪装成 native，不能替换一个原生 provider 的受信执行权限。若自定义实现的数据结构不兼容，应使用新实例/显式数据转换，而不是暗中迁移原状态。

## 可复现验证

- `npx tsx scripts/test-plugin-pluggability.mjs`：八个默认包分别挂三处、调用、停用、卸载、服务重建及实际 API 重启恢复；独立账户；未声明 raw RPC、命名动作、HTTP 工具、Bot/native 工具与旧 API 拒绝；声明依赖与替代实现；已受理生成在卸载后真实写回 cards 与唯一收据；已受理错题在卸载后投递且恢复不重复；原生注册 disposer 幂等与重新注册。
- `npx tsx scripts/e2e-plugin-pluggability.mjs`：真实 Chromium 工具调用停用/卸载/恢复，消费者卸载、直达页失效、旧 CardsPanel 禁用但历史可读/导出、本地管道/Worker 准入、可复制替代 HTML 实现、1440/390/360 三尺寸与 light/dark/auto 三主题截图。已移除的手动向导不再作为产品必需。
- `npm run test:create-mode`：三端同一资产、按需 refs、显式激活、停用/范围、Bot/native 写包及 deny、不授予权限；写入后发现与 CAS 冲突后重读的循环护栏。
- `npm run test:create-mode:e2e`：可控模型通过真实 Web agent/tool 创建动态包→侧边栏→刷新→共用聊天侧栏；CAS 冲突保留其他客户端修改，真实持久状态、多 view、生命周期、账户切换和手机导航；技能选择不发消息、不丢草稿、不改范围。
- 原插件平台、学习、资料动作、原题提取、项目隔离、共享状态及调度回归继续作为软件不变量验证；完整浏览器回归包含持久任务、贡献点、原题/多题型和跨位置学习闭环。
- `npx tsx scripts/e2e-plugin-action-context.mjs`：真实资源扫描建立资料归属，控制目录旧快照的到达顺序，验证未确认上下文不暴露动作、确认后打开正确资料、正常刷新保留对话框；不替换动作执行或 RPC。
- `npm run test:plugins:bot-template:e2e`：使用未修改的可复制 Bot 模板，真实完成后连续五次刷新与四次语言切换，检查持久请求恢复始终指向同一个 run，不依赖旧 iframe 回调。

验证使用独立临时目录与可控模型 fixture；不是付费模型质量、多台物理设备或生产部署验收。截图位于系统临时目录的 `opencode/plugin-pluggability-screenshots/`。实际执行结果见 `acceptance.md`，不能以测试清单代替通过证据。
