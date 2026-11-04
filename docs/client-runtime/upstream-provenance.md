# DSH 上游来源、重建与许可核验

核验日期：2026-11-03。此文件补充 ADR/baseline 的历史记录，不把清单匹配当源码对应，也不表示六阶段验收完成。

## 最小修复已落实（当前状态）

- 已从 Web 声明及 lock/安装树删除未使用的 `dsh-client-store`。保留其余 DSH 精确版本；没有补 Immer、升级整个 DSH 或 force fix。
- 根 overrides 仅对 `dsh-client-connection`、`dsh-typert-registry` 的 Zod 指定 `4.6.7`；remote-artifacts 直接依赖也固定 `4.6.7`。原先三个 `4.4.3` 嵌套安装均消失，统一解析到根 `node_modules/zod@4.6.7`。lock 中上游包的原始依赖声明 `4.4.3` 仍如实保留，不能把该声明误判为实际安装版本。
- `packages/dsh-typert-protocol-source/PROVENANCE.md` 已纠正为真实 tag/SHA；协议源内容未改。ADR/baseline 留给主实施者，不在本次修改范围。
- 新审计 **退出 0**：15 包身份/源码通过；62 个发布 JS 中 61 个逐字节相同，renderer 一个文件仍仅有三个 region 路径注释差异；26 个安装包实例、两个内嵌来源均有完整许可；缺依赖边 **0**，闭包安全条目 **0**。这是实际复核结果，不是预计结果。
- `npm run check:remote` 通过；未运行写入式 generate，未改 Remote 声明/正式生成物，当前不需要重新生成。若主实施者继续修改声明，应由其执行 generate/check。

### 已接入实际发行产物的许可

`licenses/client-runtime/THIRD_PARTY_NOTICES.txt` 是本次全通过审计的完整原文合集，包含内嵌 `use-sync-external-store@1.6.0`、DSH util-crypto、TypeScript `ThirdPartyNoticeText.txt`；不是只有 SPDX 名称。`provenance.json` 固定 tag/SHA、archive hash、审计/lock/文本 hash、实际闭包版本/integrity 和通过结果。该合集明确只覆盖 DSH 闭包，含 build-only generator 通知，不冒充全应用许可证清单。

`scripts/build-client-runtime-licenses.mjs` 离线核验文本 hash 和 lock 中相关安装版本/integrity，支持 Docker 裁剪闭包（允许通知超集，不允许已出现包版本静默变化）。刷新只能消费同一固定源、全部门槛通过且 lock 未漂移的来源审计 JSON：

```sh
node scripts/build-client-runtime-licenses.mjs --refresh "$TMPDIR/opencode/dsh-patched-provenance.json"
node scripts/build-client-runtime-licenses.mjs --check
```

- Web workspace `postbuild` 写入 `apps/web/dist/THIRD_PARTY_NOTICES.txt` 与 `client-runtime-provenance.json`；根 `build` / `build:web` 也在 Turbo 后复制，避免缓存命中时跳过最新通知。静态发行可通过 `/THIRD_PARTY_NOTICES.txt` 获取。Web Docker build 显式带入专用脚本/许可快照，既有 dist → `/srv` 复制自动带入它们。
- 根 `build` / `build:api` 在原有命令之后把同一通知/来源清单写入 `apps/api/dist`。API Docker runtime 显式复制快照到 `/app/apps/api/dist/`，不依赖 devDependencies 在 prune 后存在，也不引入 Web 源码。未修改 API package 脚本。
- 不改变业务构建配置，不删除 renderer 的 `@license` 或已安装包的 LICENSE/NOTICE。专用测试经真实 `dshEsm` carrier adapter 和 Vite 5.4.21 默认生产压缩后，断言两个内嵌 React shim 的 `@license`、文件名和版权声明仍保留。

### 修复后实测

以下均通过；没有并发运行完整应用 build、Docker build 或重启共享服务：

```sh
npm run check:remote
./node_modules/.bin/tsx --test scripts/test-runtime-projection.mjs
./node_modules/.bin/tsx scripts/test-client-runtime.mjs
./node_modules/.bin/tsx scripts/e2e-client-runtime.mjs
npm run test:plugins:renderer:e2e
./node_modules/.bin/tsx scripts/test-client-runtime-licenses.mjs
```

projection 3/3；runtime 覆盖真实 HTTP/WS、auth/origin、durable receipt/uncertain receipt、共享 lifetime/100 次释放、Task/SessionModel、scope/query 边界；Chromium 测试覆盖真实 Fastify/WS、Slots 投影与 disposal；renderer 测试覆盖 StrictMode 与 100 次挂载/卸载。API 使用临时库和独立监听端口，Vite 测试启动独立实例，未碰现有服务。许可测试仅内存构建 renderer fixture，并在临时 Web/API 目录验证文件原样打包，不运行完整应用构建。

证据目录均为下文同一 `…/T/opencode/`：`dsh-patched-provenance.json`、`.json.licenses.txt`、`.log`，`dsh-patched-npm-audit.json`，以及 `dsh-patched-{check-remote,projection,runtime,browser-runtime,renderer,licenses}.log`。全仓 audit 仍可能退出 1，但当前 DSH 闭包的 `security.affected` 为空；未把全仓其余问题当作本次阻塞或已修复。最终完整 build/镜像验证由主实施者统一执行。

以下保留首次 16 包审计与修复前问题的历史证据；涉及“建议/待主实施者”的描述以本节实际落实状态为准。

## 结论：参考 commit 选错，不是另一个 Cordis 仓库

应锁定真实发布 **`dsh-v0.2.2-alpha.2` → `f3803c96974ad4a94195fb97e5c637e9c2a3afe3`**，保持当前 DSH `0.2.2-alpha.2`、Cordis `4.0.6-alpha.1` 等精确 npm 版本。

- `git ls-remote --tags https://github.com/deepseek-ai/deepseek-harness.git` 返回该 tag 的完整 SHA；不是猜测 npm latest，也不需要 GitHub contents API。
- 固定 SHA 完整 codeload archive SHA-256：`798cab9a2acbc886a40ad9f7916e52f9380fbd4b51b41f685f3ed681f77e0ccb`。
- 原参考 `ce7073d51254c26cd63b22a60835b8f948deb447` 的 Cordis 6 个实质差异不能忽略。但发布包的 **9/9 Cordis src 文件与上述发布 tag 逐字节相同**；Cosmokit 7/7、Schemastery 1/1 也相同。
- 更重要：从该 tag 的原始 TS、原始包级 tsdown 配置及明确的生产依赖投影，实际重建了 **16/16 包中的全部 63 个已发布 JS 文件**。**62 个逐字节相同；renderer 的 `lib/client.js` 只差三个 `//#region` 依赖路径注释**，除此之外（包括许可注释）相同。没有以 AST、格式化、删注释或语义近似掩盖差异。
- 16/16 registry integrity、实际下载 tarball integrity、tarball 内全部文件与已安装文件、规范化生产 manifest 均相同。vendor LICENSE 与包 LICENSE 相同；13 个 DSH 包发布时复制根 MIT LICENSE，不能要求源码子目录存在独立 LICENSE。
- `packages/dsh-typert-protocol-source/src` 虽记录旧 SHA，但与发布 tag 的协议 src 全部相同。只需纠正其来源记录，不必重新移植或手改生成物。

因此已取得符合批准计划“同一真实 commit/tag”的可复核源码集，**不必更换 Cordis 源仓库、混装新版本或 vendor 整个 DSH 产品**。DSH 的 `vendor/README.md` 明确记录 Cordis 来自 cordiverse/cordis `56b3d4f725681cf4556c1a8695a709cc3b6eed74`，并列出 DSH 的本地修改；那个祖先 SHA 不是当前发布包应对比的直接源码。直接来源是本次 DSH 发布 tag 内的 vendor 树。

这不是把“原始 tarball 就算源码”作为降约束方案：源码 tag 和实际发布内容已通过重建连接起来。没有上游签名构建证明（registry `gitHead`/attestations 仍均为空），也没有声称完整上游 typecheck/test 通过。

## 首次 16 包来源清单（修复前历史）

以下名称均带 `@deepseek-ai/` 前缀；最后一列是核验的已发布 JS 数量，包含发布的 `lib/types/*.js` 及 Cordis `bin.js`。每个文件、tarball URL、integrity、SHA-256 和重建结果均在 JSON 报告中；依赖锁仍以根 `package-lock.json` 为准。

| 包 | 精确版本 | 发布 tag 中源码目录 | JS |
| --- | --- | --- | ---: |
| cordis | 4.0.6-alpha.1 | vendor/cordis | 2 |
| cosmokit | 1.8.7-alpha.1 | vendor/cosmokit | 1 |
| schemastery | 3.18.6-alpha.1 | vendor/schemastery | 2 |
| dsh-api-gateway | 0.2.2-alpha.2 | packages/api/gateway | 15 |
| dsh-brand | 0.2.2-alpha.2 | packages/util/brand | 1 |
| dsh-client-connection | 0.2.2-alpha.2 | packages/client/connection | 3 |
| dsh-client-store | 0.2.2-alpha.2 | packages/client/store | 1 |
| dsh-client-ui-renderer | 0.2.2-alpha.2 | packages/client/ui-renderer | 2 |
| dsh-client-ui-slots | 0.2.2-alpha.2 | packages/client/ui-slots | 1 |
| dsh-credentials | 0.2.2-alpha.2 | packages/credentials/credentials | 3 |
| dsh-deque | 0.2.2-alpha.2 | packages/util/deque | 1 |
| dsh-scope | 0.2.2-alpha.2 | packages/core/scope | 1 |
| dsh-timeout | 0.2.2-alpha.2 | packages/util/timeout | 1 |
| dsh-typert-generator | 0.2.2-alpha.2 | packages/typert/generator | 13 |
| dsh-typert-protocol | 0.2.2-alpha.2 | packages/typert/protocol | 9 |
| dsh-typert-registry | 0.2.2-alpha.2 | packages/typert/registry | 7 |

Optional peers `cordis-plugin-include@1.0.11-alpha.1`、`cordis-plugin-loader@1.0.7-alpha.1` 的版本从同一 tag 的 vendor manifest 取得；它们未安装，不计入实际发行闭包，不为核验而安装。

## LICENSE / NOTICE 闭包

16 包全部 MIT：

- 三个 vendor 包：`Copyright (c) 2021-present Shigma`；各包 LICENSE SHA-256 `034fb52b1d57360ecbae6cb1632a88f86fd7c3d3f5631a5f082710203dda0be7`。
- 其余 13 包与内嵌 `dsh-util-crypto`：`Copyright (c) 2026 DeepSeek`；根/发布 LICENSE SHA-256 `ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`。

审计遍历 dependencies、已安装 required/optional peers、实际遗漏的运行时 import，并加入本项目 remote-artifacts 的 Zod。当前得到 34 个已安装包实例（含 16 个 DSH 包；同名多版本/多安装路径分别保留），另有两个内嵌源码条目：

| 外部包/源码 | 实际版本 | 许可/必须保留文件 | 来源 |
| --- | --- | --- | --- |
| @standard-schema/spec | 1.1.0 | MIT / LICENSE | standard-schema/standard-schema |
| ws | 8.22.0 | MIT / LICENSE | websockets/ws |
| zod | 4.4.3 ×3、4.6.7 | MIT / LICENSE | colinhacks/zod |
| zustand | 5.0.15 | MIT / LICENSE | pmndrs/zustand |
| react、react-dom | 19.3.0 | MIT / LICENSE | facebook/react |
| scheduler | 0.28.0 | MIT / LICENSE | facebook/react |
| use-sync-external-store（安装） | 1.7.0 | MIT / LICENSE | facebook/react |
| use-sync-external-store（renderer 内嵌） | **1.6.0** | MIT / LICENSE；保留 factory 内 @license | facebook/react |
| @types/react | 19.3.0 | MIT / LICENSE | DefinitelyTyped/DefinitelyTyped |
| csstype | 3.2.3 | MIT / LICENSE | frenic/csstype |
| @jridgewell/gen-mapping | 0.3.13 | MIT / LICENSE | jridgewell/sourcemaps |
| @jridgewell/sourcemap-codec | 1.6.0 | MIT / LICENSE | jridgewell/sourcemaps |
| @jridgewell/trace-mapping | 0.3.31 | MIT / LICENSE | jridgewell/sourcemaps |
| @jridgewell/resolve-uri | 3.1.2 | MIT / LICENSE | jridgewell/resolve-uri |
| typescript（generator，build-only） | 6.0.3 | **Apache-2.0 / LICENSE.txt + ThirdPartyNoticeText.txt** | microsoft/TypeScript |
| dsh-util-crypto（Gateway 内嵌） | 0.2.2-alpha.2 | MIT / DSH 根 LICENSE | 同一 tag 的 packages/util/crypto |

renderer 的内嵌 shim 版本来自发布物的 pnpm region 路径，已独立下载 `use-sync-external-store@1.6.0` tarball 核对 integrity，并用其精确内容重建 factory；不能用本项目安装的 1.7.0 许可证/版本记录替代内嵌来源。其 integrity 为 `sha512-Pp6GSwGP/NrPIrxVFAIkOQeyw8lFenOHijQWkUTrDvrF4ALqylP2C/KCkeS9dpUM3KvYRQhna5vt7IL95+ZQ9w==`。

上述已安装/内嵌闭包不存在缺 LICENSE 的包。脚本生成 `<OUTPUT>.licenses.txt`：按内容去重，但保留所有包名/版本/路径归属，包含**完整原文**（不是 SPDX 清单），并包含 TypeScript 的第三方 notices。本次约 60 kB。JSON 同时保留每份文本及 SHA-256。没有把 DSH 全产品的 Anthropic、LibreOffice、Landlock、Python 等无关许可装进本闭包。

源 archive 的 `THIRD_PARTY_NOTICES.md` SHA-256 为 `f2bb2d12757eab74445aff547b86b68245aaa6d0bdb36ec00392fd52edd17d05`；`vendor/README.md` 为 `9479200e228f66dab061ee5f426b2521c4634186bf5c588efbc8d8490c120c5d`。它们是来源证据，不替代上述精确闭包通知。

首次审计时发行通知尚未接入；现已由上述专用脚本和 Docker 复制行落实。审计工具链自身的临时安装不是应用运行时闭包。

## 首次审计发现的局部问题（修复前历史）

### 1. 删除未使用的 client-store 依赖，而不是添加第二套状态引擎

实际全仓源码搜索没有 `dsh-client-store` 的 import；只有 `apps/web/package.json` 声明及锁文件。该包的发布 `lib/index.js` 有 `immer`、`zustand/*` bare imports，但只把它们放在 devDependencies。当前缺 Immer；本项目已有 Zustand 5.0.15，并非其开发时的 4.5.7。

最小方案：由主实施者从 Web workspace 删除该**未使用**声明并更新锁。这样实际闭包从 16 个减为 15 个，不改变本次历史 16 包审计证据；不移除 Cordis、Connection、Typert、Slots/renderer。若未来确需上游 snapshot-store，必须显式补齐、锁定兼容的依赖并验证，不能靠当前遗漏的 Immer 恰好未加载。

```sh
npm uninstall -w @wangke/web @deepseek-ai/dsh-client-store
```

### 2. 仅修复新增闭包里的 Zod 公告

`npm audit` 在此闭包只指向 **GHSA-mrhx-c7xc-m3w5**（Zod oversized constrained collections 内存耗尽，high，受影响 `<4.6.6`）。两个 DSH meta 条目只是这个 Zod 问题的传播，不是另外两个漏洞。实际受影响安装为：

- `node_modules/@deepseek-ai/dsh-client-connection/node_modules/zod`：4.4.3。
- `node_modules/@deepseek-ai/dsh-typert-registry/node_modules/zod`：4.4.3。
- `packages/remote-artifacts/node_modules/zod`：4.4.3；这是本项目生成 codec 的依赖，不能漏掉。

协议包的 `^4.4.3` 当前已解析至根 `zod@4.6.7`。没有在本工作单元执行漏洞 PoC，也不因 Connection/Registry 某条代码路径不调用 collection parser 就宣布不可达；生成 codec 正在处理不可信输入。现有边界/大小限制应保留。

精确局部修复建议：将 remote-artifacts 的直接 Zod 改为 **4.6.7**，并在根 overrides 仅为以下两个父包覆盖子依赖到 **4.6.7**；不要升级 DSH/Cordis 到 latest：

```json
{
  "overrides": {
    "@deepseek-ai/dsh-client-connection": { "zod": "4.6.7" },
    "@deepseek-ai/dsh-typert-registry": { "zod": "4.6.7" }
  }
}
```

这是明确记录的**传递依赖安全补丁**，不是声称上游 alpha.2 原来发布的精确依赖就是 4.6.7。脚本比较 DSH 发布 manifest 不会掩盖 override：实际 closure/lock 会显示修复后的解析版本。若运行时回归失败，才需要最小 vendor patch 两个 manifest 并保留来源/补丁记录；当前没有必要预先 vendor 核心。

主实施者添加上述 overrides 后执行 `npm install -w @wangke/remote-artifacts zod@4.6.7 --save-exact`，重新检查 lock 的三个实际安装路径及 `npm audit --json`，不要使用 force fix。

其余全仓 27 条 audit 中的 DOMPurify/Vite 等不属于此次新增 DSH 闭包，不作为这个来源核验的无限阻塞项；本文件没有对它们出安全豁免。

### 3. 更新来源说明，不改业务/协议内容

主实施者应将 ADR 中的参考源码改为真实 tag/SHA，并将 `packages/dsh-typert-protocol-source/PROVENANCE.md` 的 SHA 改为此 tag，注明本次 src 字节无变化；baseline 历史失败证据保留，只追加本次结论。计划无需改变技术约束。

## 可复核命令与实测证据

脚本只写指定输出和新的 `…/T/opencode/dsh-provenance-*` scratch，不安装依赖、不修改源码 checkout/node_modules/锁文件。下载固定完整 archive，而非循环重试 GitHub 403。可选 `--cache-dir` 复用前次 scratch 的原始 tgz；仍验证 archive 固定 digest、npm tarball integrity 和 registry 元数据。

临时审计工具链需从新的空目录安装，先给定 Rolldown override，避免 tsdown 的 `~1.1.x` 自动解析为另一编译器。以下所有安装均在临时目录，而非本项目：

```sh
TOOLS="$TMPDIR/opencode/dsh-rebuild-tools"
mkdir -p "$TOOLS"
cat > "$TOOLS/package.json" <<'JSON'
{"private":true,"dependencies":{"tsdown":"0.22.2","rolldown":"1.1.1","typescript":"6.0.3","lightningcss":"1.32.0"},"overrides":{"rolldown":"1.1.1"}}
JSON
npm install --prefix "$TOOLS" --ignore-scripts --no-audit --no-fund
npm audit --json > "$TMPDIR/opencode/dsh-current-audit.json"
node scripts/audit-client-runtime-upstream.mjs "$TMPDIR/opencode/dsh-proof.json" \
  --rebuild-tools "$TOOLS/node_modules" \
  --audit-json "$TMPDIR/opencode/dsh-current-audit.json"
```

`npm audit` 有命中时会退出 1，仍会写 JSON；不要用 `&&` 把后续核验短路。不传 `--rebuild-tools` 时重建结果为 null，脚本仍退出 1，不把缺证据变成通过。脚本有意不执行完整上游 typecheck，而是 TS6 program emit（保留跨文件 const enum 内联）+ 原始包级 tsdown 配置的内容重建；这与本项目的 typecheck/build/真实 HTTP/WS 测试是不同门槛。

本次最终实测文件位于：

`/private/var/folders/2r/zv45t_9d6ljfqfj6l1r0yvtr0000gn/T/opencode/`

- `dsh-provenance-verified.json`：16 包文件级 SHA、63 个 JS 重建、34 个安装实例/两个内嵌来源、完整许可文本、局部 audit 归因。
- `dsh-provenance-verified.json.licenses.txt`：完整可分发的闭包 LICENSE/NOTICE 合集。
- `dsh-provenance-verified.log`：实际构建与 summary。
- `dsh-provenance-NYg0Mq/`：原始固定 archive、逐包原始 tarball、原始解压源码及隔离重建树。
- `dsh-closure-npm-audit.json`：本次 audit 原始输入。

结果：`identityAndSources:true`、`reconstruction:true`、`closureLegalFiles:true`、`buildOnlyProtocolCopy:true`；**退出 1 仅因一个缺 Immer 边及上述 Zod 公告（3 个传播条目）**，不是源码来源未解决。

完成上述局部依赖处理后重新运行审计，再运行：

```sh
npm run generate:remote
npm run check:remote
npm run test:client-runtime
npm run test:plugins:renderer:e2e
npm run build
```

上述为首次审计后的建议命令，不是此次全部执行记录。当前已实际完成依赖修改和独立回归，见顶部；15 包与移除三个 4.4.3 安装均已验证。生成物不得手改；最新业务声明的 generate 和最终完整 build 仍归主实施者。
