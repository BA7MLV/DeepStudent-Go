# 可安装插件模板

四个子目录是完整 v2 包：`counter`（CAS 共享数据）、`material-note`（资料 A/B 上下文隔离）、`bot-task`（真实 Bot 任务与重新挂载恢复）、`cards-reader`（显式依赖与替代学习视图）。

使用当前账户的系统文件编辑入口，将一个子目录的 **内容** 写入 `/system/plugins/<manifest.id>/`；不要写入仓库源码或猜测账户物理目录。新文件用 `expected="" / revision=0`，已存在文件先读再 CAS 保存。HTML/defaults 先写，manifest 最后写；包自动发现后，在“管理插件”中创建实例及挂载。也可由 Chat/Bot 使用已有 `edit` / `board` 文件工具安装，再通过 `plugins` 的 `list / layout / configure` 配置。改名时同时修改目录和 manifest.id。

- `counter`：同一实例挂看板与侧栏，两处加一互相同步；独立实例互不影响。冲突提示后刷新，不重放加一操作。示例同时订阅 mount/state.changed/dispose。
- `material-note`：资料作用域实例和 reader 挂载；每份资料使用原 ID 索引，异步保存固定原上下文。尺寸/主题变化不重载未提交输入；迟到的初次 context.get 不覆盖新资料事件；A 的迟到保存不替换 B 正在编辑的内容。刷新只恢复已点保存的便签，未提交内容不承诺跨刷新恢复。这里保存的是插件自有便签，不复制题库、cards 或错题记录。账户实例在没有 materialId 的看板位置只显示提示。
- `bot-task`：先创建真实 Bot 会话；下拉选项来自宿主，不能猜 threadId。任务请求及 nonce 先 CAS 持久保存，重新挂载以相同 nonce 找回同一 run；页面轮询仅用于显示，不是后台自动化。共享实例只允许一个最新请求槽位；如需并行任务，请新建实例。完成状态与学习产物提交不同，只有专用宿主领域动作能提供学习产物收据。
- `cards-reader`：纯 HTML 替代卡片列表，通过 `learning-data` 宿主服务声明、`flashcards:2` 显式依赖和 `cards.list` 动作读取原权威数据。停用 flashcards 后该视图与动作一同撤销，恢复后不复制数据、不触发生成。不是原生受信权限的替代品。

模板没有外部网络、父页面 DOM 或任意文件能力。manifest 中的 action schema 是说明；`plugins describe` 返回实际宿主 schema。动态包不能调用 trusted-only 练习快照动作。主题/字号由宿主注入，模板使用语义基础样式，不自建深浅色主题。
