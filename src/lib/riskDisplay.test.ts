import { expect, it } from 'vitest'
import { nfiContributions, segmentedLine, yieldCurvePoint } from './riskDisplay.ts'
import type { MacroPoint } from '../types.ts'

it('NFI 缺失分项退出后，展示的贡献之和与计算的总分一致', () => {
  const factors = nfiContributions([
    { key: 'a', label: 'A', value: 50, score: 50, weight: 25, note: '' },
    { key: 'b', label: 'B', value: null, score: null, weight: 25, note: '' },
    { key: 'c', label: 'C', value: 80, score: 80, weight: 50, note: '' },
  ])
  expect(factors.reduce((sum, f) => sum + f.weight, 0)).toBeCloseTo(100)
  expect(factors.reduce((sum, f) => sum + f.contribution, 0)).toBeCloseTo(70)
  expect(factors[1].contribution).toBe(0)
})
const point = (dates: string[], history: number[]): MacroPoint => ({ key: '', label: '', value: history.at(-1)!, dates, history,
  asOf: dates.at(-1)!, yearAgo: null, avg200: null, high52w: null, source: 'test' })
it('收益率曲线按真实同日日期对齐，不按数组下标相减', () => {
  const ten = point(['2026-11-11','2026-11-12','2026-11-13'], [4.5,4.6,4.7])
  const two = point(['2026-11-10','2026-11-12','2026-11-13'], [4.0,4.1,4.2])
  const curve = yieldCurvePoint(ten, two)!
  expect(curve.dates).toEqual(['2026-11-12','2026-11-13'])
  expect(curve.history[0]).toBeCloseTo(0.5)
  expect(curve.value).toBeCloseTo(0.5)
  expect(yieldCurvePoint(ten, undefined)).toBeNull()
})
it('历史线以有效点起笔，缺失值断开，不跨日期补线', () => {
  expect(segmentedLine([null, 3, 4, null, 6], i => i, v => v)).toBe('M1.0,3.0 L2.0,4.0 M4.0,6.0')
})
