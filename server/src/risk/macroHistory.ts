import type { DatabaseSync } from 'node:sqlite'
import type { MacroSeriesInput } from './calculation.ts'

/**
 * 宏观历史的 point-in-time 读取（v0.28.0）
 *
 * 为什么单独一层：回算与回测都必须严格「只用当天及以前能看到的数」，
 * 否则会用到未来数据（比如拿今天的 52 周高点去算去年的回撤），回测结果会虚高。
 *
 * 库内 `macro_history(date, series, value)` 的真实日期由采集时一并写入；
 * 早期版本是用「末尾日期倒推」伪造的日期（把 20 年数据压进 13.7 年），
 * 见 `storeMacroHistory` 的注释 —— 那批旧数据必须重采一次才可信。
 */

export interface SeriesData {
  /** 升序日期 YYYY-MM-DD */
  dates: string[]
  values: number[]
}

export function loadSeries(db: DatabaseSync, seriesKey: string): SeriesData {
  const rows = db
    .prepare('SELECT date, value FROM macro_history WHERE series = ? ORDER BY date')
    .all(seriesKey) as unknown as { date: string; value: number }[]
  return {
    dates: rows.map((r) => r.date),
    values: rows.map((r) => Number(r.value)),
  }
}

/** 最后一个 <= date 的下标（没有则 -1） */
export function indexAt(s: SeriesData, date: string): number {
  let lo = 0
  let hi = s.dates.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (s.dates[mid] <= date) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/** 某天可见的取值（最后一个观测；缺数据返回 null） */
export function valueAt(s: SeriesData, date: string): number | null {
  const i = indexAt(s, date)
  return i < 0 ? null : s.values[i]
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(date) - days * 86_400_000).toISOString().slice(0, 10)
}

/**
 * 一年前值：取 <= (date-365d) 的最后一个观测。
 * 与目标日期相差超过 45 天视为缺失（FRED 偶尔断档，别拿两年前的数冒充一年前）。
 */
export function valueYearAgo(s: SeriesData, date: string): number | null {
  const target = shiftDays(date, 365)
  const i = indexAt(s, target)
  if (i < 0) return null
  const gap = Date.parse(target) - Date.parse(s.dates[i])
  if (gap > 45 * 86_400_000) return null
  return s.values[i]
}

/** 最近 n 个观测的均值（不足 n 个返回 null，避免早期样本算出假均值） */
export function meanLastN(s: SeriesData, date: string, n: number): number | null {
  const i = indexAt(s, date)
  if (i < 0 || i + 1 < n) return null
  let sum = 0
  for (let k = i - n + 1; k <= i; k++) sum += s.values[k]
  return sum / n
}

/** 最近 n 个观测的最大值 */
export function maxLastN(s: SeriesData, date: string, n: number): number | null {
  const i = indexAt(s, date)
  if (i < 0) return null
  let max = -Infinity
  for (let k = Math.max(0, i - n + 1); k <= i; k++) max = Math.max(max, s.values[k])
  return max
}

/** 截至某天的全部历史（分位数 / Z-Score 用） */
export function historyUntil(s: SeriesData, date: string): number[] {
  const i = indexAt(s, date)
  return i < 0 ? [] : s.values.slice(0, i + 1)
}

/**
 * 组装成引擎输入（point-in-time）：值、一年前、200 日均值、52 周高点、历史序列。
 * 全部只用 <= date 的观测，回测与回算共用这一份口径。
 */
export function buildMacroInput(
  s: SeriesData,
  date: string,
  key: string,
  label: string,
  opts: { avg200?: boolean; high52w?: boolean } = {},
): MacroSeriesInput | null {
  const value = valueAt(s, date)
  if (value === null) return null
  return {
    key,
    label,
    value,
    history: historyUntil(s, date),
    yearAgo: valueYearAgo(s, date),
    avg200: opts.avg200 === false ? null : meanLastN(s, date, 200),
    high52w: opts.high52w === false ? null : maxLastN(s, date, 252),
  }
}

/** 收益率曲线倒挂（2Y > 10Y）；缺任一侧返回 null */
export function inversionAt(rates2y: SeriesData, rates10y: SeriesData, date: string): boolean | null {
  const two = valueAt(rates2y, date)
  const ten = valueAt(rates10y, date)
  if (two === null || ten === null) return null
  return two > ten
}

/** 序列覆盖情况（数据质量面板用） */
export function seriesCoverage(db: DatabaseSync): { series: string; rows: number; from: string; to: string }[] {
  return db
    .prepare(
      `SELECT series, COUNT(*) AS rows, MIN(date) AS "from", MAX(date) AS "to"
         FROM macro_history GROUP BY series ORDER BY series`,
    )
    .all() as unknown as { series: string; rows: number; from: string; to: string }[]
}
