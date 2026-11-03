# 真实工具与持久布局

以本轮工具 schema 为准。`plugins` 的所有入口共用服务端验证；技能不授权任何调用。

## 发现和作用域

- `plugins({"operation":"list"})` 返回 `plugins`、解析后的 `layout`、`surfaces`、`scopes`。`scopes.projects/materials/materialProjects/projectFolders` 提供真实名称和归属，`unavailableInstances` 不可运行。不要捏造资料或 Bot thread ID。
- `plugins({"operation":"describe","pluginId":"<目录ID>"})` 返回 manifest 及可用动作 schema/revision；只调用实际返回的动作。
- `plugins({"operation":"layout"})` 返回 `{path,content,revision,...}`，这里的原始 `content` 才是 CAS 的 expected，不是重新序列化后的旧对象。
- 位置：`board.main` 看板，`chat.sidepanel` 聊天侧栏，`reader.sidepanel` 阅读侧栏，`app.page` 完整页。仅选择 view 声明支持的位置。`chat.message` 用 reference；`chat.composer.actions` / `reader.selection.actions` / `resource.actions` 的 placement.viewId 是 **contribution ID**，不是其指向的 view ID。
- 范围 `{kind:"account"}` 或 `{kind:"project"|"material",id:"真实ID"}`；实例范围不能靠改 placement 越权扩大。账户实例可供兼容的局部位置共用。资料/项目已有归属不要擅自合并。

## 写包：三个执行环境，不是一个虚构的 write 工具

新包文件路径 `/system/plugins/<唯一小写slug>/views/main.html`、`defaults.json`、`manifest.json`。先列目录防撞名；已有同名文件先读，不用 create 覆盖。父目录由结构化保存创建。新文件按“视图→默认值→manifest”顺序写，失败时不挂载。

### Web Chat：read/edit 资源工具

```json
{"path":"/system/plugins"}
```

上述参数传 `read`。目录分页跟随 `nextOffset`；文件 `read` 的 `offset/limit` 按 **零起始行**，最多 50 行；长文件按返回提示读完，不将带行号/说明的结果当原文。

创建用 `edit({path,create:true,content:"完整文件文本"})`；更新用 `edit({path,edits:[{old_string:"精确唯一原文",new_string:"新文"}]})`。Web 资源 edit **不接受模型提供的 revision 参数**：宿主读取当前文档并以原文/revision CAS 保存。匹配/冲突失败时重读再算；跨设备布局最好统一使用 plugins.configure。

### Native Chat / 原生学习执行器：board

`board({action:"list",path:"/system/plugins",offset:0})`；`board({action:"read",path})` 返回 JSON `content/revision/nextOffset`，文件分页以 **UTF-16 字符 offset**，每页 8000，后续 read 传同一 revision，拼齐原文后再改。

`board({action:"write",path,content:"完整新文本",expected:"完整旧文本",revision:旧版本})`。新文件 `expected:"",revision:0`。read/write 的显式 policy deny 仍拒绝。不要把 Web 的 edits 或 Bot 的行列分页参数传给 board。

### Bot：read/edit

`read({path:"/system/plugins"})` 列目录；文件 `read({path})` 返回带版本的分页结果，按 `next` 中 **offset 行、column UTF-16 列、revision** 续读（包括单行很长的 JSON），直到 next 为空。

新文件 `edit({path,create:true,content:"完整文本",revision:0})`；已有文件 `edit({path,revision:读到的版本,edits:[{old_string:"精确唯一原文",new_string:"新文"}]})`。这里 **必须传 revision**。无需 shell 创建插件；若工具不存在，不发明它。显式 deny 与实际工具审批继续生效，文件/目录删除不能借技能免审批。

## 布局配方

从最新文档 JSON 复制所有字段，仅加入缺少的本次项。ID 使用唯一小写字母/数字/下划线/连字符（实例/位置最长100、包slug最长64），不让用户填。下面是 **新增片段**，不是可覆盖现有布局的完整文档：

```json
{
  "instances":[{"id":"my-counter","pluginId":"my-counter","title":"我的计数器","scope":{"kind":"account"}}],
  "placements":[{"id":"counter-page","pluginId":"my-counter","instanceId":"my-counter","viewId":"main","surface":"app.page","scope":{"kind":"account"},"order":10}],
  "navigation":[{"id":"counter-nav","placementId":"counter-page","title":"我的计数器","order":10}]
}
```

合并后 `plugins({operation:"configure",content:JSON.stringify(完整新布局),expected:原始content,revision:原revision})`。保存失败不报告成功；409/`system_revision_conflict` 重读当前文档，保留别人的全部修改再合并。本次配置有界重试，持续冲突就停止并说明未完成。布局不是 HTML 安装器，不传 source/status 等不存在的 configure 参数。

要把页面内容共用到聊天右侧，保留原实例，只新增另一个 placement，引用同一 `instanceId`，`surface:"chat.sidepanel"` 和实际支持该位置的 `viewId`。要独立使用才创建新实例，默认值不复制实时旧状态。配置更新不能清空 installations/sources/disabledBuiltins/navigation 或其他位置。

重命名导航改其 title，排序改 order；移位保留 instance；移除导航删除对应 navigation，仅在用户确需移除完整页挂载时删其 placement，同时处理引用，永不删除业务数据。`plugins({operation:"lifecycle",pluginId,status:"enabled"|"disabled"|"uninstalled",expected:最新布局content,revision:最新布局revision})` 执行显式状态变更；启用不能修复丢失文件或依赖，需要先检查实际问题。

## 验证和链接

再次 list/layout，核对精确 ID/状态/所选 view/范围/导航；按 describe 的只读动作验证状态，如 `plugins({operation:"invoke",pluginId,instanceId,revision:包revision,actionId:"read",args:{}})`。布局 revision 与包 revision 不通用。

完整页链接 `#/plugins/<URI编码instanceId>?view=<URI编码viewId>&placement=<URI编码placementId>`，不是 `/plugins/<pluginId>`。只有支持 chat.message 的 view 才能 `plugins({operation:"reference",pluginId,instanceId,viewId,summary:"已核验的简短说明"})`，原样使用返回的 Markdown；不能伪造引用/视觉验收。异步学习任务查询实际完成收据，queued/running 只说明已受理。
