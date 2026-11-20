import type { FigureName } from './flow';
import { STEP_FIGURES } from './figures';

/**
 * 引导页的蓝图线稿:扁平、单色、透明形面,只有一张图在讲一个构造关系。
 * 颜色走 currentColor,深浅主题自动跟随 busy 时让位移箭头的虚线流动,
 * prefers-reduced-motion 下停为静止线稿;图形本体不携带任何可选中文案。
 */
export default function OnboardingFigure({ name, label, busy = false }: {
  name: FigureName;
  label: string;
  busy?: boolean;
}) {
  const Figure = STEP_FIGURES[name];
  return <figure className="ob-figure__art" role="img" aria-label={label} data-busy={busy || undefined}>
    <Figure />
  </figure>;
}
