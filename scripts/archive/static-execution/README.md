# 已退役的浏览器执行测试

这里保留历史测试源码，供追溯旧协议，不参与当前执行。引用的本地模型/worker 生产模块已删除，不能通过恢复这些模块让旧测试通过。

- `test-jev.mjs`：旧浏览器 `/systemone`、技能路由与本地压缩。原入口现运行服务端压缩准入/CAS、真实 chat/QA/续写 Gateway 历史消费，以及禁止浏览器模型直连专项。专有协议本身已退役，不宣称与服务器原生筛选模型等同。
- `e2e-worker-products.mjs`：旧 browser worker token/product commit 协议。原入口现运行服务端插件学习产物、真实 browser command/receipt/投影故障矩阵与显式历史 journal/Blob 恢复，不再受理旧 worker 写入。

当前边界见 [架构](../../../docs/architecture.md)。
