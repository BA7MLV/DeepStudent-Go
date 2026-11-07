# 聊天内页面生成与展示

## 一条交付链路

- 小页面继续 `show_widget(format="html", code=完整源码)`，无需额外动作。
- 服务端沿用 `executeServerWidget` 的校验和 WidgetPayload，调用方在回执成功前保存到原聊天行；回答引用仍用 `wbw-widget`。不增加独立作品、草稿、资料或发布历史。
- 页面使用已有代码卡，由用户点击「预览」才挂载既有沙箱。CSP、资源白名单、opaque origin、状态桥和渲染检查不变。已打开预览在回答完成或引用回显时不重挂载；刷新后重新点击。
- 撤回本轮新增的「保存到资料（源码）」按钮及源码导出模块，不改变项目原本的资料能力，也不自动把页面写入资料。

## 大页面：当前任务内存组装

仅原生任务的 `show_widget` 额外声明 `action` / `revision` 等组装参数，没有第二个草稿工具。只有实际 schema 声明的路径可以使用；浏览器的基础工具仍只支持完整源码，不宣传未实现动作。

所有动作共同字段是 `format="html"`、`action`、`code` 和 `revision`（read 可以不传 revision）。其他只允许以下动作字段，未知字段和组合一律拒绝：

- **append**：`offset` 必填且等于最新 length，`code` 为完整的一小段，首次可传 `libs`。首次 revision=0、offset=0；每段 1~6000 UTF-16 字符，建议 1000~2000。
- **read**：`code=""`，`offset` 为读取起点，`limit` 可选（默认2000，范围1~4000）。省略 revision 获取当前基线，传入则必须匹配。返回 `revision/length/offset/content/nextOffset`，没有待组装源码时也可查询空基线。起点不可切开代理对；末端自动收缩，limit 太小无法读完整字符时报错，不返回无法前进的分页。
- **patch**：`code=""`，`edits:[{search,replace}]`。每批1~20项，search 非空且在**同一原文中精确唯一**匹配，全部范围无重叠；用保留唯一锚点的 replace 插入，用空 replace 删除。禁止模糊匹配、猜位置和顺序替换。search+replace 合计≤6000 UTF-16 字符，序列化 edits JSON≤40000字符（含转义/结构开销），建议1000~2000并按实际 token 预算缩小。拒绝空结果、无变化和无关 edit 字段。
- **complete**：`code=""`，`offset` 必填且等于最新 length。才把整页交给原有校验和聊天保存/引用链路。失败保留待组装源码及版本，可 read/patch 修正；此前已交付页面不变。
- **discard**：`code=""`，无额外字段。清空当前组装。任意时刻也可不传 action 直接完整源码调用，互不覆盖；直接调用不得夹带组装字段。

append/patch/complete/discard 均必须传**当前 revision**，成功后递增（包括清空和成功完成），不归零；失败及 read 不改变内容或版本。等长修改后旧 append、patch、complete、discard 也拒绝。无持久幂等回执；回执丢失先 read 获取基线，不盲重试。完成回执保留原引用文本，后附 JSON：`{"status":"completed","revision":新版本,"length":0,"offsetUnit":"UTF-16"}`；append/patch 为 `assembling-not-runnable`，discard 为 `discarded`。这些 revision 是组装版本，不是聊天 WidgetPayload 的修订号。

同一模型轮的多个调用按执行顺序逐一校验/提交，不是整轮事务；连续写操作须分别使用依次递增的版本，同版本后续写会冲突。**一个 patch 批次内部**才是原子操作：复用 `applyArtifactReply(source,{edits},'patch')` 的纯算法，匹配、唯一性、重叠、所有参数及输入大小、Unicode 和最终60k上限检查全部通过才提交。已有 artifactEdit 的120k上限和语义不变，不能用它放大 HTML 组装上限；生成中可以不完整，补丁本身不运行或交付页面。

每次执行器调用只有一个有界内存缓冲；不跨 owner、会话、任务或执行器共享，不写独立文件、专用表、幂等日志或发布版本。完成成功后清空缓冲。取消、失败、服务重启或任务挂起恢复后不保留未完成组装，新执行器从 revision=0 开始；已有任务消息/工具轨迹不是跨任务恢复契约。通过既有 checkpoint 恢复时明确提示内存组装丢失，不重放旧补丁。此能力只修正当前组装，已展示页面仍用原 artifactEdit，不支持聊天跨消息自动修改。

示例：append `"<div>旧</div>"`（revision=0、offset=0）→ 回执 revision=1、length=12；read 获取同一基线 → patch `[{"search":"旧","replace":"新"}]`（revision=1）→ revision=2、length=12；complete（revision=2、offset=12）→ 聊天引用及空缓冲 revision=3。清空后再 append 必须用 revision=3，而不是0。

这是兼容三协议的普通函数工具和精确字符串补丁，**不是** OpenAI Responses 原生 `apply_patch_call` / V4A，不增加原生协议适配或 SDK。校验成功前不把 pending 或工具参数流作为 HTML 预览：参数字段顺序不可靠，code/search/replace 可能先于 action 到达，故原生执行器不再发送工具 delta 的静态预览，完整校验交付后仍需用户点击沙箱预览。

已撤销新增三个专用表的创建和访问代码。开发数据库若已有这些表，保持原状、停止使用，不 DROP、不迁移、不删除已有聊天数据；新数据库不创建这些表。

## 输出预算与独立渲染上限

- 区分模型声明、用户配置和未知回退来源。未知模型的 8192 是保守政策回退，不是已知模型硬上限。
- 每轮使用完整三协议请求体保守估算输入空间，并为输出留余量；这不是精确 tokenizer。空间不足明确 `context_capacity_exceeded`，不压成 1 token 继续请求。
- 工具输出截断时整批调用均不执行，包括看似合法的 JSON。丢弃不完整参数信封和供应商 continuation state，不续接或修补 JSON。已确认的本任务内存 revision/length 不变，下一轮缩小完整 append 或 patch，可 read 定位，不要求重写整页；只有已知余量足够时允许一次有限提高预算。最多三次截断后停止，不无限原样重试。
- 正文截断最多两次无工具自动续写，过滤精确回放，失败保留已输出正文供显式续写；不会通过正文续写重放旧工具。
- 源码仍限 60,000 UTF-16 字符，最终运行文档仍限 320,000 字符（含宿主桥及内联库）。分段不能绕过这些限制，也不能突破模型 token 上限。
- 工具循环最多 64 轮，仍受原有任务步数、请求额度和超时约束；不承诺任意页面一次任务必完成。

## 验证

2026-11-07 本轮实际结果（测试中的外部模型均为协议夹具）：

- 通过：API/Web 构建及类型检查，24项预算/组装单测，三协议服务端聊天/QA及原 artifactEdit 补丁入口回归，Chromium/WebKit 聊天/QA端到端（含read/patch后的完整源码及原编辑面板开合不自动请求），`npm run test:widget-feedback`，UI audit（含模型设置 hideWhenClean），`git diff --check`。
- 组装覆盖：精确唯一替换、锚点插入/删除、同原文批次、无匹配/多匹配/重叠/无变化拒绝及原子失败、等长修改后旧版本拒绝、清空/完成后ABA拒绝、任务隔离、Unicode/读取边界/60k上限、complete失败后read/patch修复、三协议截断patch整批零修改、action后置的流式参数不预览。
- 未通过的旧测试：`npx tsx scripts/test-artifact-edit.mjs` 在持久化阶段缺少登录态，报 `client_unauthenticated`；之前的纯算法断言已执行通过。本轮不改变其存储/认证路径；原生artifactEdit的三协议入口另已验证通过，不声称该旧测试全绿。
- Chromium端到端并行运行时有一次计数器点击后仍为0、等待1超时；单独重跑完整路径通过，保留为间歇时序风险，未删除或放宽断言。服务端集成新增流式测试首次因会话ID复用撞上后续内容过滤用例，改用独立ID后全过。仍有既有CSS/依赖注释/导入构建警告、Node localStorage实验警告及Vite代理socket `ECONNRESET`日志。
- 未全量验证真实外部模型；模型设置完整E2E本轮未重跑。此前模型发现9项失败和设置完整E2E cleanup挂起未宣称解决。

- `npm run test:server-widgets`：API 构建、预算与内存组装单测、三协议聊天/QA 回归；包含完整小调用、多轮大页面、截断零写入、任务重启不继承缓存以及没有专用表的断言。
- `npm run test:server-widgets:e2e`：API/Web 构建和 Chromium 真实聊天/QA 链路，仅外部模型为夹具；用户点击预览、刷新状态、回答完成不重挂载及原消息续写。
- `BROWSER=webkit npx tsx scripts/e2e-server-widgets.mjs`：同一端到端的 WebKit 路径。当前 macOS WebKit 临时上下文连独立 Blob 写入也会失败，使用测试结束后清理的一次性持久化 profile；导航前等待顶层和远程运行时 iframe 轮询结束，不过滤网络/CORS 错误断言。
- 未全量验证真实外部模型。既有模型发现测试的 `server_model_connection_required` 失败，以及模型设置全 E2E cleanup 挂起问题，不属于此改动解决范围。
