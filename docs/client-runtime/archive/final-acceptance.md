# 客户端底座最终本地验收

> 历史冻结记录：以下 identity/28 项结果属于浏览器执行器退役之前的源码，不是当前服务器执行版本的验收结论。当前规范见 [当前架构](../../architecture.md)，任务执行见 [服务器独立任务执行](../../server-task-execution.md)；本文原证据保留不改写。[归档导航](./index.md)。

2026-11-04；获批六阶段计划 **6/6**。P4/P5 的三条本地门槛已关闭；没有提交、推送、部署、清库、付费模型或真实外部 IM。此结论不代表真机、XCTest 或目标部署验收。

## 最终证据和退出码

证据根：`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/`。

- **最终目录 `client-final-freeze-QughC6`**：`results.json`（全部有效结果 code=0；每项原命令、环境、起止时间和日志来源）、`identities-before.json`、`identities-after.json`、两轮导入日志、`performance.log`。最终 runner 实际退出 **0**。
- 完整构建及业务日志在 **`client-final-freeze-ht6dDv`**；最终 results 的 `evidenceDirectory` 逐项指向这里。完整插件原业务断言/原超时通过（04:09:48–04:13:54 UTC）；完整 cloud、Node edit、Bot、聊天/executor、双引擎/native 均通过。
- 冻结续接只复用 source/build identity **完全相同**的绿色结果。最后仅测试夹具和文档变更，没有生产源码/依赖/产物变化；导入顺序两轮通过后，04:17:54–04:20:48 UTC 独占运行性能，不与其他测试并发。没有为了规避失败跳过任何有效门禁。

实际成功命令：

```sh
node scripts/freeze-client-runtime.mjs --resume /private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/client-final-freeze-YriHbp
```

完整重建和重新验收入口为 `node scripts/freeze-client-runtime.mjs`。续接入口先比较 source/build identity，不一致便拒绝复用；旧失败保留在原目录及 `superseded` / `previous` 证据链，不会改写为绿色。

## 冻结身份

| 身份 | SHA256 |
| --- | --- |
| 当前真实构建产物 | `c87ab8bc1a60fceb72641ec106c49ac44da591b42a790d8b5675b4b41fd3aee1` |
| 当前领域源码集合 | `d8f152bad8feb5995b02e674c0203aba457c2dabe7dd04aa6694d582af6ba269` |
| 独立干净 HEAD 基线产物 | `4e159726d86a4447f5fceeffd1cc988d27c69c7ef1362ed9953b657b180a21fb` |

产物集合为 `apps/web/dist`、`apps/api/dist`、`packages/remote-artifacts/generated`；按相对路径排序，SHA256 输入逐文件为 `relativePath + NUL + bytes + NUL`。源码集合明确为 `apps/web/src`、`apps/api/src`、`apps/api/runtime`、`packages/contracts/src`、`packages/client-core/src`、`packages/remote-host/src`、生成产物；不是 Git commit SHA，也不冒称包含文档/测试的全工作区 hash。前后文件相同；性能脚本另行计算的 current 产物身份与本表相同。

## 门禁覆盖

最终 results 包含 build、check:remote、AST boundaries、plain Node compiled API/Host/codec、生产许可、client runtime、16组 products、executor runtime/interactions、实际 executor chat、实际 QA/artifactEdit 19入口、worker producers/Blob、Node edit、完整 cloud、完整 plugin platform/extraction、Bot model/UI、chat followup、session queue、Chromium、WebKit、生产 PWA、native 协议/任务交互、导入两轮和性能，均 code=0。

- `executor-entries-JitSjy/evidence.json`：公开 runQa/editArtifact → Browser Worker → 本地 HTTP 模型夹具；完成丢响应、执行中刷新/取消/撤权、lease/parent/account/resource 隔离、精确 consumed permit/消费后撤权、产品丢响应。未知执行不重跑模型，原任务/输入/日志保留。
- `executor-chat-ui-mlk7wF`：ask/confirmPlan/cancelPlan 各 normal、before-executing、before-effect、after-effect；任务限定目标、snapshot/effect receipt、旧 lease 冻结、inspection 克隆拒绝、同 identity checkpoint 续接及凭证据 settle。确认计划必须同时具备原资源移动和目标产品收据；未知效果 hold，不声称普适 exactly-once。
- `executor-interactions-Hq3BN3`：额外服务端无证据 resume/settle、stale observation、跨 task sequence、匿名及 Worker 混 Cookie 权限拒绝。
- 未受本轮修改影响的旧库完整嵌套/偏好/映射、ASR、文件故障和其他大型专项保留既有证据，详见 p4-p5-review.md，不无限重跑或把历史身份当当前构建。

## 独占性能

`client-head-comparison-cSZONz`：同一 board/todo 夹具、每版本三轮、测前静稳5秒，原阈值未调；`comparison.json`、`thresholds.json`、`output-identities.json` 和逐轮结果均保留。仅对该夹具作性能结论，不推广到全应用页面。

| 项目 | 干净 HEAD | 当前 | 结论 |
| --- | ---: | ---: | --- |
| 首屏 ms | 856.04 | 881.11 | 通过 |
| 输入 ms | 42.46 | 41.27 | 通过 |
| 投影 ms | 4855.38 | 203.94 | 通过 |
| heap bytes | 15,007,264 | 15,857,084 | 通过 |
| JS bytes | 3,390,621 | 2,966,286 | 通过 |
| idle business HTTP | 0 | 0 | 通过 |

## 失败保全与测试对齐

- `client-final-freeze-xAL9Zd`、`plugin-platform-ui-UKT8hQ`、`plugin-platform-ui-xPet7b`：旧插件夹具直接写云 IDB videos/files、随后以空 expected 覆盖已存在但无领域映射课程，以及从旧 files 表读新题库，分别被拒绝/无法取证。改为真实 saveMarkdown 创建领域课程、flushCloud 只读投影，以及 courseDocument 权威文件取证。原学习、跨位置、题型、模板、审批、原文保全等断言和超时不删减。
- `client-final-freeze-ht6dDv/import-second.log`、`library-import-ui-hGdFvo`：复现二进制计数1而非2；证明早期 route barrier 尚不足以结案。修正等待导入自身 busy 结束而非通用 sync 错误文本，快照故障增加显式 barrier，防止刷新与旧动作竞跑。
- `client-final-freeze-YriHbp/import-first.log`、`library-import-ui-wpWF2J`：发现等待 raw IDB 已有 draft 后，另一临时 Dexie 观察连接却读到 null；取证统一为原账户 raw IndexedDB、busy 完成后再读。未据此修改生产迁移语义，也不声称已唯一重建每次历史失败的时序。最终两轮保留 network.json；两个唯一 Blob 上传、首个丢响应仅查原收据、快照不重提、原 operationId/Blob/outbox/未知字段完整导出断言全部通过。
- 更早 `library-import-ui-qd6NEz`、`cloud-e2e-wHEvom` 等失败均保留，不删除或伪装为通过。

## 外部未验（不计本地未完成）

当前只有 CommandLineTools，`swift test` 所需 XCTest/Xcode 不可用；native 协议 harness 不等于 XCTest、iOS simulator、签名安装或真机 Safari。真机/OS PWA 安装与跨版本升级、目标远程代理/部署、隔离 Docker/VPS separation 仍未验；没有为此执行破坏性操作或发布。现有静态模式、Gateway/学习/IM、资料任务、HTML sandbox+受限 bridge 保留；断网不切换本地权威。
