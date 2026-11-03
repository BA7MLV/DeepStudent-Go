# 插件实施验收记录

本文件记录本轮**实际执行**的软件验收。父会话复核发现原项目范围未完成，已重开步骤 3–8；项目补齐后的最终状态以计划勾选与新增证据为准，旧“8/8”结论不作为项目验收证据。不将可控模型 fixture 的行为验收冒称为真实模型质量验收。所有修改留在当前 main 工作区；未提交、推送、部署，保留其他并发工作的改动。

## 最新方向：应用内创造模式（2026-11-03）

本节是当前交付；后文的手动向导截图和点击记录仅为上一轮历史证据，不代表当前入口。产品入口现为 **聊天 → 技能 → 创造模式**，标准资产 `packages/study-core/assets/builtin/create-mode/SKILL.md`，账户物理技能路径 `/system/skills/create-mode/SKILL.md`。三个 references 按需加载，不常驻全局 system prompt。Web/native/Bot 使用同一资产，保留禁用、allowlist、显式激活及原权限边界。

已通过：

- `npm run build`：四包构建与 i18n/边界检查通过；既有第三方 CSS `:is()` 和混合动态/静态导入警告仍存在。
- `npm run test:create-mode`：三端技能/refs、显式激活、空/自定义范围、禁用与账户隔离；真实 Bot edit/native board 创建有效包；deny 仍拒绝，激活不修改权限。循环护栏允许写资产后重新发现、CAS 冲突后重读及配置后验证，但不允许重复写入或失败 edit 绕过。
- `npx tsx scripts/test-builtin-skills.mjs`、`npm run test:skills`、`npx tsx scripts/test-skill-catalog.mjs`、`npx tsx scripts/test-skill-files.mjs`：资产格式、预算、目录/真实读取、引用、持久化、升级保留、历史复用/压缩、范围和 native 激活通过。课程讲义现有的“目录名称、字幕与帧描述不是图像证据”语义保持不变，测试不再依赖旧的逐字短句。
- `npx tsx scripts/test-agent-guard.mjs`：原 17 项循环护栏回归通过。
- `npm run test:plugins`、`npx tsx scripts/test-plugin-pluggability.mjs`、`npx tsx scripts/test-plugin-projects.mjs`：真实服务/文件协议、生命周期、所有者/项目/资料隔离、原始管道/HTTP/Bot/native 准入、依赖、已受理任务、墓碑恢复通过。
- `npm run test:plugins:learning`、`npm run test:plugins:materials`：原学习权威服务、判分/自评/FSRS边界、历史快照、原 Markdown 投递和持久收据、替换 CAS 与资料处理插件回归通过。
- `npm run test:create-mode:e2e`：可控模型经真实 Web agent/资源工具在默认 6 轮内写 HTML/defaults、最后发布 manifest、重新发现并配置侧边栏；跨刷新及两个客户端复用聊天侧栏、真实 CAS 冲突重读保留他人修改、错误不报成功、独立默认内容不复制实时状态、双向隔离、名称/顺序/移除、精确多视图路由、停用/卸载/恢复和账户切换全部通过。三尺寸×三主题及手机导航截图在 `create-mode-screenshots/`。
- `npx tsx scripts/e2e-plugin-pluggability.mjs`、`npx tsx scripts/e2e-plugin-projects.mjs`、`npx tsx scripts/e2e-board-plugins.mjs`：无旧管理向导，原八包及替代包的真实工具配置、生命周期、共享与范围隔离、恢复、历史只读/导出、Worker/本地边界、主题及未提交草稿保留通过。
- `BASE_URL=http://127.0.0.1:5193 node scripts/e2e-skill-picker.mjs` 与 `e2e-settings-skills.mjs`：六任务入口、自定义/空/历史范围、搜索保留选择、键盘和窄屏、读取失败重试、技能管理新建/取消/编辑关闭通过，无浏览器错误。创造模式闭环另验证选择技能不会发消息、丢草稿或扩大范围。

未通过的完整回归：`npx tsx scripts/e2e-plugin-platform.mjs` 在复习完整页初次加载（第186行）再次出现历史整页空白并超时。对应页面 `readyState=complete`、无 pageerror、无失败/待完成请求；观察到 cloud-sync 锁等待后已获得并释放，尚不能判定因果。证据位于临时目录 `opencode/plugin-platform-screenshots/{page-failure-6.json,network-failure.json,failure-page-6.png}`。脚本保留失败，不跳过断言，另补 root HTML、账户状态与 Web Locks 快照便于后续定位。本节专项通过不代表完整学习浏览器回归全绿。

随后单独重跑（`SCREENSHOT_DIR=…/opencode/plugin-platform-final-screenshots`）本次未出现空白，继续通过混合题型、动作贡献、跨客户端离线恢复、历史引用及模板笔记后，在原题提取任务最终状态断言失败（第417行：`failed` 而非 `completed`）。页面显示“模型已保存部分”及 `worker_mutation_denied:studyDays:missing_permit`；这不是完整提取成功，根因仍待核查，不放宽 Worker 许可或删除断言。该轮截图、网络与页面/账户/锁快照保留在上述独立目录；未执行到后续服务重启及整套截图验收。上一轮空白亦不因本次未再现而视为修复。

本轮发现并修正：原 Web 循环护栏把写包后同参数 `plugins.list` 误判为无进展重复，导致无法实际完成重新发现；现仅在相关成功修改或布局冲突后撤销发现读取指纹，重复写入仍受保护。同包页面切换实例时也会复用旧 iframe，现以来源/实例/挂载/精确 view 标识隔离生命周期；同一标识内主题、尺寸和无关布局更新不重建 frame，草稿继续保留。

验收使用一次性账户、数据库和可控模型；证明真实工具链及持久产物，不证明付费模型的技能遵循率。没有调用真实付费模型，没有真机 iOS/Android 或物理多设备验收。历史偶发整页空白未确认根因，不宣称已修复。所有更改未提交、推送或部署，并保留并发技能/聊天等改动。

## 前轮历史验收

- `npm run test:plugins:e2e`：真实控件配置；同一待办跨看板/Chat/reader/page 同步、独立实例隔离；真实 native fixture 卡片生成及审核；AI 练习来源提示；原题 Markdown 历史快照和错误作答跨位置同步；review 再作答把原记录从一次更新为两次；刷新及服务重启恢复。
- 同一浏览器脚本覆盖 360/390/1440px × light/dark/auto。独立学习页额外保存 27 张截图，避免手机看板组件在首屏下方造成“截图存在但没拍到学习组件”。已人工查看 360 深色练习、390 浅色复习、1440 深色卡片截图，内容可读且页面没有横向溢出。
- `npm run test:plugins:learning`：原 cards/practice 执行器；schema/owner/material 隔离、nonce 参数绑定、覆盖确认和提交时 CAS；实际原题 Markdown 及旧快照不重算；重复提交不双写；review 保留原 questionId 和历史 attempts；主观题先作答再自评且不得改答案；多选顺序无关判分；AI/missing 不进入 FSRS。wrongbook 普通 blob 与 ResourceFiles 映射分支均验证重启重放；缺少资源服务时投递失败可见，恢复后写原项目文件且不创建 competing blob。
- `npm run test:plugins`：注册器生命周期；真实目录 required/optional/循环依赖、停用/恢复 provider；v1 别名；origin/CAS/owner/实例隔离；HTTP/Bot/native 的 plugins 发现、宿主 schema、调用与布局冲突，native ask/deny 拒绝，Bot 不绕过原审批。
- 最新完整 `npm run build` 已通过，包含资料处理插件及旧远程流水线适配。既有第三方 CSS `:is()` 压缩警告及静态/动态混用提示仍在，未声称消除。
- 扩展 `test:plugins:e2e` 已通过输入区打开/关闭组件后草稿不变、阅读选区贡献弹窗、安装 counter 模板、独立浏览器 context 的共享状态读写、断网后重连读取最新状态；真实持久 Chat 消息中的插件引用默认不运行、手动展开/收起，以及包更新后的历史摘要保留。独立 context 是设备隔离模拟，不是真实多台物理设备。
- `npm run test:system-files` 最新整套通过：system files、skill files、notebook tools、agent instructions，包括 CAS、重启恢复、账户隔离和原工具审批。
- 学习领域专项新增 `/material` 原题 Markdown 优先级、无效原文不隐式回退、编辑后原快照不变，已通过；资料动作专项已通过真实 native 讲义/评论/弹幕/Markdown 产物及停用撤销。
- 完整扩展 `test:plugins:e2e` 已通过：material-note 保存/刷新/尺寸草稿/A-B 隔离、Bot 模板真实 run 与刷新 nonce 去重、资源菜单、长聊天离屏卸载、旧练习/复习菜单草稿、资料动作视图及旧 runHandout。多选/填空/判断/主观自评/排序/配对/缺失答案/组合题均实际作答；原图解码、KaTeX、自定义输入 iframe 答案隔离及刷新后的标准输入回退通过。
- `scripts/test-plugin-extraction.mjs` 已通过：原浏览器 QA 路由、宿主资料会话、owner/material/schema/nonce、并发提取排斥、题库实际修订与工具保存双重确认、仅模型文字不能报成功、服务重建后的幂等收据、已有题库 CAS 基准。
- `npm run test:plugins:extraction:e2e`：真实 Gateway SSE → 原 QA read/edit → scoped write permit → Markdown → 持久题库收据已通过。发现并修复历史文件引用省略 MIME、Blob 回传 `type:''` 导致的假冲突；此前 `inactive_permit` 是失败 outbox 在原授权关闭后再次上传的后续错误。仅兼容相同文件引用的空 MIME 表示，不放宽任务/资料授权、不接受 finished permit、不吞并内容冲突。`npm run test:cloud` 新增回归确认不同文件 ID、非空 MIME 仍冲突。
- 最新 `npm run test:board:e2e` 已通过原计时器、调度、热加载、主题冷启动、草稿、任务回调、会话链接、语言及三尺寸回归；`npm run test:wrongbook` 的 10 项全部通过；Cloud 事务重试的 6 项全部通过。
- 最终完整 `npm run test:plugins:e2e` 已通过全部新增断言：标准/自定义未提交输入刷新恢复、真实旧菜单原题提取与收据、Tab 焦点限制/Escape 关闭后原草稿保留、原图/KaTeX 可见截图、三尺寸三主题及服务重启；不是仅早期版本的通过记录。最后一轮没有页面异常。

## 最终运行证据

### 全功能可插拔专项

- `npx tsx scripts/test-plugin-pluggability.mjs`（`sh_19d599d390017RzPWKqAoDRdtH`）通过：八包分别三挂载、停用、卸载、重建与真实 API 重启墓碑；账户隔离；raw RPC/命名动作/HTTP/Chat/Bot/native/旧 RPC 拒绝；旧 cards 及七种资料任务 HTTP 入口拒绝伪造 `_pluginProviders`；旧 Bot study_task 的创建种类按账户过滤且实际执行拒绝；practice QA/提取入口拒绝；显式依赖和替代实现；原生 provider disposer 幂等释放/重新注册；已受理生成卸载后写回唯一 cards/收据；已受理错题投递及恢复不重复。
- `npx tsx scripts/e2e-plugin-pluggability.mjs`（`sh_19d5a6fdf001C4uaLa400s5jve`）通过：真实管理控件点击停用/卸载/恢复；practice→review 和 flashcards→cards-reader 依赖卸载与恢复；直达页失效；旧 CardsPanel 禁用但历史卡片可读/导出；旧 `present_quiz` 拒绝且回调不运行；讲义/评论/弹幕/字幕/解析/封面/讲义改写七条原始管道拒绝；本地持久配置、Worker 已接纳快照准入；1440/390/360 × light/dark/auto 无横向溢出。HTML 替代实现直接安装仓库 `templates/cards-reader`，没有测试专用业务页面分支。
- 最终补齐轮再次执行 `npx tsx scripts/e2e-plugin-pluggability.mjs` 通过：八个默认包 `tasks/todo/pomodoro/schedules/flashcards/practice/review/material-tools` **全部**通过真实管理按钮停用→视图撤销→卸载→页面刷新仍不挂载→重新安装→原实例恢复；另验证 `cards-reader` 替代实现。旧四包增加 `legacy-{tasks,todo,pomodoro,schedules}-uninstalled.png` 实拍，原实例 ID 保留有断言。此前旧四包只有 API 全生命周期证据，本次补齐浏览器操作，没有把旧 API 结果冒称为真实 UI 点击。
- 完整 `npm run build`（`sh_19d5a6fda001UZhjDVPkaZQ3xA`）通过：边界、类型、API runtime、i18n 和 Web 产物。保留第三方 CSS `:is()` 警告与静态/动态 import 提示；不声称零警告。
- 补充测试命令后再次执行 `npm run build`（`sh_19d616a04001HAZezxDx35Mec7`）通过：边界检查实际执行，四包构建命中上述已验证产物的 Turbo 缓存，不把重放日志冒称为再次无缓存编译。
- 本次回归通过：平台 `sh_19d555136001gx1CJswe0jTD7v`，学习/持久投递 `sh_19d555136002lz1XkFU8nlPpT1`，原题提取 `sh_19d555141002NLZipX2OyOxTna`，共享状态释放 `sh_19d556bb4001U8ppgIUxGy2BYg`，模板状态 `sh_19d556bb500173jNf3t8Z4VGpy`，原看板/调度 `sh_19d556b9c001NxfmFNqSglez3s`，资料动作 `sh_19d5dc08c001nbHAv3UZAovbdE`，项目范围 `sh_19d5dc0880016t2hdxZKWoZCH5`。
- 独立真实浏览器原题提取 `sh_19d572838001tptULML2dwFz0J`、项目范围/三尺寸三主题 `sh_19d57284e00120NSy0qU7sIsUf` 通过。插件测试专用 Vite 关闭文件监听/HMR，避免并发构建和源码编辑把已打开的测试页面刷新；应用开发模式配置未改变。
- 本专项截图：`/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-pluggability-screenshots/`。`legacy-cards-disabled.png` 验证旧历史与导出，`uninstalled-manager.png`/`local-uninstalled.png` 验证云/本地卸载管理；`manager-<width>-<theme>.png` 在截图前滚动到功能包控制区，避免只拍到上方挂载列表。

此前失败没有计入通过证据：CloudRecords 测试调用遗漏 `after=0` 导致空列表；浏览器把启用状态下正常封面回填误计为被拒绝卡片请求；隐藏媒体 iframe 的宽泛选择器及测试期间 HMR 干扰。分别修正参数、按实际卡片任务种类断言、明确 iframe title 与隔离热更新，未跳过相关业务验收。

最终补齐轮还定位并修正本地模式测试环境问题：直接改 `cloud.enabled` 不会立即卸载旧云 Board 的轮询 effect，随后重渲染切换分支重挂管理器，导致已展开控件折叠、下一次点击超时。测试现在切换模式后经真实路由离开并重新进入 Board，让本地 Board 正常挂载且不保留旧云轮询；明确等待本地配置提示，原本地停用/卸载/恢复、拒绝管道及 Worker 断言全部保留并通过。未修改业务组件或扩大旧管道权限。

完整平台浏览器 `sh_19d5ca04b001Qv9rSj4FRDEI4d` 本轮通过，覆盖旧菜单、模板恢复、资源动作、27 张独立学习页截图和真实服务重启。此前 `sh_19d58a0d8001WoI2ArAVHYJJwM` 曾在 Bot 模板刷新恢复等待结果时超时，未能稳定复现，未将其冒称为已查明根因的业务修复；脚本已补持久 state/run、页面/iframe 和错误诊断。独立 `scripts/e2e-plugin-bot-template.mjs`（`sh_19d5f128b001SENl1tR0JXzdWO`）首次完成加连续五次刷新、四次语言切换均读回同一个真实 run，没有重复任务。

最终稳定性复跑 `sh_19d5fd040001G0se1FMvh1S1be` 再次完整通过；与前一轮连续两次通过，未跳过 Bot 恢复、旧菜单、原题提取、多位置学习、移动端/主题或重启断言。按上述实际证据勾选计划剩余步骤 3、6、8、9。验证使用独立 fixture，不代表付费模型质量或生产部署验收；未提交、推送或部署。

### 项目范围补齐复核

- `npm run test:plugins:projects`（`sh_19d278a13001w5jdk1M2Siq4ZV`）：合法项目；跨账户配置/读取拒绝；不属于项目的资料及全局/跨项目挂载拒绝；项目任务过滤；HTTP、Bot 和 native 工具共用检查；账户/项目/资料布局覆盖；独立项目状态；归档、恢复、回收站撤销及服务重建恢复。
- `npm run test:plugins:projects:e2e`（`sh_19d267736001cuKt3GKyKx5mOF`）：真实管理控件创建/复用实例；项目A/B切换隔离；Chat 当前项目及退出项目卸载；reader 资料范围覆盖项目，A/B资料切换后恢复且不混写；同项目跨看板/Chat/reader/page共享；刷新恢复；1440/390/360 × light/dark/auto。截图 `project-manager-<theme>-<width>.png`。
- 补齐后完整 `test:plugins:e2e`（`sh_19d24f80e001D0noJAI3lZG8R3`）通过；学习专项（`sh_19d2651c0001FGEkMa6OmGnUvO`）、资料动作（`sh_19d278a18001gPCQhJgvAjwbMY`）、旧看板领域/调度（`sh_19d255b26001xUjgT2LthCXHVP`）、插件生命周期/提取（`sh_19d2414e6001aK4trGZ29fD84E`）通过。
- 完整构建（`sh_19d246207001OyQcNL4iVcLqxA`）通过；随后项目仓库目录注入修正再次通过 API 构建及学习专项。学习专项原来使用不一致的项目测试目录，现改为实际 `filesDir/projects`；未跳过实际文件校验。
- 原项目策略复核：owner 所有权、归档/回收站检查沿用 ProjectRepository；自主 Bot 原有 authorizeBot owner 范围与工具审批不变，项目 grants 不是 owner 自有资源的撤销开关。没有扩大跨账户或其他身份权限。
- 最后补强 API/工具专项 `sh_19d2a37b8001IZP40uxIAA2ar1` 通过，额外验证跨账户资料范围、项目任务列表/读取限制、项目 Bot thread 过滤及实际 scheduler tick：归档不派发，恢复仅向本项目 thread 派发，项目外 thread 持久记录拒绝。最终完整构建 `sh_19d28f85f0013jWzSzfRhxf1Tj` 通过。
- 最终项目浏览器及截图 `sh_19d2a37bb0011xC1ou2DP1EcPj` 通过；另保存 `project-shared-<theme>-<width>.png`，实际打开 360px 深色共享待办与桌面管理截图核对内容可读。此前重拍中遇到并发构建触发 HMR 和新增隐藏媒体工作器 iframe，最终运行已避开构建干扰并用明确待办 iframe 选择器通过；未修改或撤销媒体工作器。项目补齐与回归后，重开的步骤 3–8 重新勾选。

工具运行日志保存在开发机 OpenCode shell 存储中；以下 ID 对应成功运行，失败诊断未作为通过证据：

| 检查 | 成功运行 ID |
| --- | --- |
| 完整构建 / 边界 / 类型 / i18n | `sh_19d14ba70001DxyAC2w0MKr1NG` |
| 完整插件浏览器流程 | `sh_19d151170001ivqF1RglU0T1k2` |
| 原题提取独立浏览器专项与截图 | `sh_19d18aea5001j0HkbMy0XU8rN6` |
| 旧看板浏览器兼容 | `sh_19d1755f0001a5KKzFQ7zJUGoQ` |
| 插件 API / 模板 / 生命周期 / 提取 | `sh_19d16b429001ih5NFU5zXAmz0O` |
| 学习领域与持久投递 | `sh_19d171a65001FO7s8K3PAv8OmB` |
| 资料六动作与旧执行器 | `sh_19d171a5d001kIz7bxfuhaV2J7` |
| Browser worker 归属/并发/租约 | `sh_19d171a5e001iwFcQbd4BLmJtn` |
| SystemFiles / 技能 / notebook / instructions | `sh_19d171a65002WjpHymx33mHsJA` |
| Cloud 冲突/授权（含 MIME 回归） | `sh_19d13bd99001x4dxJe8EoItg5i` |
| Cloud 事务重试 | `sh_19d11d068001bXQbAE2mrauhSM` |
| 原错题本与 FSRS 兼容 | `sh_19d1686f8001f5poy6JHgIQht7` |
| 原看板领域与调度兼容 | `sh_19d14fdc60014fD3aj4TofMzk2` |

截图目录（开发机临时证据，不是部署产物）：

`/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-platform-screenshots`

代表文件：`learning-practice-dark-360.png`、`learning-review-light-390.png`、`learning-cards-dark-1440.png`、`learning-mixed-360.png`（原图与公式）、`learning-extraction-success.png`、`plugins-chat-1440.png`、`plugins-reader-1440.png`。最终轮次后重新人工查看前三张：内容可读、控件完整，无横向溢出。目录中保留的 `*-failure.png` 是先前定位失败的诊断，不是最终界面或通过证据。

## 范围限制（不扩张承诺）

- `practice.extract` 依赖在线浏览器工作器；没有在线应用页面时排队。模型报告的覆盖范围保留在宿主提取会话中，界面中的题数是现有题库总数，不保证已提取全文。
- 项目范围遵循既有 owner-only、归档和回收站策略；无项目映射的旧本地/blob 资料仍为资料/账户范围，不虚构项目归属。
- 运行中任务遭遇服务重启按原执行器 interrupted 处理；仅已提交产物/收据恢复经过验证。实际模型质量没有验收。

四套完整可安装模板见 `templates/README.md`；迁移清单见 `implementation.md`，实际契约见 `protocol.md`。跨设备通过独立浏览器 context 模拟，不宣称在多台物理设备或生产环境验收；未运行真实付费模型质量评估。

## 2026-11-03 侧边栏页面与任务式添加体验

本轮新增导航写入同一个 CAS 布局，明确引用 `app.page` 挂载、所选 view 和 instance；旧布局不自动把全部独立内容固定到导航。桌面和手机沿用现有统一导航。页面本身可固定/取消固定，管理中可改名、上移/下移、移动和移除入口。目录订阅共享，管理面板按需加载，不为每个入口轮询或预载视图。

添加不再是常驻技术表单：可搜索的名称/图标/用途 → 按 manifest 过滤的自然语言目的地 → 使用已有内容/单独使用 → 添加。单展示方式自动选择，多视图有可读名称；范围在“更多选项”中用真实项目/资料名表达。桌面 HeroUI Modal、手机 Drawer 使用同一任务内容，无假抓手。管理默认展示用途、状态、开关和恢复，卸载/详情在更多菜单，技术标识收进开发者详情。旧看板的另一套管理面板与额外目录轮询已移除。

已取得退出码 0 的回归：

- `npx tsx scripts/test-plugin-platform.mjs`：新增导航 schema、错误引用、CAS、HTTP/native Chat/Bot 配置同一导航和账户隔离；独立 v1 内容读取静态 defaults，不复制实时旧待办，原数据不变。
- `npx tsx scripts/test-plugin-projects.mjs`、`npx tsx scripts/test-plugin-pluggability.mjs`、`npx tsx scripts/test-board-plugins.mjs`：范围/回收站、八包生命周期、已受理任务、卸载墓碑、原文件数据和安全默认升级通过。
- `npm run test:plugins:learning`：生成、学习历史、错题本持久投递、重启恢复与原 CAS/nonce 语义通过。
- `npx tsx scripts/e2e-board-plugins.mjs`：旧看板真实管理动作改用新界面，保留原计数、计时、调度、配置/模板/文档、语言、主题、尺寸与焦点断言，通过。
- `npx tsx scripts/e2e-plugin-pluggability.mjs`：八包及替代文件包通过新管理列表的开关、更多菜单卸载、刷新和恢复；旧学习入口、本地/Worker 边界及三尺寸三主题通过。
- `npx tsx scripts/e2e-plugin-navigation.mjs`：真实待办添加/打开/刷新、双客户端同步与独立内容隔离、取消无写入、重命名、排序、移除/恢复、页面自身固定/移除；同 view 多入口只移除当前入口；“移到…”来回移动；动态双视图选择第二页；生命周期、真实 HTTP 409 与自然语言提示、挂载外壳账户切换、三尺寸三主题管理、focus trap/Esc/触发点恢复、运行 iframe 不重载、手机抽屉导航关闭和聊天草稿保留通过。
- 最后一轮 navigation 浏览器复核还覆盖三尺寸三主题的“添加到侧边栏”步骤，检查容器边界、无横向溢出、内部滚动、取消返回原页面和运行视图保留，截图 `add-sidebar-{360,390,1440}-{light,dark,auto}.png`。
- `npx tsx scripts/e2e-plugin-projects.mjs`：项目/资料创建、跨位置复用、项目切换、三尺寸三主题的原断言保留；追加真实项目页与资料页固定到导航、显示资料真实名称、固定上下文读原内容，以及归档同时撤销导航/执行、取消归档原内容恢复，通过。
- `npx tsx scripts/e2e-plugin-action-context.mjs`：修复前稳定失败（未确认资料归属时已显示动作），修复后退出码 0；真实资源扫描、旧目录快照到达顺序、确认后打开正确资料和正常目录刷新保留对话框均通过。
- `npx tsx scripts/e2e-plugin-platform.mjs`：最终完整学习浏览器回归退出码 0（本轮隔离地址 `http://localhost:61637`）。原管理控件、跨看板/Chat/阅读/完整页共享与独立内容、卡片审核、AI 练习/原题快照、多题型输入与未提交草稿刷新、作答同步、错题复习、旧阅读菜单与聊天草稿、资源动作、任务产物、刷新及真实服务重启恢复断言保留并通过；360/390/1440 × 浅色/深色/系统主题及 27 张学习页截图通过，页面异常列表为空。
- `npm run build`：全部四包构建通过；原第三方 CSS `:is()`、动态/静态 import 混用提示仍在。Node localStorage experimental 警告保留。

实际截图：`/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-navigation-screenshots/`。代表文件：`choose-function-1440.png`、`choose-sidebar-1440.png`、`sidebar-page-1440.png`、`sidebar-page-390.png`、`manage-360-dark.png`，另有三尺寸三主题管理截图。人工复核后，完整页工具入口移至标题下方，避免手机标题被按钮挤掉；修正未登记图标名及搜索图标定位。

收尾诊断与修复：

- 资源贡献对话框消失是已确认的业务竞态：资源列表首次扫描建立资料归属晚于旧目录快照，动作提前暴露；对话框在打开约 0.97 秒后因项目上下文变化被清除。失败页 `readyState=complete`，没有页面异常、模块/API 加载失败或账户重置事件。`PluginActions` 现在等待共享目录确认资料归属后才展示动作，不添加逐入口请求、不重试点击、不放宽服务端权限。定向测试以真实扫描和受控旧快照稳定复现并验证修复。
- 阅读器 `undefined.replace` 经 CDP 捕获堆栈定位到 `MdReader` 的 `unitLabel.replace`；测试注入的资料块缺少必填 `unit/unitLabel/kind`。补齐 fixture，不增加产品兼容分支，不吞掉异常。调试暂停关闭后的完整回归实际通过。
- 历史刷新整页空白在最终完整回归中未再出现；此前空白截图没有足够加载/锁证据，不能据此确认其根因，也不将资源竞态冒充空白根因。测试现保留页面异常、失败请求/HTTP 状态、待完成请求、加载/可见性/账户事件、Web Locks 与对话框生命周期诊断；失败截图不作为通过证据。最终运行的离线错误来自显式离线用例，409 和重启窗口的 503 单独保留，不当作页面异常；没有因此删除刷新或学习断言。

前轮当时的入口为“添加功能 → 选择功能 → 侧边栏页面 → 使用已有内容/单独使用 → 添加”，并通过管理页面调整；**这些向导现已移除**，当前入口以本文顶部及 `pluggability.md` 的“创造模式与侧边栏页面”为准。手机仍从原导航菜单打开新增页面。计划步骤 10–12 的历史证据保留，不冒充本轮创造模式验收。未提交、推送或部署；保留技能和聊天的并发修改。

实际限制：验证使用隔离临时账户/数据库、Chromium 和可控模型 fixture，不代表生产部署、真实付费模型质量、物理多设备或 iOS/Android 系统键盘与安全区实机验收；历史间歇性空白尚未取得可复现根因。
