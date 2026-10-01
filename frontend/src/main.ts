import "./shell.css";
import { HealthService } from "./mygo";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Missing #app root");

root.innerHTML = `
  <div class="ds-shell">
    <header class="ds-titlebar">
      <span class="ds-titlebar__traffic" aria-hidden="true"><i></i><i></i><i></i></span>
      <span class="ds-titlebar__title">DeepStudent Go</span>
    </header>
    <div class="ds-body">
      <aside class="ds-sidebar" aria-label="主导航">
        <div class="ds-brand"><span class="ds-brand__mark">D</span><span>DeepStudent</span></div>
        <nav class="ds-nav">
          <button data-active="true"><span class="ds-nav__icon">⌂</span>学习空间</button>
          <button><span class="ds-nav__icon">▤</span>资料库</button>
          <button><span class="ds-nav__icon">✦</span>智能对话</button>
          <button><span class="ds-nav__icon">◇</span>复习与卡片</button>
        </nav>
        <div class="ds-sidebar__footer">
          <button class="ds-nav"><span class="ds-nav__icon">⚙</span>设置</button>
        </div>
      </aside>
      <main class="ds-main">
        <div class="ds-toolbar">
          <h1>学习空间</h1>
          <div class="ds-toolbar__actions">
            <button class="ds-icon-button" aria-label="搜索">⌕</button>
            <button class="ds-icon-button" aria-label="新建">＋</button>
          </div>
        </div>
        <section class="ds-card ds-empty">
          <div>
            <h2>Go runtime shell</h2>
            <p>第一阶段先验证壳层、typed bridge 和运行时健康检查，后续再接入对话与资料流。</p>
            <span class="ds-status"><span class="ds-status__dot"></span><span id="status">正在连接 Go runtime…</span></span>
          </div>
        </section>
      </main>
    </div>
  </div>
`;

async function bootRuntime() {
  const status = document.querySelector<HTMLSpanElement>("#status");
  try {
    const health = await HealthService.health();
    if (status) status.textContent = `${health.runtime} runtime: ${health.status}`;
  } catch {
    if (status) status.textContent = "runtime bridge unavailable";
  }
}

void bootRuntime();
