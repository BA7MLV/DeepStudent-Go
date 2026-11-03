# 插件实施验收记录

本文件记录本轮**实际执行**的软件验收。父会话复核发现原项目范围未完成，已重开步骤 3–8；项目补齐后的最终状态以计划勾选与新增证据为准，旧“8/8”结论不作为项目验收证据。不将可控模型 fixture 的行为验收冒称为真实模型质量验收。所有修改留在当前 main 工作区；未提交、推送、部署，保留其他并发工作的改动。

## 已执行

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
