import type { DatabaseSync } from 'node:sqlite'
import type { FundamentalsRow } from './fundamentals.ts'
import { loadFundamentals } from './fundamentals.ts'
import { loadPrices, loadRatios, type PriceRow } from './prices.ts'
import { UNIVERSE, type Company } from './universe.ts'

/**
 * 估值序列（v0.37.0）
 *
 * 做法：**日频价格 × 当期财报口径**，而不是只用 FMP 给的 5 个年度点。
 *
 * 为什么不用 FMP 的年度 P/S 直接做分位：
 *   免费档只有 5 期年度比率，5 个点算分位几乎没有意义（0%、25%、50%…）。
 *   用日频价格配"当时已经披露的最近一期财报"，能得到 1000+ 个点的序列，
 *   分位才有统计意义。
 *
 * ⚠️ 这是「trailing」口径：t 日用的是 t 日之前**已披露**的最近年报，
 *    不是 t 日所在财年 —— 后者会用到未来数据（年报要等财年结束几个月才发）。
 */

export interface ValuationPoint {
  date: string
  close: number
  marketCap: number
  ps: number | null
  pe: number | null
}

/** 取 t 日"已经能看到"的最近一期财报（fiscalEnd <= t） */
function fundamentalsAt(rows: FundamentalsRow[], date: string): FundamentalsRow | null {
  let best: FundamentalsRow | null = null
  for (const r of rows) {
    if (r.fiscalEnd <= date) best = r
    else break
  }
  return best
}

export function buildDailyValuation(prices: PriceRow[], fundamentals: FundamentalsRow[]): ValuationPoint[] {
  const out: ValuationPoint[] = []
  for (const p of prices) {
    const f = fundamentalsAt(fundamentals, p.date)
    // 财报还没覆盖到这一天（比如 5 年前的价格配不到更早的财报）→ 跳过，不猜
    if (!f || !f.shares || f.shares <= 0) continue
    const marketCap = p.close * f.shares
    out.push({
      date: p.date,
      close: p.close,
      marketCap,
      ps: f.revenue && f.revenue > 0 ? marketCap / f.revenue : null,
      pe: f.epsDiluted && f.epsDiluted > 0 ? p.close / f.epsDiluted : null,
    })
  }
  return out
}

/** 百分位：value 在 series 中的位置（0~1）。样本 < 60 返回 null —— 太少没有意义 */
export function percentileIn(value: number, series: number[]): number | null {
  const clean = series.filter((v) => Number.isFinite(v))
  if (clean.length < 60) return null
  let below = 0
  for (const v of clean) if (v < value) below += 1
  return below / clean.length
}

function median(xs: number[]): number | null {
  const clean = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid]
}

export interface ValuationSummary {
  company: Company
  latest: ValuationPoint | null
  /** 当前 P/S 在自身 5 年日频序列中的分位 */
  psPercentile: number | null
  pePercentile: number | null
  psMedian: number | null
  /** 序列点数（≈ 交易日数） */
  points: number
}

export function summarizeValuation(company: Company, series: ValuationPoint[]): ValuationSummary {
  const latest = series.length > 0 ? series[series.length - 1] : null
  const psSeries = series.map((p) => p.ps).filter((v): v is number => v !== null)
  const peSeries = series.map((p) => p.pe).filter((v): v is number => v !== null)
  return {
    company,
    latest,
    psPercentile: latest?.ps != null ? percentileIn(latest.ps, psSeries) : null,
    pePercentile: latest?.pe != null ? percentileIn(latest.pe, peSeries) : null,
    psMedian: median(psSeries),
    points: series.length,
  }
}

export function deriveAllValuations(db: DatabaseSync): ValuationSummary[] {
  return UNIVERSE.map((c) =>
    summarizeValuation(c, buildDailyValuation(loadPrices(db, c.symbol), loadFundamentals(db, c.symbol))),
  )
}

export interface SegmentValuation {
  segment: string
  label: string
  covered: number
  /** 板块内 P/S 中位数（等权，避免巨头压死小公司） */
  psMedian: number | null
  /** 板块内估值分位的中位数 —— 比"中位 P/S"更能说明"整体贵不贵" */
  percentileMedian: number | null
}

export function summarizeSegmentValuation(
  rows: ValuationSummary[],
  labels: Record<string, string>,
): SegmentValuation[] {
  const bySeg = new Map<string, ValuationSummary[]>()
  for (const r of rows) {
    const s = r.company.segment
    if (!bySeg.has(s)) bySeg.set(s, [])
    bySeg.get(s)!.push(r)
  }
  const out: SegmentValuation[] = []
  for (const [seg, list] of bySeg) {
    const withPs = list.filter((x) => x.latest?.ps != null)
    out.push({
      segment: seg,
      label: labels[seg] ?? seg,
      covered: withPs.length,
      psMedian: median(withPs.map((x) => x.latest!.ps as number)),
      percentileMedian: median(
        withPs.map((x) => x.psPercentile).filter((v): v is number => v !== null),
      ),
    })
  }
  return out.sort((a, b) => (b.psMedian ?? 0) - (a.psMedian ?? 0))
}

/**
 * 自校验：用我们的「价格 × 股本 / 营收」在财年末复算 P/S，
 * 与 FMP 给的年度 P/S 对比。差太多说明口径或数据有问题。
 *
 * 为什么需要：估值模块最容易出现"数字看着合理但其实错了"的问题
 * （货币、股本单位、财年错位）。有一个独立来源可以对账，值得每次都跑。
 */
export interface RatioCheck {
  symbol: string
  fiscalEnd: string
  ours: number | null
  fmp: number | null
  relDiff: number | null
}

export function checkAgainstFmpRatios(db: DatabaseSync, symbol: string): RatioCheck[] {
  const prices = loadPrices(db, symbol)
  const fundamentals = loadFundamentals(db, symbol)
  const fmpRatios = loadRatios(db, symbol)
  const out: RatioCheck[] = []

  for (const r of fmpRatios) {
    // 找财年末当天或之后最近的一个交易日
    const px = prices.find((p) => p.date >= r.fiscalEnd)
    const f = fundamentals.find((x) => x.fiscalEnd === r.fiscalEnd)
    let ours: number | null = null
    if (px && f?.shares && f.revenue && f.revenue > 0) ours = (px.close * f.shares) / f.revenue
    out.push({
      symbol,
      fiscalEnd: r.fiscalEnd,
      ours,
      fmp: r.ps,
      relDiff: ours !== null && r.ps ? Math.abs(ours - r.ps) / r.ps : null,
    })
  }
  return out
}
