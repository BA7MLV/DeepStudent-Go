# 验证基线与阶段证据

> 历史归档，记录当时的实测，不代表当前版本已验收。[当前架构](../../architecture.md) · [归档导航](index.md)。

日期：2026-11-03；当前目录 main 未提交工作区，包含其他会话 Bot 改动。

## 已实测

### 资源事务、系统文档与产物授权增量（2026-11-04，本轮非最终freeze）

- 后续`client-runtime-hpvkU3`完整通过；`learning-products-Ju7sn6`在16组矩阵追加owned-file/删除课程及消息videoId绑定负例，已修复实际授权缺口。`wrongbook-domain-yygxka/evidence.json`真实错题UI丢响应/显式重试一次attempt/reload文件权威，以及真实资料库binary upload提交后丢响应/reload零重传/原Blob+operationId保留通过。
- `e2e-chat-projects.mjs`观测typed submitTask原收据，完整项目创建/关联/切换/移动端矩阵通过；`e2e-usage.mjs`按当前compact token展示验证，完整账户ledger/日期/source/晚响应/失败重试/布局通过。Web serverClient.events旧SSE parser删除后`test-bot-sync.mjs`8项、API/Web typecheck通过；服务端SSE保留给A，未提前删除。过时`e2e-chat-shell`模拟仍待迁移。

- `client-runtime-etETcQ`：完整runtime回归通过，新增真实技能definition+references同事务及SKILL.md编辑后保留reference。修复领域层逐行apply触发未落盘包同步的问题，不改变原事务/收据身份。
- `wangke-system-files-ui-uWdrc4/screenshots`：1440/390px普通系统文档完整矩阵，以及技能设置创建→真实references目录→资料库编辑→设置更新→内置技能reload通过。`wangke-mcp-files-ui-TGbPfh/screenshots`：双尺寸JSON/可视编辑、secret排除、并发草稿、reload及deep link通过。
- `opencode/learning-products-TRZqsU/evidence.json`：16组producer/product组合，包括transcribe/material/cover的courseDerivation，真实HTTP/codec下任务类型、资源/会话、过期lease、取消parent、终态拒绝新写和原收据复取通过；domain额外拒绝未知字段。`executor-runtime-fPcBT7`完整既有文件permit/lease/响应丢失专项通过。
- `test-video-playback.mjs`、`e2e-auto-subtitles.mjs`、`e2e-server-storage.mjs`通过。`e2e-video-playback.mjs`修正夹具：静态测试使用独立静态document/database，而非将cloud.enabled改false后写只读服务器cache；原渐进加载/部分下载/seek/故障重试及Chromium/WebKit本地解码/缺失文件全部原断言通过。
- 本轮API/Web typecheck通过。以上不是本轮统一生成/build/性能的最终产物身份；A未通知完成前不删除原生仍需的Host SSE，不重复依赖/许可审计。

### 干净HEAD生产对照与协议增量（2026-11-04）

- 干净基线为 `02b3b3e579f5b2a535a31f95ff5ebec48189069d`，独立archive/npm ci/bootstrap/build于 `opencode/client-baseline-head-4rgby508`，未覆盖当前工作树、未伪造迁移前产物。冻结阈值由 `scripts/benchmark-client-head.mjs` 写入证据后开始测量，三轮cold context、首轮60秒idle、同board/todo夹具。
- 首次真实失败保留 `opencode/client-head-comparison-21YEsG`：HEAD→current首屏850.62→871.79ms、输入38.74→42.34ms、投影4839.31→192.69ms、heap14,986,776→17,024,628 bytes通过；JS3,390,621→4,052,437及idle业务HTTP99失败。
- 夹具口径修正单独记录，不替换首次失败：两版本相同服务端偏好关闭学习计时（防止将有意studyDays提交称为idle），相同固定5秒settle排除初始化迁移；worker claim单列leaseAdmissions，全部原始请求仍保留。`GYlnhv`仍失败，36次业务HTTP定位为内置schedules/pomodoro每5秒读取；不是共享WS自动轮询。
- 删除上述模板轮询后，`opencode/client-head-comparison-RfvHQx`：首屏863.29→898.63ms、输入42.74→43.28ms、投影4835.24→193.08ms、heap14,989,672→17,028,836、idle0→0均通过；JS3,390,621→4,052,737仍超过冻结上限3,899,214.15。**P0未通过**。runner另加入产物前后SHA256身份校验，拒绝测量期间混入其他build；新HEAD没有generated目录时明确hash其absent状态。
- `test-client-runtime.mjs`新增并通过真实I/O：opening snapshot捕获后暂停，HTTP提交后释放，最终模型不得丢写；实际WS socket.pause期间Host连续产出8次，resume后赶上最终提交；实际保留表cursor缺口重建；会话自动过期关闭已存活peer，后续HTTP返回401。不是仅fake adapter测试。
- 偏好 `opencode/preference-commands-knUA0B`新增真实CAS冲突、恢复UI导出/唯一successor、旧generation核对结果拒绝、两标签不同键并发及混合legacy事务完整归档；故障注入有预期ECONNRESET，不能称零网络错误。资源trash/restore typed watch及实际extraction复验通过；普通项目文本接线和后续优化仍需各自复验。
- 后续 `opencode/client-head-comparison-mTfoIv`仅对话路由lazy后JS仍3,997,175超限；失败保留。再将无条件空闲预取改为导航hover/focus意图预取（保留完整路由与播放器/阅读器功能），`opencode/client-head-comparison-YsyfwE`六项全部通过：首屏849.30→864.97ms（上限1119.16）、输入42.71→41.38ms（上限61.26）、投影4856.38→189.23ms（上限5852.66）、heap14,996,576→15,789,728（上限19,044,467.2）、JS3,390,621→2,844,673（上限3,899,214.15）、idle0→0。`output-identities.json`前后校验通过；阈值未调宽。该结论是同看板生产夹具性能门禁通过，不是全部迁移阶段验收。
- `test-route-preload.mjs`真实浏览器通过导航hover/focus与子元素去重、Save-Data/cleanup及外链拒绝。`preference-commands-fKyToj`补普通项目文本丢响应、reload不重发及目标已进回收站后的完整原稿/expected/收据导出归档。最新完整build、生成一致性、plain Node compiled Host及executor HTTP专项通过；资源上传、旧资源outbox及普通chat拆分仍未完成。

### reload 微任务饥饿关闭与文件意图后续（2026-11-03）

- 已定位 reload 的具体根因：`client/session.ts` 的 refresh 在 bootstrap runtime 身份已失效时保留 `pending=true`，while 不执行，finally 再次 refresh，形成无限微任务链。只显式调用 runtime.dispose 不清除 bootstrap 身份，所以该对照通过；pagehide/account disposal 会清除身份而触发循环。入口、循环和 finally 现在同时检查账户/runtime身份/取消，失效时清空pending。不依赖延长等待或beforeunload补丁。
- `npx tsx scripts/e2e-session-model.mjs` 完整通过，证据 `opencode/session-model-VYsm3v`：原65行分页/推送/进度/唯一终态、60秒零空闲API、单文档共享mux、已受理后丢HTTP回执、reload只查询同nonce收据且数据库仅1任务均保留。新增runtime身份失效后1秒event-loop heartbeat和CPU门禁通过，renderer TaskDuration增量0.011567秒（门禁<0.5秒），无pageerror。旧失败证据保留，不再把records迭代终止修正当作本次根因。
- 上述证据文件早期把idle窗口之后的主动API与跨reload两个socket也写进idle字段；脚本现已分别保存idleRequests、socketsBeforeReload和socketsAcrossReload。原运行内零请求与单socket断言实际通过，字段修正不改变其断言。
- 新增持久`system_file_intents`：SQL事务内登记原始内容/CAS期待，applied/conflict/superseded/discarded收据保留；旧pending原样转换。外部冲突不再清除原稿，重启不自动重试冲突。显式恢复以核对后的磁盘内容CAS，稳定原intent的相同恢复请求返回相同successor收据，不重复落盘；不同恢复参数拒绝。`test-file-intents.mjs`通过事务回滚、冲突原稿保留、跨重启、显式CAS、恢复回执丢失幂等、rename/unlink后重放、目录fsync失败恢复和归档仍保留原始字节；`test-system-files.mjs`既有全项、API/Web类型检查通过。
- 文件冲突typed Remote查询/共享流/显式恢复与生产Activity恢复UI的真实浏览器专项已通过（`opencode/file-intents-e2e-POuJDN`）：冲突推送、原稿/磁盘版本核对、已恢复但HTTP响应丢失、原收据查询唯一successor以及reload，均无pageerror。首轮定位到旧remote-host dist未重建，第二个问题为流刷新清掉命令不确定警告；已分别重建精确workspace并拆分stream/command错误，未缩减断言或延长超时。
- 最新`test-client-runtime.mjs`与`test-system-files.mjs`、`generate-remote --check`、`check-boundaries`均通过。已审计同步state/schedules写、cards更新/生成及practice.submit采用业务SQL+关联文件意图+命令结果同事务；专项覆盖写后异常完整回滚、SQL提交后外部冲突不重跑handler、显式恢复后原命令返回最终收据、rename后目录fsync失败由收据条件恢复且handler计数不增加。其他handler任意副作用与client_commands原子提交仍未完成，不能把文件意图专项称为全应用exactly-once。
- 后续完整Session证据`opencode/session-model-fA53YC`：新增受理前请求丢失，reload零submitTask请求、数据库零task，用户显式UI重试后同原operationId恰好1task；未删原已受理丢回执断言。60秒idleRequests=[]，socketsBeforeReload=1，两次reload后总socket=3（按文档各1，不是并存3），身份失效CPU TaskDuration增量0.003141秒，无pageerror。曾把按钮文案变为“正在核对”误认为该原文按钮hidden即已完成；现等待整条pending记录移除再核对数据库，完整运行通过。
- `file-intents-e2e-nXDbyk`增加核对后磁盘再次变化的真实CAS负例并通过：不覆盖新外部版本，重新查询后才显式恢复。直接测试另覆盖跨账户receipt/resolve隔离、已rename未完成收据的定向查询恢复、旧pending原始中文/CRLF/NUL字节幂等转换；保存或核对一个账户的意图不顺带flush其他账户。
- 最新完整插件失败保留：`sh_1a1d96c31001YYAt8SYbIEogH7`在第207行新标签`goto /#/board`等load30秒超时，尚未走到前次iframe click；page-failure-7记录readyState=complete但root为空，同账户cloud-sync锁存在百秒持锁/排队，网络还有未结束module/CSS。没有pageerror。已加无timer的sync阶段/耗时诊断继续复现，不能把它归因于Session旧CPU循环或以重跑偶尔通过关闭。

六阶段逐项剩余门槛见`stage-status.md`；不以本节新专项通过替代计划勾选。

- 审计收敛后完整`npm run build`已通过（`sh_1a1e5db0d001FoYfAqglMhWuIW`）：contracts/remote-host/API/Web、i18n、边界检查及Web/API许可复制均成功。保留构建警告：依赖CSS空`:is()`、Zod PURE注释位置、混合静态/动态import；不宣称无警告。未执行镜像构建或部署。
- `e2e-cloud-sync-locks.mjs`最新完整通过（`sh_1a1e3f162001D0jspH1obd1NpA`），背景ifAvailable不排队、显式flush等待并排空及空outbox初始baseline均通过。该两标签专项没有覆盖完整插件组合的长等待，不据此关闭完整插件故障。
- 完整插件CPU进一步定位：`opencode/plugin-js-profile.json`为独立loopback inspector采集的120秒Node CPU profile，93287样本中82755经过PluginFiles.catalog，68513经过BoardFiles.ensure；原生`plugin-node-native-sample.txt`同样显示文件操作。不是仅以Web Locks排队推断死锁。内置升级扫描现按DatabaseStore/owner成功提交后只初始化一次，实时catalog/manifest/symlink/权限校验不缓存。`test-board-bootstrap.mjs`证实20次catalog无重复bundled扫描、跨BoardFiles实例共享、事务回滚不标记成功及磁盘manifest损坏/恢复立即可见；board/plugin-platform/system-files/client-runtime/API类型检查均通过。
- 修复后完整插件运行`plugin-bootstrap-once`越过新标签、mixed-practice iframe和断网恢复，但第473行资源动作入口失败：catalog scopes仍是资源索引前的快照。已补resource_files/resource_folders的事务通知和videos索引的catalog失效，新增真实Remote“先订阅catalog、后索引资料→新material scope推送”测试通过；完整回归仍需读实际结果，未将本轮候选认定整体通过。
- `plugin-resource-invalidation`复验发现新增resource UPDATE通知与catalog内部幂等索引形成反馈：即使字段未改变的UPSERT也触发通知。资源表UPDATE通知现比较全部OLD/NEW字段，只有实际变化才追加journal；启动替换已有同名UPDATE trigger。真实Remote回归新增100次无变化UPDATE不增revision、实际变化增revision的断言并通过。没有移除资源通知或恢复轮询规避问题。
- 最新完整`npm run build`及plain Node compiled Host/generated codec smoke、Web/API notices和压缩renderer `@license`门禁全部通过（`sh_1a1f710bc001lVxtxhLTdghKA2`）；本次API真实重编译，Web/其余workspace合法cache hit，既有警告保留。
- **完整插件已闭环通过，不再是候选等待结果。** `plugin-resource-noop-guard`带独立CPU诊断完整通过；随后合并PluginService.list内重复catalog扫描（只在当前同步调用中复用packages/registry，保留每次请求和await后授权重验），新增扫描次数断言证实只剩package快照与live legacy layout各一次。修改后plugin-platform/project/client-runtime专项、API类型检查、完整build和plain Node编译发行smoke均通过。
- 不带调试器的`plugin-final-catalog-snapshot`再次完整通过`e2e-plugin-platform.mjs`原断言与原超时：新标签、iframe、mixed-practice、刷新后练习、Worker extraction、断网恢复、资源动作、独立实例、服务重启及360/390/1440×light/dark/auto截图。保留原失败证据和网络日志；故意断网/重启中的ERR_INTERNET_DISCONNECTED、ECONNRESET没有被吞掉或转为成功断言，最终pageerror数组为空。
- 性能不夸大：`plugin-noop-guard-profile.json`为60秒真实CPU profile，45270样本中29239仍经过catalog。它证实初始化扫描热点已移除但实时磁盘校验仍昂贵，不是干净HEAD同夹具性能基线，也不足以宣布CPU/性能阶段通过。

### 后续 records / Session / Bot 调度迁移

- 最新 `test:client-runtime` 已覆盖插件handler提交业务后抛错：首次返回client/uncertain、receipt为uncertain、同operationId重试不再执行，原业务记录仍存在。执行前授权/参数失败与执行后不确定结果分开记录；这只是防盲重放，不是普通命令副作用与收据已原子化。
- 后续完整build通过（`sh_1a1b2f68c001qLzVxkuLx2vfZd`，含executor journal与uncertain契约）；最终账户异步guard/命令warning分离小改后Web/client-core类型及boundaries负例通过。`check:remote`通过。BotFollowModel新增2项直接单测通过：旧state不覆盖新activity水位、释放不等待provider且拒绝晚到state/event。`test-system-files.mjs`现有全项通过，但没有覆盖上述文件意图冲突丢失问题，不作为其关闭证据。
- 发送回执丢失后的reload仍失败（证据 `opencode/session-model-oBLqmF/reload-failure.json`）：fixture独立HTTP200，Vite确已收到并发送reload文档，浏览器却未完成DOMContentLoaded、也没有新module/API请求；没有pageerror，数据库只有一个已受理nonce。延长等待未解决，故不再归因于等待时间；正在采集浏览器执行栈，未关闭重启恢复门槛。
- 后续诊断 `opencode/session-model-mCQQPf/renderer-sample.txt`：reload停滞时该隔离测试的Chromium renderer持续100%CPU，CDP pause未返回，native sample主要在JIT/V8帧（发行二进制符号不足，不能据此认定具体函数）。终止了本会话该隔离浏览器PID，未触及用户浏览器。发现records follower在runtime/source已释放时仍continue未确认frame，改为终止迭代；属于待验证候选修复，不预先认定根因。新增active records follower随runtime释放的测试并重跑浏览器恢复专项。

- executor任务tag/journal新增后，`test-cloud-transactions.mjs` 8项通过，包含legacy原始Blob/permit/id完整保留、同task队列保留及幂等转换；原事务丢失重试/持久失败不丢outbox断言继续通过。`test:plugins:extraction:e2e` 最终通过新 `/tasks/:id/records` 与typed账户commit的真实读/edit/许可/Markdown/持久收据/确定性UI队列隔离。上一轮测试仍只拦截旧records URL导致worker计数0失败；已随生产迁移更新网络匹配器，保留原业务与隔离断言，并同时hold typed账户commit，未放宽业务门槛。
- Local/Server历史adapter后Session浏览器专项再次通过（`opencode/session-model-vb1JLX`）；追加“server已接受但响应丢失→reload只查收据”断言首轮在reload等待load30秒超时，未计通过。改为等待DOMContentLoaded并仍严格等待生产fixture完成60秒，结果待自动返回。
- 最近完整 `npm run build` 通过（此前首轮暴露分页cursor的role参数类型必填问题，已修正），bootstrap现在合并为index1430.21kB/gzip429.59、plugin-renderer73.96/gzip23.38；chunk结构变化，不能和旧bootstrap402.58直接当性能同口径对比。既有CSS/import警告仍在。此build早于executor journal最后修改，不提前当最终代码通过。

- `test:client-runtime` 最新通过：有界 SessionModel 首屏40/历史55、keyset旧页15、消息与任务推送、双retain释放、同nonce收据重复返回同task、不同payload返回client/conflict；records收据重复不重复累计studyDays，坏事务整体回滚且无完成收据。原传输、取消与插件授权负例继续通过。
- `test:client-runtime:sync-locks:e2e` 通过生产 startCloud/sync：真实跨标签锁、保留待确认编辑、一次已提交编辑只排一个writer、事件驱动排空、服务端偏好WS更新、60秒零records unary。中间两轮曾出现server仍旧值而local/outbox已满足断言，不能抹去；增加编辑提交时outbox断言和诊断后通过。另补queued旧帧key revision保护，不将一次通过当作完整故障矩阵。
- BotFollowModel 接管生产订阅调度后，`test:bot-sync` 13项和 `test:bot-sync:e2e` 通过：10000历史/首屏50/15888bytes/17挂载行，60秒零线程HTTP、500progress、anchor/restore偏移0；证据 `opencode/bot-sync-web-YaljSA/evidence`。此轮发生在随后page/nav Slots改动之前，不当作后者的整应用回归。
- Worker 新任务限定records接口实测：自身转写segments成功，无permit的studyDays仍403、错误task路径403；原并发/lease过期回收测试通过。初轮被全局allowlist拒绝，现只额外允许自身task的精确新路径，没有放宽现有permit。
- `test-session-model.mjs` 两项通过：pending身份保护、已删除持久行移除、跨session隔离、continue身份稳定及uncertain状态。尚不能替代生产courseChat浏览器完整验收。
- API/Web类型检查通过。page/message/nav Slots后 `test:plugins:renderer:e2e` 通过StrictMode/100次释放；`test:plugins:navigation:e2e` 已通过真实Web工具、持久状态/reload/双客户端、精确多view路由、生命周期/账户切换、移动drawer及3宽度×3主题，截图 `opencode/create-mode-screenshots`。
- `npx tsx scripts/e2e-session-model.mjs` 已通过生产courseChat、CloudActivity及真实records/session/tasks共享mux：65条分页历史、新增消息保留全部66条、远程任务progress、终态只一条回答、60秒零API请求；证据 `opencode/session-model-rTjcjl`。随后显式Local/Server history adapter和pending启动收据查询有新修改，需重跑，不将较早通过冒充最终代码。
- 完整插件原断言最新重跑 `plugin-task-list-recheck` 退出1：`e2e-plugin-platform.mjs:259` 自定义题iframe“回传草稿”click超时30秒，控件在actionability阶段已解析/可见/稳定，scroll之后未完成点击；无pageerror。本轮未到reload记录或Worker关卡，不能称原两处间歇问题已关闭。没有放宽断言或重复以全回归阻塞其他迁移。
- 六阶段仍保持0/6：普通聊天全域拆分、pending重启恢复UI、资源/偏好完整领域API、文件意图最终收据及完整scope/故障/平台矩阵尚未完成。上游来源/许可由独立会话负责，本轮未改其专属审计文件或依赖清单。

- `npm run typecheck -w @wangke/api`：通过（新 Host 接入后）。
- `npm run typecheck -w @wangke/client-core`：通过。
- `npm run build -w @wangke/contracts`：通过。
- `npm run check:remote`：通过（delta 契约重新生成后）。
- `npx tsx scripts/test-client-runtime.mjs`：真实隔离 SQLite + Fastify listen + HTTP + ws；通过未认证/恶意 Origin、两逻辑流共享一次 socket、提交后 delta、命令重试收据、key 内容冲突、取消观察。
- 同测试：React 无关模型三次 retain 共用投影，真实 socket terminate 后 stale/reconnect，新基线保留相同引用，100 acquire/release 循环活动模型归零，disposed runtime 拒绝旧账户操作。

运行测试发现 `ctx.set` 未先 provide 会导致启动失败；已改 `ctx.provide` 并用真实测试覆盖，类型通过本身不能证明服务运行。

## 未完成的门槛

未采集完整应用首次/多卡/三挂载/聊天/Bot/切页/账户切换的统一请求、payload、渲染延迟、渲染次数和内存基线。未冻结性能回退阈值，不能在迁移后编造迁移前数值。
上述 Node 测试不等于浏览器生命周期、60 秒零业务轮询、慢消费者、快照竞态、跨设备、撤权、Worker、PWA、WebKit 或目标代理验收。
插件完整浏览器回归第一次在资料笔记保存期间 resize 后等待“已保存”超时。源码与隔离测试确认：模板把包含尺寸的 UI context revision 当资料生命周期，提交成功却丢弃回执。改用资料切换 sequence，仍拒绝旧资料回调；新增延迟写入期间 resize 测试通过。随后 `npx tsx scripts/e2e-plugin-platform.mjs` 曾全流程通过（原断言保留，含 27 张学习页面截图）。但生产任务等待迁移后一次回归在第 304 行共享计数器挂载超时，body 无文本、无捕获的 browser errors；保存的 root 实际是 PageLoader，并非没有 React 树，cloud-sync 锁排队约 24 秒，不能将此直接当作渲染崩溃根因。一轮重跑通过计数器、跨设备和断网恢复，随后又在第 378 行资料笔记 resize 保存等待超时；另一轮在第 327 行新聊天页加载超时。尚未证明保存失败与先前模板问题相同，也不能将聊天加载问题归因于 sandbox。已补充 iframe 内文本/草稿与生命周期诊断，保留原断言，不能报告整套通过。带 Host 所有权修复的完整重跑正在独立 `opencode/plugin-runtime-owned-frame` 目录采集，未计为通过。`worker_mutation_denied:studyDays:missing_permit` 仍无已证实根因。

`npx tsx scripts/e2e-client-runtime.mjs` 通过：Chromium + Vite 静态 ESM 适配 + 真实 Fastify/代理 WS + 上游 Slots renderer 注入 selector hook，三个投影共享模型、外部写入可见、释放后模型清空。此测试是 P0 接入 fixture，不是生产页面迁移，也不是 60 秒空闲门槛。

`npm run test:plugins:frame:e2e` 通过：生产 PluginFrame 与正式资料笔记模板，真实 Chromium、StrictMode、异步 HTML 装载、resize/save 和 100 次挂载/卸载，最后订阅数归零。发现并修复 Host effect 在 HTML 尚未装载时安装、其 cleanup 通过更新后的 `frame.current` 向新 sandbox 发送 dispose 的所有权缺陷；现在 effect 捕获自己的 iframe/window，并为文档 incarnation 分配独立 channel。此测试的领域 I/O 是内存夹具，证明 bridge 生命周期，不替代真实后端完整插件验收；尚需带该修复重跑全流程，不能提前认定最新保存失败已关闭。

`npm run build` 完整构建已通过；`node scripts/test-client-runtime-build.mjs` 通过编译 API/Host 的 plain Node 启动及 codec dispatch。Host facade 独立编译 JS，镜像复制其与生成物，尚未运行容器隔离验证。构建仍有 CSS `:is()` 压缩及动态/静态导入分包警告；bootstrap chunk 约 386.23 kB（gzip 100.56 kB），未完成同夹具包体/首屏回退对照，不能声称性能达标。

生产 `waitCloudTask` 已改用共享 TaskModel，停止 750ms task GET 和观察取消自动 cancel；任务进度、两个 waiter 共享、取消不停止任务、runtime 销毁拒绝等待等 Node 回归通过。独立真实 Chromium 测试 `npm run test:client-runtime:tasks:e2e` 已通过共享业务 mux、进度/结果推送、取消隔离、回调失败立即拒绝、60 秒空闲零 task HTTP、延迟作品 owner 缓存到达，以及任务终态后的 runtime 销毁中断缓存等待；Vite 开发 socket 单列。该 60 秒结果只覆盖生产任务等待，不覆盖插件和全库 records。iframe 独立 watch 和其他域旧轮询尚未删除。

六阶段计划全部保持未勾选。尚未完成任何阶段的全部门槛。

## 后续生产插件迁移（进行中）

- 最终 useLayoutEffect/channel 微调后，`npm run test:plugins:frame:e2e` 再次通过，含 100 次挂载卸载。
- `opencode/plugin-runtime-owned-frame` 完整回归已结束、退出 1：第 185 行 `quiz-explain` 内“正确答案：A”可见性超时。body 诊断有答案文本，无 pageerror；不能由此跳过可见性断言或认定整套通过，本次未执行到资料笔记/Worker 门槛。
- 生产 `plugins/catalog.ts` 正在切换到共享 PluginCatalogModel，删除该目录的 1500ms 轮询；Local 分支保留事件驱动存储读取，连接错误不伪装成空目录。`PluginHost` 的 sandbox 状态订阅正在切换到 PluginInstanceModel；调用按服务端声明的 access 元数据路由，不在新适配中猜方法名。原学习视图的 shared 轮询、iframe task watch 和其他业务旧路径仍在。
- 新增 `scripts/e2e-plugin-catalog-model.mjs`：真实 Fastify/WS + 生产目录 hook/装配，三挂载、外部布局修改、显式刷新、60 秒空闲和 100 次释放。首轮零 HTTP 断言错误地把 `/src/api/*.ts` Vite 模块装载计入业务请求而失败；已改为只计 URL pathname 的 `/api/` 前缀，重跑结果待确认，不提前计通过。
- 上述目录专项随后通过；再扩展为生产 PluginHost + 原待办 HTML，也已通过三处挂载共用一个 state Model、外部状态推送、生成 read/command、两次各 60 秒零业务 HTTP，及目录 100 次挂载卸载归零。删除了待办 HTML 内部隐藏的 5 秒读，原文件按 SHA 精确升级，保留用户编辑版本。此时仍不代表其他内置 HTML/学习页零轮询。
- 继续将 SDK task watch/wait 的 1500ms tasks.get 轮询替换为受限 Host watch/unwatch，复用实例 scope 的 tasks.get 模型、16 条/iframe 配额、终态保留和 cleanup；新增 SDK 共享观察/取消浏览器回归及跨资料 taskAllowed 重验测试，结果待确认。增加 Host ready 后再重放缓存基线，及待办初始 HTTP 结果不得覆盖较新推送的版本保护。
- `npm run test:client-runtime`、`npm run check:remote`、`npm run test:plugins` 已在目录/Host 迁移后通过；最近一次完整 build 通过（bootstrap 386.77 kB，gzip 100.64 kB），随后 Host ready/SDK watch 的最终微调正在重新构建与验收，不能把上一轮构建当作最终版本通过。

## 组合查询与学习视图迁移（后续记录）

- `pluginQueries` 已由正式 Typert generator 生成；`generate:remote`、`check:remote` 及真实 `test:client-runtime` 通过。新增组合投影测试覆盖同请求复用、三次 retain、推送 delta、释放、1–8 查询边界、唯一/合法 key、拒绝 write 方法，以及任务改属其他资料后组合 watch/unary 都重新拒绝访问。
- 四个生产学习视图已切换生成 unary + scoped Model 订阅；卡片将资料列表、卡片、任务结果合并为一个逻辑流；练习列表与任务结果合并，练习快照、复习清单和资料处理结果也不再定时读取。其余三个视图的资料列表、选中资料投影/练习行是独立资源流，尚不能称所有视图每实例都只有一个流。删除 `shared.ts::subscribePluginRead` 及其 1500ms timer，不保留轮询 fallback；写后不再用无版本 unary 覆盖较新的推送。
- 学习收据和作答登记原先不在通知闭包，去掉轮询会丢失迟到交付状态。现在在学习表初始化时幂等安装 `plugin_learning_tasks`、`plugin_learning_receipts`、`plugin_practice_snapshots`、`plugin_practice_submissions` 的事务内 INSERT/UPDATE/DELETE 通知，覆盖已存在的 schema34 数据库；不假称这已补齐 Bot messages/run_steps。
- `test:plugins:learning`、`test:plugins:materials`、API/Web 类型检查及 `test:plugins` 在学习迁移后通过。`test:plugins:review-clock:e2e` 通过生产 ReviewView 的 StrictMode、到期标签跨 deadline、零 unary/不重新订阅及卸载释放；领域 I/O 为明确夹具。复习标签按服务端 `asOf` 与持久 FSRS due 时间推进一个本地 deadline timer，不依赖浏览器墙钟，不发业务轮询。
- 扩展真实生产组件专项 `test:plugins:models:e2e` 的首轮失败于新断言错误地要求 catalog Model 也有 3 个 retain。实际 catalog hook 聚合三 React listener 为 1 retain，卡片直接有 3 retain。按这两个生产边界分别严格断言后重跑通过，活动 Model 严格为 2，未增加允许的活动流数量；真实 Fastify/WS + 生产 catalog/PluginHost/待办/卡片覆盖三挂载共享、外部更新、生成命令、scoped 任务 watch/取消、迟到学习产物收据推送、三个各 60 秒零业务 HTTP 窗口及目录 100 次生命周期归零。tasks 模板本身仍有 3 秒 tasks.list 轮询，不将局部窗口外推到全部插件。
- 最新 `npm run check:remote`、`npm run build`、`npm run test:client-runtime`、`npm run test:plugins`、`npm run test:plugins:learning`、`npm run test:plugins:materials` 均通过。完整构建 bootstrap 约 387.51 kB（gzip 100.72 kB），既有 CSS/分包警告保留；没有据此宣称性能门槛达标。完整插件回归另在 `opencode/plugin-learning-model-final` 采集，结果尚未计入通过。
- 完整回归 `opencode/plugin-model-production` 退出 1：第 382 行笔记 resize 后等“已保存”超时。iframe 草稿仍为“资料 A 的尺寸变化草稿”，没有状态/异常文本；不能将其归因于已修复的旧 context revision 问题。`opencode/plugin-composite-diagnostics` 下一轮退出 1，提前在第 207 行新页面初始待办挂载失败；该页 root 为空，cloud-sync lock 从约 16.38s 排队到 59.80s 才取得。源码 boot 等待 startCloud/flushCloud，这提供了启动受同步锁阻塞的直接证据，但尚未闭环修复，不能当作笔记保存根因。新增 sandbox pointer/click 与 bridge request/response 诊断；全部原业务断言保留。
- 六阶段仍为 0/6。生产 typed Slots/renderer、全域同步/聊天/Bot 迁移、命令事务与恢复、上游包对应/许可闭包、性能基线以及完整浏览器门槛仍未完成；未提交、未部署。

## 同步锁排队隔离（后续记录）

- `opencode/plugin-learning-model-final` 完整回归退出 1：仍在第 207 行新看板首次挂载待办超时。现场页面最终已有 React 树与插件，首次 cloud-sync 锁从 13.69s 排队至 38.66s，40.54s 释放，约 50.43s 才记录 iframe ready；不能把较晚采集到的界面当作在原超时内通过。
- 原周期同步和首次/显式 flush 都进入同一个排他锁队列，多标签周期任务会排在首次同步之前。周期同步现用 Web Locks `ifAvailable`，锁忙时跳过，不发网络、不删除 outbox、不 steal；首次同步、Worker 显式提交和用户 flush 仍等待锁并完成原 push/pull。显式调用加入被跳过的后台 flight 时必须重新执行，即使 outbox 为空也不能误认已有基线。保留必要 Worker lease 和原同步授权。
- 新增 `npx tsx scripts/e2e-cloud-sync-locks.mjs` 已通过：生产 startCloud/flushCloud、真实 Fastify/API、Chromium 两标签 Web Locks，覆盖多个周期 tick 零排队/零同步请求、锁忙时 outbox 原样保留、显式调用加入后台 flight 后等待并提交，以及空 outbox 仍读取基线。`npm run typecheck -w @wangke/web` 通过。
- 排队修复后 `npm run build` 再次通过（Web/API 实际重新编译，其他 3 个构建任务命中缓存），边界/i18n 检查通过，bootstrap 仍约 387.51 kB（gzip 100.72 kB）；既有 CSS 和分包警告未消除。
- 这是旧同步迁移期间的排队修复，不是全账户 records 轮询删除，不能声称普通聊天/Worker 同步迁移完成或启动空白全部修复；笔记 resize 保存及 Worker missing_permit 仍未闭环。完整回归另在 `opencode/plugin-sync-lock-fairness` 重跑，待实际结果。

## 完整插件回归通过（同步锁修复后）

- `SCREENSHOT_DIR=…/opencode/plugin-sync-lock-fairness npx tsx scripts/e2e-plugin-platform.mjs`（`sh_1a07ce8a3001fDl4tkuJ4h4ZdI`）退出 0，原断言保留：真实工具配置、待办/卡片跨看板/Chat/reader/page、独立实例、多题型原题及输入草稿、作答快照/错题复习次数、笔记 resize/save/A-B 隔离、真实浏览器 Worker 原题提取状态 completed 与持久 Markdown/产物收据、Bot nonce 刷新不重复、资源动作、旧管道、真实服务重启恢复、360/390/1440 × light/dark/auto 通过。
- 页面异常数组为空；控制台仍有 CSP `navigate-to` 不支持、403、显式离线窗口网络失败与服务重启时代理连接拒绝日志。本轮未保存成功路径的逐请求状态归因，不能将所有 403 先验归为预期、或将本次通过称为控制台零错误。
- 证据目录：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/plugin-sync-lock-fairness`。包括 27 张独立学习页主题/尺寸截图；人工查看 `learning-practice-dark-360.png`、`learning-review-light-390.png`、`learning-cards-dark-1440.png`，可见内容可读、控件边界正常，截图不代表首屏外全部内容已人工审查。
- 先前第 207 行启动超时、第 382 行笔记保存超时和 Worker missing_permit 本轮未再现；锁排队有确定性专项，但笔记间歇性失败及 Worker 许可失败仍无可复现根因，不据此报告根因关闭。没有修改授权或跳过提取 completed 断言。
- 此结果补齐当前插件完整回归，不代表全应用迁移或六阶段验收完成；生产 typed Slots、普通聊天/Bot/records 收敛及其余矩阵仍待实施，计划保持 0/6，未提交/推送/部署。

## 生产 renderer、共享 Bot carrier 与 Worker 队列隔离（最新）

- 生产 `client/plugin-renderer.tsx` 使用 Cordis + keyed Slots 注册 native contributions，React outlet 只在 committed effect retain。新增 PluginView/PluginSlotView/PluginActionsView，四学习视图只收注入的 `useProjection`/`call`。bare source adapter 聚合多 React listener 为一次 core retain；删除旧 PluginQueryObserver/observePluginQueries。边界负例禁止这些学习视图重新导入 runtime、db 值、旧 shared transport 或直接打开 fetch/WS/SSE。
- `npm run test:plugins:renderer:e2e` 已登记正式入口；同脚本先前直接执行通过 StrictMode 与 100 次 committed mount/unmount，renderer refs/contexts 最后归零。真实生产 `test:plugins:models:e2e` 最新通过目录/Host/todo/四学习视图、跨 store 更新、typed commands、scoped sandbox watch/cancel、四个各 60 秒零业务 HTTP 窗口和 100 次目录生命周期。catalog/学习 source 分别聚合三挂载，严格为两个活动 Model、各一个 retain。
- tasks HTML 删除 3 秒 tasks.list timer，改受限 `tasks.observeList`。SDK queries.watch/unwatch 与任务观察共用 16 条配额、generation 清理和服务端 read 授权；只升级两个精确原模板 hash，不覆盖用户修改。
- Typert 增加 receipt/watchBot 并重新生成；named action 经持久 operationId command target 调用，不绕过 PluginService。新增 pending/failed/completed/missing 收据查询。副作用/收据仍未原子化，不能称 exactly-once。
- `test:client-runtime`、`check:remote`、`test:plugins`、review-clock 专项及 Web/API/core typecheck 在上述迁移后通过。生产 model 专项最初因 Vite 首次发现 Slots 依赖触发整页导航而失败；显式预优化 Slots 后通过，未删除白屏或共享订阅断言。
- 生产 Bot follow 接入共享 watchBot，保留已有持久 cursor、快照竞态重放和重连算法。`test:bot-sync:e2e` 在抽出初版 BotHistoryModel 后通过：10000 历史、首屏 50 条/15888 bytes、17 DOM 行、60 秒零线程 HTTP、500 progress、锚点/切回偏移均 0、无全历史请求；新增明确断言首次只有一个业务 WS、无 SSE 请求。证据：`…/opencode/bot-sync-web-lFVevT/evidence`。随后分页/消息合并进一步移入 core，最新版本正在重跑，未以先前结果替代。
- BotHistoryModel 单测覆盖账户隔离、稳定快照/no-op、LRU/字节软预算、active/new/pending 不丢失、晚响应不重开审批、nonce 去重、1000 条窗口、500 progress 不更新历史和 deferred/latest 合并；`npm run test:bot-sync` 共 13 项通过。读取锚点/草稿仍归 UI；订阅调度与部分水位仍在 adapter，不能勾选 Bot/全域迁移。
- 最新完整 `test:plugins:e2e`（`sh_1a16f50c7002F4AnwntKCtu3Ci`）失败于原题提取 `worker_mutation_denied:studyDays:missing_permit`。现场授权有 read/write 工具 permit，但 studyDays 是交互页面后台记时写入；Worker realm 与页面同用 `wangke-cloud-${owner}`，因此共享 outbox，工具 finally flush 将页面写入带 Worker token 提交。确定性 fake IndexedDB 回归验证该共享队列问题；现在 Worker 使用 `wangke-cloud-executor-${owner}`，交互数据库名称及旧 outbox 原样保留，不清库、不降低服务端许可。
- `test:cloud:transactions` 7 项通过，含新 executor/UI 队列与确认删除隔离；`test:browser-worker` 通过，并新增无 permit 写 studyDays 仍为 403 的断言。`test:plugins:extraction:e2e` 真实 read/edit、受限写许可、原 Markdown 保留及持久产物收据通过。完整插件原断言正在重跑，不能提前报告整体通过。
- 12 个旧 Vite E2E proxy 配置已同步为 `/api` + `ws:true`，避免只有 `/api/v1` 而遗漏共享 mux；这些脚本尚未全部重跑。
- 六阶段仍为 0/6。普通聊天、资源/偏好/records、Worker 领域接口与旧 outbox 转换、命令事务/文件恢复、上游 SHA/许可闭包、全应用性能与 Safari/PWA/目标代理门槛仍未完成；保留原断言，未提交/推送/部署。

### 本轮后续验证

- 分页/append/deferred 合并移入 core 后 `test:bot-sync:e2e` 再次通过同一 10000/500 progress/60 秒夹具、1 业务 WS 与无 SSE 断言；证据：`…/opencode/bot-sync-web-yuPvOd/evidence`。随后补充尾部裁剪也保留旧窗口中的 pending send 的代码及单测；该最后小改尚待完整重跑。
- 真实 `test:plugins:extraction:e2e` 增加确定性故障夹具：人为阻塞交互页面 records POST，让 studyDays 保持 pending，同时跑 Worker 的真实 read/edit/tool flush；Worker 只提交自身变更、提取及持久产物收据完成，UI outbox 原项仍在；解除阻塞后页面正常提交 60 秒学习时长。新增断言全部通过，不靠“这次刚好没写 studyDays”通过。
- `test:client-runtime`、`check:remote`、`test:boundaries`、core typecheck 重新通过。首次 build 被边界检查拒绝了纯业务参数名 `window`（不是环境访问），已改名 viewport；之后完整 build 通过，Web 实际编译、API/Host/contracts/study-core 缓存。bootstrap 400.34 kB/gzip 102.28，plugin-renderer 69.42/gzip 21.88；保留既有 CSS 与动态/静态 import 警告，未宣称性能阈值通过。

### 异步授权竞态与全局任务列表（继续实施）

- pending-send 裁剪保护后的 `test:bot-sync:e2e` 最终通过，证据 `…/opencode/bot-sync-web-DafuuY/evidence`；`test:plugins:renderer:e2e` 正式入口再次通过 StrictMode/100 次 contexts 归零，`test:client-runtime:sync-locks:e2e` 再次通过。
- Worker/UI 队列隔离后的完整 `test:plugins:e2e`（`sh_1a17743210023uwLG9I4HTR9kC`）退出 1：第 418 行等题库产物 60 秒超时，任务 running，progress 停在第一个 read；对应 read 许可 finished，没有 missing_permit。不能把专项提取通过当作整套通过，也不能将这次停滞未经验证归因于相同许可故障。现场网络/锁与 iframe 诊断在 `…/opencode/plugin-platform-screenshots/{network-failure,page-failure-*}.json`。
- 新增真实 PluginService/Domain 异步读取竞态测试，先失败（Missing expected rejection）：Ajv 按 schema 对象缓存 validate，注销后用同一 schema 注册会复用校验函数。现每次 action activation 分配独立 symbol incarnation，读取 await 后重新鉴权并比对注册身份、插件 revision；组合结果发出前再次整体检查，避免早完成的查询在等待另一项时失效。watch baseline await 后检查 abort，不发布已取消的晚帧。单/组合注销重注册和取消基线测试、API/core 类型检查已通过；随后进一步增加了早完成查询失效用例及 instance 身份比对，等待本轮重验。
- 发现生产 `CloudActivity` 仍每标签每 250ms GET tasks，已删除该 timer。新 `TaskListModel`/正式生成 `watchTasks` 复用账户 mux，使用原 `listOwnerTasks`（active 优先、最多 200 条、保留 source/resourceName），snapshot/delta 与入站/出站/物化任务 codec 校验；账户撤销沿用连接关闭，Worker 不接入账户 Model。现有聊天/jobs/activityStore/window 广播暂为迁移适配，未宣称普通 SessionModel 已完成。
- 该任务列表首轮 `test:client-runtime`、Web/API/core typecheck、`check:remote` 通过。新增真实生产 CloudActivity 专项正在验证进度/终态、60 秒零 task HTTP、StrictMode/100 次释放；完整插件回归另在 `…/opencode/plugin-task-list-stream` 重跑，不提前计通过。
- 任务列表初版完整 `npm run build` 已通过（bootstrap 402.47 kB/gzip 102.49、renderer 69.42/gzip 21.88，保留既有警告）；随后增加 agent_profiles 通知闭包、Model typed 结果缓存及更严格竞态检查，最终版本仍需重验。六阶段仍 0/6，未提交/推送/部署。

### 最终版本实测与上游审计

- 最终 `observedRead` 取消实现后的 `npm run test:client-runtime` 通过：watch abort 不必等待永不完成的 provider，先等待 pending.done/订阅归零，再释放 provider gate；晚 rejection 有处理。单项/组合重注册、组合早完成项失效及 instance 身份重验也通过。
- `npm run test:client-runtime:activity:e2e` 通过生产 CloudActivity、真实 API/WS 的新增/进度/终态推送、60 秒零 task HTTP、StrictMode/100 次释放及单业务 mux。只证明任务列表范围，不证明 records 或普通聊天已迁移。
- 最终 `npm run build`（`sh_1a18a1cca002SVDiscK4pE8N0h`）退出 0，包含 agent_profiles 通知闭包、typed 缓存及 observedRead；API/Web 实际编译，其他三个构建命中缓存。bootstrap 402.58 kB/gzip 102.53，plugin-renderer 69.42/gzip 21.88；既有 CSS `:is()` 与动态/静态导入警告仍在，未完成性能阈值验收。
- 最终 `test:plugins:extraction:e2e`（`sh_1a18a1cca001EsRHDBDualeVce`）退出 0，保留真实 read/edit、写许可、Markdown/持久收据和确定性 UI/executor outbox 隔离断言。
- 完整 `test:plugins:e2e`（`sh_1a184d4ea001bc5AGjKN1g2ENn`）退出 1：第 276 行 reload 后 `getByLabel('练习记录').selectOption(mixedFirstRow)` 超时 30 秒；失败采集时 DOM 已含该 label/select 和两条记录，没有捕获 pageerror。这不足以证明控件在超时前已经出现，也不能归因为选择器错误；本轮未走到之前 Worker read 停滞位置。证据 `…/opencode/plugin-task-list-stream`。原断言不变，另在 `…/opencode/plugin-task-list-recheck` 重跑，尚未计通过。
- 只读 `scripts/audit-client-runtime-upstream.mjs` 对固定 SHA `ce7073d51254c26cd63b22a60835b8f948deb447` 与 registry 审计：16 包 registry integrity 匹配，15 包规范化 manifest 匹配；Cordis 的 bin 和两个 optional peer 尚未核对，脚本因此退出 1。所有包 registry 均无 gitHead/attestations；匹配不证明发布 JS 来自该 SHA。GitHub API 已可用，不再把整个上游验证归为网络不可达。结果 `…/opencode/client-runtime-upstream-audit-final.json`。
- `npm audit --json` 仍有 27 项（1 critical/7 high/13 moderate/6 low），包括 DOMPurify、Zod 与 DSH 传递项；逐项可达性、修复、构建源码对应及完整许可闭包仍未完成。不以 integrity 匹配代替安全验收，不 force fix 或混装 latest。
- 六阶段仍 0/6；完整回归与之前 Worker 停滞根因均未关闭，未提交、推送或部署。

上游清单后续：`client-runtime-upstream-audit-normalized.json` 审计退出 0，16/16 manifest 与 registry integrity 匹配。Cordis 的 bin 字符串与 `{ cordis: 'bin.js' }` 映射归一化后等价；两个未安装 optional peer 已从同一固定 SHA 的 `vendor/include`/`vendor/loader` 清单独立核对，分别为 `1.0.11-alpha.1`/`1.0.7-alpha.1`，未通过安装或 registry latest 补推版本。脚本保留来源 blob 与 installed:false。随后增加已发布 `src/` 文件逐一与该 SHA Git blob 哈希比对，结果另行采集；不把清单匹配升级为发布 JS 构建对应、安全或许可闭包通过。

源码比对结果（`client-runtime-upstream-audit-sources.json`，退出 1）：Cordis 已发布 9 个 src 文件中 6 个与固定 SHA 不同（context/events/fiber/logger/reflect/utils），cosmokit 7 个、schemastery 1 个相同；其余 13 包未发布 src，结果为 null 而不是通过。后续 GitHub contents 请求返回 403，本轮未重新完成全部清单/registry 核对，前轮完整清单证据单独保留，不合并成一次全通过。通过固定 SHA codeload archive 取得原文并生成 `…/opencode/cordis-source-diffs.json`：差异包含事件 symbol/派发与 waterfall、防重复 next、provider/dependent teardown、配置更新语义、logger 等级，并非可忽略的换行/发布替换。当前固定版本与固定源码 SHA 不等价，这是未解决的上游对应问题；不得仅用同版本号、清单或完整应用测试通过代替。未修改 node_modules、锁文件或依赖版本。
