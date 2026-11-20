import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildSafeTriangle,
  inSafeZone,
  pointInTriangle,
  safeZoneReach,
} from '../apps/web/src/ui/cascadeSafeZone.ts'

const rect = (left, top, right, bottom) => ({ left, top, right, bottom })

test('pointInTriangle: 三条边叉积同号为在三角形内', () => {
  const triangle = buildSafeTriangle({ x: 0, y: 100 }, rect(120, 0, 300, 200), 'right')
  assert.equal(pointInTriangle({ x: 60, y: 100 }, triangle), true, '从顶点指向近缘中点必在区内')
  assert.equal(pointInTriangle({ x: 121, y: 10 }, triangle), false, '已越过子菜单近缘不算在路上')
  assert.equal(pointInTriangle({ x: 100, y: 1990 }, triangle), false, '远离底边的不算')
})

test('pointInTriangle: 顶点序(顺/逆时针)与退化三角形均安全', () => {
  const base = buildSafeTriangle({ x: 0, y: 100 }, rect(120, 0, 300, 200), 'right')
  const swapped = { apex: base.apex, cornerA: base.cornerB, cornerB: base.cornerA }
  assert.equal(pointInTriangle({ x: 60, y: 100 }, swapped), true, '顶点交换后判定不翻车')
  const degenerate = { apex: { x: 0, y: 0 }, cornerA: { x: 10, y: 10 }, cornerB: { x: 20, y: 20 } }
  assert.equal(pointInTriangle({ x: 15, y: 15 }, degenerate), true, '退化成线段时边界点仍判在内部')
  assert.equal(pointInTriangle({ x: 15, y: 16 }, degenerate), false)
})

test('safeZoneReach: 折中值夹在 [56, 90] 之间', () => {
  assert.equal(safeZoneReach(100), 56, '窄菜单取下限 56')
  assert.equal(safeZoneReach(130), 56, '43% (55.9) 仍取下限')
  assert.equal(safeZoneReach(200), 86, '宽菜单按 43% 增长')
  assert.equal(safeZoneReach(400), 90, '超宽菜单封顶 90')
})

test('inSafeZone: 右侧子菜单用左缘,同时限制在父级走廊内', () => {
  const parent = rect(0, 0, 200, 400)
  const submenu = rect(192, 40, 380, 240)
  const apex = { x: 120, y: 80 }
  assert.equal(inSafeZone({ point: { x: 150, y: 100 }, previous: apex, submenu, side: 'right', parent }), true, '三角形内的斜向行程受保护')
  assert.equal(inSafeZone({ point: { x: 20, y: 100 }, previous: apex, submenu, side: 'right', parent }), false, '在父级左侧走廊之外,即使同向也不保护')
  assert.equal(inSafeZone({ point: { x: 150, y: 300 }, previous: apex, submenu, side: 'right', parent }), false, '越出三角形底边')
})

test('inSafeZone: 翻转到左侧后用右缘做底', () => {
  const parent = rect(200, 0, 400, 400)
  const submenu = rect(20, 40, 208, 240)
  const apex = { x: 280, y: 80 }
  assert.equal(inSafeZone({ point: { x: 250, y: 100 }, previous: apex, submenu, side: 'left', parent }), true)
  assert.equal(inSafeZone({ point: { x: 380, y: 100 }, previous: apex, submenu, side: 'left', parent }), false, '父级右侧走廊之外不保护')
})
