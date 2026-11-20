import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import {
  CASCADE_CLOSE_GRACE_MS,
  CASCADE_DRAG_OPEN_DELAY_MS,
  CASCADE_OPEN_DELAY_MS,
  CASCADE_SAFE_WINDOW_MAX_MS,
  CASCADE_SAFE_WINDOW_POLL_MS,
} from './interactionTiming'
import { buildSafeTriangle, inSafeZone, type Point, type Rect, type SafeTriangle, type SubmenuSide } from './cascadeSafeZone'
import './cascade-menu.css'

export interface CascadeItem {
  label: string
  icon?: ReactNode
  href?: string
  children?: CascadeItem[]
}

/** 行的定位:各级索引链,如 [0, 2] 表示根第 0 项子菜单里的第 2 行。 */
type Path = number[]

const pathKey = (path: Path): string => path.join('-')
const parentOf = (path: Path): Path => path.slice(0, -1)
const equalPath = (a: Path, b: Path): boolean => a.length === b.length && a.every((v, i) => v === b[i])
const startsWith = (path: Path, prefix: Path): boolean => path.length >= prefix.length && prefix.every((v, i) => path[i] === v)

interface Zone { submenu: Rect, side: SubmenuSide, parent: Rect }

/**
 * 级联菜单:子菜单只被「有意图的指针」打开 —— 220ms 生效延迟、三角形安全区放行
 * 斜向轨迹、安全窗避免途中切换、360ms 关单宽限。行的高亮全部由 state 驱动,
 * 安全区内被穿过的行既不变亮,也不会排自己的子菜单。
 */
export function CascadeMenu({ anchor, items, ariaLabel = '菜单', debug = false }: {
  anchor: ReactNode
  items: CascadeItem[]
  ariaLabel?: string
  debug?: boolean
}) {
  const [openRoot, setOpenRoot] = useState(false)
  const [openPath, setOpenPath] = useState<Path>([])
  const [hover, setHover] = useState<Path | null>(null)
  const [focusPath, setFocusPath] = useState<Path | null>(null)
  const [zone, setZone] = useState<Zone | null>(null)
  const [pending, setPending] = useState<{ path: Path, deadline: number } | null>(null)
  const [debugTriangle, setDebugTriangle] = useState<SafeTriangle | null>(null)
  const [debugTimers, setDebugTimers] = useState<{ open: boolean, close: boolean }>({ open: false, close: false })

  const containerRef = useRef<HTMLDivElement | null>(null)
  const anchorRef = useRef<HTMLButtonElement | null>(null)
  const lastMoves = useRef<Point[]>([])
  const zoneRef = useRef<Zone | null>(null)
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const dragTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pollTimer = useRef<ReturnType<typeof setInterval> | undefined>(undefined)

  useEffect(() => { zoneRef.current = zone }, [zone])

  const pointerNow = (): Point => lastMoves.current.at(-1) ?? { x: -1e9, y: -1e9 }
  const pointerPrev = (): Point => lastMoves.current.at(-2) ?? lastMoves.current.at(-1) ?? { x: -1e9, y: -1e9 }
  const inZoneNow = (): boolean => {
    const current = zoneRef.current
    return current !== null && inSafeZone({ point: pointerNow(), previous: pointerPrev(), submenu: current.submenu, side: current.side, parent: current.parent })
  }

  const cancelOpenIntent = useCallback(() => {
    clearTimeout(openTimer.current)
    setDebugTimers(state => (state.open ? { ...state, open: false } : state))
  }, [])

  const closeAll = useCallback(() => {
    clearTimeout(openTimer.current)
    clearTimeout(dragTimer.current)
    clearTimeout(closeTimer.current)
    clearInterval(pollTimer.current)
    setOpenRoot(false)
    setOpenPath([])
    setHover(null)
    setFocusPath(null)
    setZone(null)
    setPending(null)
    setDebugTimers({ open: false, close: false })
  }, [])

  /** 悬停一行后的「生效」动作:文件夹展开自己的子级,普通行收掉分支上更深的子级。 */
  const applyIntent = useCallback((path: Path, row: CascadeItem) => {
    if (row.children?.length) {
      setOpenPath(path)
      return
    }
    const branch = parentOf(path)
    setOpenPath(current => (startsWith(current, branch) && current.length > branch.length ? branch : current))
  }, [])

  /** 安全区内的悬停不立即切换:80ms 复查指针是否离区,拖过 1.2s 兜底生效。 */
  const safeWindowStart = useCallback((path: Path, row: CascadeItem) => {
    const deadline = Date.now() + CASCADE_SAFE_WINDOW_MAX_MS
    setPending({ path, deadline })
    clearInterval(pollTimer.current)
    pollTimer.current = setInterval(() => {
      const outside = !inZoneNow()
      if (outside || Date.now() >= deadline) {
        clearInterval(pollTimer.current)
        setPending(null)
        if (outside) {
          setHover(path)
          applyIntent(path, row)
        }
      }
    }, CASCADE_SAFE_WINDOW_POLL_MS)
  }, [applyIntent])

  const rowEnter = useCallback((path: Path, row: CascadeItem, touch: boolean) => {
    clearTimeout(closeTimer.current)
    if (inZoneNow()) {
      safeWindowStart(path, row)
      return
    }
    setHover(path)
    if (touch) {
      applyIntent(path, row)
      return
    }
    cancelOpenIntent()
    openTimer.current = setTimeout(() => {
      setDebugTimers(state => ({ ...state, open: false }))
      applyIntent(path, row)
    }, CASCADE_OPEN_DELAY_MS)
    setDebugTimers(state => ({ ...state, open: true }))
  }, [applyIntent, cancelOpenIntent, safeWindowStart])

  const rowLeave = useCallback(() => {
    cancelOpenIntent()
  }, [cancelOpenIntent])

  /** 指针离开锚点与所有层级:360ms 后整体关闭;期间任何进入都撤销。 */
  const containerLeave = useCallback(() => {
    clearTimeout(closeTimer.current)
    closeTimer.current = setTimeout(() => closeAll(), CASCADE_CLOSE_GRACE_MS)
    setDebugTimers(state => ({ ...state, close: true }))
  }, [closeAll])

  const containerEnter = useCallback(() => {
    clearTimeout(closeTimer.current)
    setDebugTimers(state => (state.close ? { ...state, close: false } : state))
  }, [])

  // 全局指针:记录最后两个位置(安全区顶点用更旧的那个),点击外部立即关闭
  useEffect(() => {
    if (!openRoot) return
    const onMove = (event: PointerEvent) => {
      lastMoves.current.push({ x: event.clientX, y: event.clientY })
      if (lastMoves.current.length > 2) lastMoves.current.shift()
      if (debug && zoneRef.current) setDebugTriangle(buildSafeTriangle(pointerPrev(), zoneRef.current.submenu, zoneRef.current.side))
    }
    const onDown = (event: PointerEvent) => {
      if (containerRef.current?.contains(event.target as Node)) return
      closeAll()
    }
    window.addEventListener('pointermove', onMove, { passive: true })
    window.addEventListener('pointerdown', onDown)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
    }
  }, [openRoot, closeAll, debug])

  // 子菜单挂载后:对齐首行与父行、空间不足翻转到左侧、量出安全区矩形
  useLayoutEffect(() => {
    if (!openRoot || !openPath.length) return
    const parentKey = openPath.length === 1 ? 'root' : pathKey(parentOf(openPath))
    const submenu = containerRef.current?.querySelector<HTMLElement>(`[data-cm-menu="${pathKey(openPath)}"]`)
    const parent = containerRef.current?.querySelector<HTMLElement>(`[data-cm-menu="${parentKey}"]`)
    const firstRow = submenu?.querySelector<HTMLElement>('.cm-row')
    if (!submenu || !parent || !firstRow) return
    submenu.style.top = `${-firstRow.offsetTop - 1}px`
    let side: SubmenuSide = 'right'
    const rect = submenu.getBoundingClientRect()
    if (rect.right > window.innerWidth - 8) {
      submenu.classList.add('cm-menu--flipped-x')
      side = 'left'
    } else {
      submenu.classList.remove('cm-menu--flipped-x')
    }
    const submenuRect = submenu.getBoundingClientRect()
    const parentRect = parent.getBoundingClientRect()
    setZone({ submenu: submenuRect, side, parent: parentRect })
    setDebugTriangle(buildSafeTriangle(pointerPrev(), submenuRect, side))
  }, [openRoot, openPath])

  useEffect(() => {
    if (!openPath.length) setZone(null)
  }, [openPath])

  // 根菜单挂载后:右侧放不下同样翻转到锚点左侧
  useLayoutEffect(() => {
    if (!openRoot) return
    const root = containerRef.current?.querySelector<HTMLElement>('[data-cm-menu="root"]')
    if (!root) return
    const rect = root.getBoundingClientRect()
    root.classList.toggle('cm-menu--flipped-x', rect.right > window.innerWidth - 8)
  }, [openRoot])

  // 键盘焦点跟随
  useEffect(() => {
    if (!focusPath) return
    containerRef.current?.querySelector<HTMLElement>(`[data-cm-row="${pathKey(focusPath)}"]`)?.focus()
  }, [focusPath, openPath])

  const rowsOf = (result: Path): CascadeItem[] => {
    let rows = items
    for (const index of result) rows = rows[index]?.children ?? []
    return rows
  }

  const onRowKeyDown = (path: Path, row: CascadeItem, event: React.KeyboardEvent) => {
    const rows = rowsOf(parentOf(path))
    const index = path[path.length - 1]
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      const nextIndex = rows[index + 1] ? index + 1 : 0
      setFocusPath([...parentOf(path), nextIndex])
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const prevIndex = rows[index - 1] ? index - 1 : rows.length - 1
      setFocusPath([...parentOf(path), prevIndex])
    } else if (event.key === 'ArrowRight') {
      if (!row.children?.length) return
      event.preventDefault()
      setOpenPath(path)
      setHover(path)
      setFocusPath([...path, 0])
    } else if (event.key === 'ArrowLeft') {
      if (path.length <= 1) return
      event.preventDefault()
      const up = path.slice(0, -1)
      setOpenPath(current => (startsWith(current, up) ? up : current))
      setHover(up)
      setFocusPath(up)
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      if (row.children?.length) {
        setOpenPath(path)
        setFocusPath([...path, 0])
      } else {
        closeAll()
      }
    } else if (event.key === 'Escape') {
      event.preventDefault()
      closeAll()
      anchorRef.current?.focus()
    }
  }

  const renderLevel = (path: Path, rows: CascadeItem[], title: string | null): ReactNode => {
    const key = pathKey(path)
    const depth = path.length - 1
    return (
      <div
        data-cm-menu={depth < 0 ? 'root' : key}
        className="cm-menu"
        role="menu"
        aria-label={title ?? ariaLabel}
      >
        {title !== null ? <div className="cm-title">{title}</div> : null}
        {rows.map((row, index) => {
          const rowPath = [...path, index]
          const rowKey = pathKey(rowPath)
          const folder = Boolean(row.children?.length)
          const active = folder && startsWith(openPath, rowPath)
          const hovered = hover !== null && equalPath(hover, rowPath)
          const skipped = pending !== null && equalPath(pending.path, rowPath)
          const rowProps = {
            'data-cm-row': rowKey,
            'data-state': skipped ? 'skipped' : hovered ? 'hovered' : active ? 'active' : 'idle',
            tabIndex: -1,
            onPointerEnter: (event: React.PointerEvent<HTMLElement>) => rowEnter(rowPath, row, event.pointerType === 'touch'),
            onPointerLeave: rowLeave,
            onDragEnter: (event: React.DragEvent<HTMLElement>) => {
              if (!folder || event.dataTransfer.types.length === 0) return
              clearTimeout(dragTimer.current)
              dragTimer.current = setTimeout(() => { setOpenPath(rowPath) }, CASCADE_DRAG_OPEN_DELAY_MS)
            },
            onDragLeave: () => { clearTimeout(dragTimer.current) },
            onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => onRowKeyDown(rowPath, row, event),
            ...(folder ? { 'aria-haspopup': 'menu' as const, 'aria-expanded': active } : {}),
          }
          const content = (
            <>
              {folder ? <FolderGlyph open={active} /> : row.icon !== undefined ? <span className="cm-icon">{row.icon}</span> : null}
              <span className="cm-label">{row.label}</span>
              {folder ? <ChevronGlyph /> : null}
            </>
          )
          return (
            <div className="cm-row-slot" key={rowKey}>
              {row.href && !folder
                ? <a className="cm-row" href={row.href} role="menuitem" {...rowProps}>{content}</a>
                : <button type="button" className="cm-row" role="menuitem" {...rowProps}>{content}</button>}
              {folder && startsWith(openPath, rowPath) ? renderLevel(rowPath, row.children ?? [], row.label) : null}
            </div>
          )
        })}
      </div>
    )
  }

  return (
    <div className="cm-root" ref={containerRef} onPointerEnter={containerEnter} onPointerLeave={containerLeave}>
      <button
        ref={anchorRef}
        type="button"
        className="cm-anchor"
        aria-haspopup="menu"
        aria-expanded={openRoot ? 'true' : 'false'}
        aria-label={ariaLabel}
        onClick={() => (openRoot ? closeAll() : setOpenRoot(true))}
        onKeyDown={event => {
          if (event.key === 'ArrowDown' && !openRoot) {
            event.preventDefault()
            setOpenRoot(true)
            setFocusPath([0])
          }
        }}
      >
        {anchor}
      </button>
      {openRoot ? renderLevel([], items, null) : null}
      {debug && openRoot ? <DebugOverlay triangle={debugTriangle} timers={debugTimers} pending={pending} zoneKey={openPath.length ? pathKey(openPath) : null} /> : null}
    </div>
  )
}

function DebugOverlay({ triangle, timers, pending, zoneKey }: {
  triangle: SafeTriangle | null
  timers: { open: boolean, close: boolean }
  pending: { path: Path, deadline: number } | null
  zoneKey: string | null
}) {
  const points = triangle ? `${triangle.apex.x},${triangle.apex.y} ${triangle.cornerA.x},${triangle.cornerA.y} ${triangle.cornerB.x},${triangle.cornerB.y}` : ''
  return (
    <div className="cm-debug" aria-hidden="true">
      {triangle !== null ? (
        <svg className="cm-debug__svg">
          <polygon points={points} />
        </svg>
      ) : null}
      <div className="cm-debug__panel">
        <div>{zoneKey !== null ? `zone: ${zoneKey}` : 'zone: —'}</div>
        <div>open timer: {timers.open ? 'running' : '—'}</div>
        <div>close timer: {timers.close ? 'running' : '—'}</div>
        <div>safe window: {pending !== null ? `${Math.max(0, pending.deadline - Date.now())}ms` : '—'}</div>
      </div>
    </div>
  )
}

/** 文件夹开/合集:两枚 glyph 结构不同,按约定做带轻微抬升的交叉淡化。 */
function FolderGlyph({ open }: { open: boolean }) {
  return (
    <span className="cm-icon cm-folder" data-open={open ? 'true' : 'false'} aria-hidden="true">
      <svg className="cm-folder__closed" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
      </svg>
      <svg className="cm-folder__open" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v2" />
        <path d="M3 7h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7l-4-12" />
      </svg>
    </span>
  )
}

function ChevronGlyph() {
  return (
    <svg className="cm-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  )
}
