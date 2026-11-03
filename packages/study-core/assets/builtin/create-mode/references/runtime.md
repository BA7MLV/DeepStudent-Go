# 持久 HTML 插件运行时

动态包运行在宿主隔离 iframe，使用注入的 `window.plugin`。不要引入 `show_widget`、`window.__wbw`，不要自行实现 postMessage 通道或覆盖 SDK。CSP 禁止网络请求、远程脚本/样式/字体；图片只支持 data:。无宿主 DOM、任意本机文件、服务器 JS/React 或 npm 安装能力。

## 最小 v2 包

先写 `views/main.html` 和 `defaults.json`，最后写 `manifest.json`。只发布所需能力/位置。示例使用自己的新 slug，不覆盖已安装的 counter。

`manifest.json`：
```json
{"apiVersion":2,"id":"my-counter","name":"我的计数器","description":"记录次数，在需要的位置共用。","version":"1.0.0","enabled":true,"capabilities":["state"],"views":{"main":{"title":"计数器","entry":"views/main.html","surfaces":["app.page","board.main","chat.sidepanel","reader.sidepanel","chat.message"],"height":220}},"actions":{"read":{"title":"读取计数","service":"state.read","schema":{"type":"object"}}}}
```

`defaults.json`：`{"count":0}`。仅供新实例初始化，不写已存在实例的实时状态文件。

`views/main.html`（完整可运行片段，宿主提供外层文档、SDK 与主题）：
```html
<style>
  main{display:grid;gap:12px;padding:12px}output{font-size:2rem;font-variant-numeric:tabular-nums}
  button{min-height:44px}#error{color:var(--danger)}#error:empty{display:none}
</style>
<main aria-label="计数器"><output id="count" aria-live="polite">加载中…</output>
  <button id="add" type="button">加一</button><p id="error" role="alert"></p></main>
<script>
(() => {
  const count = document.getElementById('count'), button = document.getElementById('add'), error = document.getElementById('error');
  let disposed = false, busy = false;
  const read = async () => { const value = await plugin.state.read(); if (!disposed) count.textContent = String(value.data.count ?? 0); return value; };
  const fail = e => { if (!disposed) error.textContent = '暂时无法保存，请稍后重试。'; };
  const refresh = () => { if (!busy) void read().catch(fail); };
  const off = plugin.events.subscribe('state.changed', refresh);
  plugin.events.subscribe('dispose', () => { disposed = true; off(); });
  button.onclick = async () => {
    if (busy) return;
    busy = true; button.disabled = true; error.textContent = '';
    try {
      const before = await read();
      const next = await plugin.state.write({ ...before.data, count: Number(before.data.count ?? 0) + 1 }, before);
      if (!disposed) count.textContent = String(next.data.count);
    } catch (e) { fail(e); await read().catch(fail); }
    finally { busy = false; if (!disposed) button.disabled = false; }
  };
  refresh();
})();
</script>
```

不要把临时本地变量、localStorage 或消息正文当持久插件状态。`plugin.state.read()` 返回 `{data,content,revision}`；`plugin.state.write(data,before)` 用完整 before 的原文和版本 CAS，不传伪造快照。并发冲突重读展示真实值，不盲目覆写。

## 其他已存在的 SDK

- `plugin.context.get()` 返回当前 surface、资料/项目、语言、theme、width、mode、会话等；`plugin.events.subscribe('contextChanged',fn)` 跟踪变化，旧异步结果不可写成新资料的内容。
- `plugin.draft.read()/write(data)` 是挂载级 sessionStorage 草稿，不是跨设备业务数据。
- `plugin.events.subscribe(name,fn)` 返回取消订阅函数。事件有 `mount`、`dispose`、`state.changed`、`contextChanged`、`visibilityChanged`；销毁释放订阅/定时器，尺寸/主题变化不清空输入。
- `plugin.call(method,args)` 只能调用宿主实际允许的方法。state/tasks/schedules 标准 SDK 仍受 manifest capability 校验。其他领域方法必须在 actions 声明，并满足真实 schema、提供者依赖及宿主服务版本。声明不存在的 service 不会产生能力。
- `plugin.tasks.start({threadId,prompt,clientNonce})` / `get(id)` / `watch(id,onChange,options)` / `wait(id,options)` / `cancel(id)` / `open(id)` 需要对应 capability 和真实可访问 thread。watch 返回清理函数；客户端 nonce 要复用，避免刷新重复派发。终态不等于产物成功，检查任务错误和持久收据。
- 学习视图优先复用原生插件。动态 HTML 即使声明 requires 与 learning-data，也不能调用 trustedOnly 方法、冒充原生提供者，或在包被停用时执行新工作。

宿主用 ResizeObserver 测量内容，高度受 view.height（56–2000）限制。窄栏避免横向溢出；长内容局部滚动。不硬编码整页高度，不模拟导航外壳。
