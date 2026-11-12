# Live Link 遗留改动归档

主线已在 `657c6f3`（Move Bilibili import to the server and retire live share）移除实时共享功能。

合并 `feat/live-link-p2` 的未提交改动快照 `2ffc97d` 时，将下列文件原样归档，保留设计修订和共享测试装置，不恢复已下线的功能或测试入口：

- `2026-10-13-live-link-p2-design.md`：原 `docs/plans/2026-10-13-live-link-p2-design.md`。
- `scripts/e2e-livelink.mjs`：原 `scripts/e2e-livelink.mjs`。
- `scripts/livelink-e2e-harness.mjs`：原 `scripts/livelink-e2e-harness.mjs`。

这些脚本依赖旧版 Live Link 页面与协议，只作历史参考，不属于当前主线的可运行测试。原始路径与完整实现仍可在 `feat/live-link-p2` 的 Git 历史中查阅。
