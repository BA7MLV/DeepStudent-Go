# 沙箱加固记录

在原有 `--cap-drop=ALL`、`no-new-privileges`、只读 rootfs、资源限额、默认断网的基础上，2026-11 新增三层加固。实现见 `infra/sandbox/`。

## 自定义 seccomp profile

`infra/sandbox/seccomp.json` 以 moby v26.1.5 默认 profile 为基线，删除了所有按 capability 放行的 ALLOW 项（改为默认拒绝，即使将来误加回 cap 也挡住），并移除默认 profile 对 `ptrace`/`process_vm_*` 的无条件放行。`bpf`、`perf_event_open`、`userfaultfd`、`unshare`、`mount` 等保持默认拒绝。普通用户态（bash、python、git、解压工具）所需 syscall 全部保留。

- broker 启动时校验 profile 存在，缺失即拒绝启动，而不是每条命令报 `sandbox_start_failed`。
- 滚动升级期间可用 `SANDBOX_SECCOMP_PROFILE=none` 显式关闭；默认路径随镜像发布。

## 镜像固定

broker 启动时 `docker image inspect` 解析 `SANDBOX_IMAGE` 的镜像 ID 并打日志；设置 `SANDBOX_IMAGE_ID` 后，不匹配即拒绝启动。升级流程在切换前记录新镜像 ID 即可实现固定。

## 工作区磁盘配额

`infra/sandbox/quota.mjs`：

- `SANDBOX_WORKSPACE_QUOTA`（默认 `2g`，支持 `512m`、`10g` 等）限制每个 thread volume / project bind mount 的用量。
- 每次执行前检查；超限返回 `sandbox_workspace_quota_exceeded`（409），命令不执行，直到用户清理工作区。文件读取（`/files/read`）不受限，便于检查与恢复。
- project 工作区由 broker 直接在 bind mount 上统计；thread volume 通过一次性 `du` 容器统计。
- compose 侧通过 `WANGKE_SANDBOX_WORKSPACE_QUOTA` 覆盖。

验证：`node scripts/test-sandbox-quota.mjs`；带 Docker 的集成路径仍走 `npm run test:sandbox`。
