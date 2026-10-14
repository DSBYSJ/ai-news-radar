import { describe, expect, it } from 'vitest'
import { areaPath, linePath, linearScale, niceTicks } from './scale.ts'

describe('linearScale', () => {
  it('线性映射且端点正确', () => {
    const s = linearScale([0, 10], [0, 100])
    expect(s(0)).toBe(0)
    expect(s(10)).toBe(100)
    expect(s(5)).toBe(50)
  })

  it('支持反向（SVG 的 y 轴向下）', () => {
    const s = linearScale([0, 10], [200, 0])
    expect(s(0)).toBe(200)
    expect(s(10)).toBe(0)
  })

  it('domain 退化时不除零', () => {
    const s = linearScale([5, 5], [0, 100])
    expect(s(5)).toBe(0)
  })
})

describe('niceTicks', () => {
  it('覆盖到 max 且递增', () => {
    const ticks = niceTicks(37, 4)
    expect(ticks[0]).toBe(0)
    expect(ticks[ticks.length - 1]).toBeGreaterThanOrEqual(37)
    for (let i = 1; i < ticks.length; i++) expect(ticks[i]).toBeGreaterThan(ticks[i - 1])
  })

  it('max 为 0 时给出兜底', () => {
    expect(niceTicks(0)).toEqual([0, 1])
  })
})

describe('路径生成', () => {
  it('linePath 以 M 开头、后续 L', () => {
    const p = linePath([
      { x: 1, y: 2 },
      { x: 3, y: 4 },
    ])
    expect(p).toBe('M1.00,2.00 L3.00,4.00')
  })

  it('areaPath 闭合到基线', () => {
    const p = areaPath(
      [
        { x: 1, y: 2 },
        { x: 3, y: 4 },
      ],
      50,
    )
    expect(p.startsWith('M1.00,2.00 L3.00,4.00')).toBe(true)
    expect(p.endsWith('Z')).toBe(true)
  })
})
