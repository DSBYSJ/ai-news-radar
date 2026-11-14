import type { MacroPoint, NfiFactor } from '../types.ts'

/** 缺失项退出时，展示的贡献必须使用与总分相同的有效权重。 */
export function nfiContributions(factors: NfiFactor[]) {
  const total = factors.reduce((sum, f) => sum + (f.score === null || f.weight <= 0 ? 0 : f.weight), 0)
  return factors.map(f => ({ ...f, weight: f.score === null || f.weight <= 0 || total === 0 ? 0 : f.weight / total * 100,
    contribution: f.score === null || f.weight <= 0 || total === 0 ? 0 : f.score * f.weight / total }))
}

/** 缺失值必须断开曲线，不跨越未计算的日期画假连续线。 */
export function segmentedLine(values: (number | null | undefined)[], xOf: (i: number) => number, yOf: (v: number) => number): string {
  let started = false
  return values.map((value, i) => {
    if (value == null || !Number.isFinite(value)) { started = false; return '' }
    const command = started ? 'L' : 'M'
    started = true
    return `${command}${xOf(i).toFixed(1)},${yOf(value).toFixed(1)}`
  }).filter(Boolean).join(' ')
}

/** 收益率曲线是真实同日 10Y−2Y 利差，缺日期对齐时不编造曲线。 */
export function yieldCurvePoint(ten?: MacroPoint, two?: MacroPoint): MacroPoint | null {
  if (!ten || !two || !ten.dates || !two.dates) return null
  const twos = new Map(two.dates.map((date, i) => [date, two.history[i]]))
  const points = ten.dates.flatMap((date, i) => {
    const other = twos.get(date), value = ten.history[i]
    return other !== undefined && Number.isFinite(other) && Number.isFinite(value) ? [{ date, value: value - other }] : []
  })
  const latest = points.at(-1)
  if (!latest) return null
  const target = Date.parse(latest.date) - 365 * 86_400_000
  const previous = points.filter(p => Math.abs(Date.parse(p.date) - target) < 7 * 86_400_000)
    .sort((a, b) => Math.abs(Date.parse(a.date) - target) - Math.abs(Date.parse(b.date) - target))[0]
  return { key: 'yieldCurve', label: '收益率曲线 · 10Y − 2Y', value: latest.value, asOf: latest.date,
    yearAgo: previous?.value ?? null, avg200: null, high52w: null, history: points.map(p => p.value), dates: points.map(p => p.date), source: 'FRED DGS10 − DGS2，同日对齐' }
}
