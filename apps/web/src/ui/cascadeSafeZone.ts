/**
 * CascadeMenu 的安全区几何 —— 纯函数,便于 node:test 直接覆盖。
 *
 * 「斜着走向子菜单」是人类指针的高频轨迹:直接按『悬停了哪行』切换子菜单会一路闪。
 * 这里用三角形安全区判定指针是否明显正在奔向某个已打开的子菜单。
 */

export interface Point { x: number; y: number }

export interface Rect { left: number; top: number; right: number; bottom: number }

export interface SafeTriangle { apex: Point; cornerA: Point; cornerB: Point }

/** 子菜单位于父级右侧(默认)取其左缘,翻转到左侧后取其右缘。 */
export type SubmenuSide = 'right' | 'left'

/** 有符号叉积:ab→ap 与 ab→c 的旋转方向一致则为正。 */
function cross(o: Point, a: Point, b: Point): number {
  return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
}

/**
 * 三条边叉积符号一致即视为在三角形内(含边界)。
 * 不做归一化,顺/逆时针顶点序都成立;退化成线段时符号含 0 仍然安全。
 */
export function pointInTriangle(p: Point, t: SafeTriangle): boolean {
  const d1 = cross(t.apex, t.cornerA, p)
  const d2 = cross(t.cornerA, t.cornerB, p)
  const d3 = cross(t.cornerB, t.apex, p)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

/**
 * 向子菜单方向受保护的水平走廊宽度:任务的折中值,
 * 宽菜单允许更长的斜向行程,但不超过 90px。
 */
export function safeZoneReach(parentWidth: number): number {
  return Math.min(90, Math.max(56, parentWidth * 0.43))
}

/** 子菜单近缘的两个角:右侧子菜单取左缘上下角,左侧翻转后取右缘。 */
function nearEdgeCorners(submenu: Rect, side: SubmenuSide): [Point, Point] {
  if (side === 'right') return [{ x: submenu.left, y: submenu.top }, { x: submenu.left, y: submenu.bottom }]
  return [{ x: submenu.right, y: submenu.top }, { x: submenu.right, y: submenu.bottom }]
}

/**
 * 指针从 previous 奔向子菜单时的保护区:以 previous 为顶点、子菜单近缘为底。
 * 顶点取倒数第二个指针位置,而不是当前点 —— 当前点落在边上会把三角形压扁。
 */
export function buildSafeTriangle(previous: Point, submenu: Rect, side: SubmenuSide): SafeTriangle {
  const [cornerA, cornerB] = nearEdgeCorners(submenu, side)
  return { apex: previous, cornerA, cornerB }
}

export interface SafeZoneCheck {
  point: Point
  previous: Point
  submenu: Rect
  side: SubmenuSide
  /** 父级(即触发子菜单的那一层)矩形,走廊以它朝子菜单的边为界。 */
  parent: Rect
}

/**
 * 判定指针是否处于安全区内:先在三角形内,再限制在父级朝子菜单方向
 * safeZoneReach 宽的走廊里 —— 后者防止顶部掠过(parent 之外很远)也算『在路上』。
 */
export function inSafeZone(check: SafeZoneCheck): boolean {
  const triangle = buildSafeTriangle(check.previous, check.submenu, check.side)
  if (!pointInTriangle(check.point, triangle)) return false
  const reach = safeZoneReach(check.parent.right - check.parent.left)
  if (check.side === 'right') return check.point.x >= check.parent.right - reach
  return check.point.x <= check.parent.left + reach
}
