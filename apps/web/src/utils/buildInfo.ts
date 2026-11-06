/**
 * 构建信息（版本 / 构建时间 / commit）的纯逻辑。
 *
 * ⚠️ 这个模块是 **Node 与浏览器双环境**的：vite.config.ts 在构建期用它格式化时间，
 * Settings 页在渲染期用它拼文案。所以它只做字符串与日期运算 ——
 * 不碰 import.meta.env、DOM、process（碰了构建配置在加载时就会炸）。
 * dev/prod 的分流判断留在调用方，见 Settings.tsx 里的 import.meta.env.DEV。
 */

export interface BuildInfo {
  /** package.json 的 version */
  version: string;
  /** 构建时间，固定按北京时间（UTC+8）格式化为 `YYYY-MM-DD HH:mm`。dev 下是 vite 配置加载的时刻，调用方不展示 */
  time: string;
  /** git 短哈希；取不到时为空串（CI 导出源码包 / 本机没装 git） */
  commit: string;
}

/** 北京时间固定为 UTC+8（中国自 1991 年起不实行夏令时）。 */
const BJT_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 构建时间 → `YYYY-MM-DD HH:mm`（固定北京时间，UTC+8）。
 *
 * 为什么手写补零而不用 dayjs：vite.config.ts 要 import 本模块，而 dayjs 是运行时依赖，
 * 为一个补零把它拉进构建配置的依赖图不划算 —— 这是四行代码的事。
 *
 * 为什么固定按北京时间、而不是构建机本地时间：部署构建常跑在 UTC 的 Docker/CI
 * 机器上（release 镜像即如此），按构建机本地时间会显示成早 8 小时，和页面里其它
 * 北京时间（例如模型目录的「更新于 … BJT」）对不上。这是个**事件时刻**，仍不按
 * 观看者设备时区重算；只是把基准固定为 UTC+8。完整取舍见
 * docs/plans/2026-09-18-build-info-design.md。
 */
export function formatBuildTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const bjt = new Date(d.getTime() + BJT_OFFSET_MS);
  return `${bjt.getUTCFullYear()}-${p(bjt.getUTCMonth() + 1)}-${p(bjt.getUTCDate())} ${p(bjt.getUTCHours())}:${p(bjt.getUTCMinutes())}`;
}

/**
 * 页脚文案。
 *
 * 三段里缺谁少谁都能降级：注入值被清掉时至少留下版本号 ——
 * 页脚整行空白比少一段信息更让人怀疑「这功能是不是坏了」。
 *
 * @param info  构建期注入的 `__BUILD_INFO__`
 * @param isDev 开发模式（调用方传 import.meta.env.DEV）
 */
export function buildInfoLabel(info: BuildInfo | null | undefined, isDev: boolean): string {
  const rawVersion = info?.version?.trim();
  // 兜底走「未知版本」而不是 `vunknown`：后者像个真的版本号，反而更难看出是注入丢了
  const version = rawVersion ? `v${rawVersion}` : '未知版本';
  // dev 下不展示注入的 time：那是 vite 配置加载的时刻，不是「构建」，显示出来是误导
  if (isDev) return `${version} · 开发模式`;
  const segments = [version];
  const time = info?.time?.trim();
  // 时间固定是北京时间，标上 BJT，避免和 UTC 混淆（部署构建常发生在 UTC 机器上）。
  if (time) segments.push(`${time} BJT`);
  const commit = info?.commit?.trim();
  if (commit) segments.push(commit);
  return segments.join(' · ');
}
