/** Interaction waits are separate from CSS animation durations in transitions.css. */
export const FOLDER_SPRING_OPEN_MS = 850;

/**
 * 级联菜单(CascadeMenu)的意图层等待 —— 所有级联菜单的交互时长只放在这里。
 * CSS 动画时长(170/360/460ms 等)在 cascade-menu.css 里,不混入交互等待。
 */
/** 悬停一行后的生效延迟:文件夹展开子菜单,普通行收掉更深层。 */
export const CASCADE_OPEN_DELAY_MS = 220;
/** 拖拽悬停在文件夹行上的展开延迟默认更久(防误触)。 */
export const CASCADE_DRAG_OPEN_DELAY_MS = 420;
/** 指针整体离开(锚点 + 所有层级 + 安全区)后的关单宽限。 */
export const CASCADE_CLOSE_GRACE_MS = 360;
/** 安全区内的悬停不立即切换,每 80ms 复查一次指针是否已离区。 */
export const CASCADE_SAFE_WINDOW_POLL_MS = 80;
/** 安全区悬停兜底:指针停在区内不动,也应在 1.2s 后拿到想切换的子菜单。 */
export const CASCADE_SAFE_WINDOW_MAX_MS = 1200;
