import type { DatabaseSync } from 'node:sqlite'
import type { FundamentalsRow } from './fundamentals.ts'
import { loadFundamentals } from './fundamentals.ts'
import { loadPrices, loadRatios, type PriceRow } from './prices.ts'
import { UNIVERSE, type Company } from './universe.ts'
import type { StockSplit } from './fmp.ts'
import { splitFactor, loadSplitHistory } from './splits.ts'

/**
 * 年报相对估值 v2：日频价格配当时已披露年报，以实际拆股统一股本单位。
 * 历史参照只取已结束月份的月末快照，近三年至少 24 个有效月份。
 * 这是已披露年度口径，不是 TTM；日频点数不代表独立财务样本数。
 */

/** 某个估值点用了哪份财报 —— 可追溯性（每个点都能解释自己是怎么算出来的） */
export interface ValuationBasis {
  fiscalEnd: string
  filedAt: string
  /** false = 该版本缺真实申报日，退回财年末，不能用于严格时点回测 */
  pitReliable: boolean
  splitFactor: number
  sharesAsOf: string | null
  sharesFiledAt: string | null
  shareBasisReliable: boolean
  financialAgeDays: number
}

export interface ValuationPoint {
  date: string
  close: number
  marketCap: number
  ps: number | null
  pe: number | null
  /** 这一天的价格是手工补录的 */
  manual?: boolean
  /** 该点采用的财报版本（可追溯） */
  basis?: ValuationBasis
}

/**
 * 取 t 日「当时已公开的最新有效版本」。
 *
 * 严格历史时点口径（不是首次披露口径）：
 *   1. 只有申报日 ≤ t 的版本才可见（10-K 在财年结束后 1~3 个月才提交）
 *   2. 同一财年有多个版本时（比较期重报、正式重述），取**申报日最大**的那个 ——
 *      即"截至 t 日市场能看到的最新版本"，重述从它实际公开的那天起才生效
 *   3. 不同财年之间取**财年最新**的
 *
 * 与「首次披露口径」的区别：首次披露会让重述永远不生效；
 * 这里重述会在其公开日之后生效 —— 这才是"当时真实可见"的信息集。
 */
function fundamentalsAt(rows: FundamentalsRow[], date: string): FundamentalsRow | null {
  let best: FundamentalsRow | null = null
  for (const r of rows) {
    const filed = r.filedAt ?? r.fiscalEnd
    if (filed > date || r.fiscalEnd > date) continue
    if (!best) {
      best = r
      continue
    }
    const bestFiled = best.filedAt ?? best.fiscalEnd
    // 财年更新者优先；同财年取申报更晚的版本
    if (r.fiscalEnd > best.fiscalEnd || (r.fiscalEnd === best.fiscalEnd && filed > bestFiled)) {
      best = r
    }
  }
  return best
}

export function buildDailyValuation(prices: PriceRow[], fundamentals: FundamentalsRow[], opts: { splits?: StockSplit[]; adjustmentAsOf?: string } = {}): ValuationPoint[] {
  const out: ValuationPoint[] = []
  const ordered = [...prices].filter(p => Number.isFinite(p.close) && p.close > 0).sort((a,b) => a.date.localeCompare(b.date))
  const adjustmentAsOf = opts.adjustmentAsOf ?? ordered.at(-1)?.date ?? ''
  for (const p of ordered) {
    const f = fundamentalsAt(fundamentals, p.date)
    // 财报还没覆盖到这一天（比如 5 年前的价格配不到更早的财报）→ 跳过，不猜
    if (!f || !f.shares || f.shares <= 0) continue
    const basisDate = f.sharesFiledAt ?? f.filedAt ?? f.fiscalEnd
    const factor = splitFactor(opts.splits ?? [], basisDate, adjustmentAsOf)
    const marketCap = p.close * f.shares * factor
    const impliedShares = f.netIncome && f.netIncome > 0 && f.epsDiluted && f.epsDiluted > 0 ? f.netIncome / f.epsDiluted : null
    const shareConsistency = impliedShares === null || impliedShares / f.shares >= 0.65 && impliedShares / f.shares <= 1.55
    out.push({
      date: p.date,
      close: p.close,
      marketCap,
      ps: f.revenue && f.revenue > 0 ? marketCap / f.revenue : null,
      // 与 P/S 使用同一市值分子，避免 EPS 与普通股股数口径混搭。
      pe: f.netIncome && f.netIncome > 0 ? marketCap / f.netIncome : null,
      manual: p.manual === true,
      basis: {
        fiscalEnd: f.fiscalEnd,
        filedAt: f.filedAt ?? f.fiscalEnd,
        // 显式标记优先；没有标记时按"是否有真实申报日"推断（不能默认 true）
        pitReliable: f.pitReliable ?? f.filedAt != null,
        splitFactor: factor,
        sharesAsOf: f.sharesAsOf ?? null,
        sharesFiledAt: f.sharesFiledAt ?? null,
        shareBasisReliable: Boolean(f.sharesFiledAt && f.sharesFiledAt <= p.date && shareConsistency),
        financialAgeDays: Math.max(0, Math.floor((Date.parse(p.date) - Date.parse(f.fiscalEnd)) / 86_400_000)),
      },
    })
  }
  return out
}

/** 百分位：value 在 series 中的位置（0~1）。样本 < 60 返回 null —— 太少没有意义 */
export function percentileIn(value: number, series: number[]): number | null {
  const clean = series.filter((v) => Number.isFinite(v))
  if (clean.length < 60) return null
  let below = 0
  let equal = 0
  for (const v of clean) { if (v < value) below += 1; else if (v === value) equal += 1 }
  return (below + equal / 2) / clean.length
}

export interface MonthlyReference {
  psPercentile: number | null; pePercentile: number | null
  psMedian: number | null; peMedian: number | null
  months: number; peMonths: number; from: string | null; until: string | null
}

/** 近三年已结束月份的月末快照；缺失/过旧财报、补录和未核验股本退出参照。 */
export function monthlyReference(series: ValuationPoint[], current: ValuationPoint, verifiedSplits: boolean): MonthlyReference {
  const cutoff = new Date(Date.parse(current.date) - 3 * 365.25 * 86_400_000).toISOString().slice(0,10)
  const byMonth = new Map<string, ValuationPoint>()
  if (verifiedSplits) for (const point of [...series].sort((a,b) => a.date.localeCompare(b.date))) {
    if (point.date < cutoff || point.date.slice(0,7) >= current.date.slice(0,7)) continue
    byMonth.set(point.date.slice(0,7), point)
  }
  // 先取实际月末，再核验；月末无效时不能拿月中旧快照替代。
  const points = [...byMonth.values()].filter(point => !point.manual && point.basis?.pitReliable &&
    point.basis.shareBasisReliable && point.basis.financialAgeDays <= 550)
  const psPoints = points.filter(p => p.ps !== null && Number.isFinite(p.ps) && p.ps > 0)
  const ps = points.map(p => p.ps).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0)
  const pe = points.map(p => p.pe).filter((v): v is number => v !== null && Number.isFinite(v) && v > 0)
  const rank = (value: number | null, values: number[]) => value === null || values.length < 24 ? null :
    Number(((values.filter(v => v < value).length + values.filter(v => v === value).length / 2) / values.length).toFixed(3))
  return { psPercentile: rank(current.ps, ps), pePercentile: rank(current.pe, pe), psMedian: median(ps), peMedian: median(pe),
    months: ps.length, peMonths: pe.length, from: psPoints[0]?.date ?? null, until: psPoints.at(-1)?.date ?? null }
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
  /** 当前 P/S 在自身近三年月末参照中的分位 */
  psPercentile: number | null
  pePercentile: number | null
  psMedian: number | null
  /** 序列点数（≈ 交易日数） */
  points: number
}

export function summarizeValuation(company: Company, series: ValuationPoint[], verifiedSplits = false): ValuationSummary {
  const latest = series.length > 0 ? series[series.length - 1] : null
  const reference = latest ? monthlyReference(series, latest, verifiedSplits) : null
  return {
    company,
    latest,
    psPercentile: reference?.psPercentile ?? null,
    pePercentile: reference?.pePercentile ?? null,
    psMedian: reference?.psMedian ?? null,
    points: series.length,
  }
}

export function deriveAllValuations(db: DatabaseSync): ValuationSummary[] {
  return UNIVERSE.map(c => {
    const prices = loadPrices(db,c.symbol), actions = loadSplitHistory(db,c.symbol)
    const date = prices.at(-1)?.date
    return summarizeValuation(c,buildDailyValuation(prices,loadFundamentals(db,c.symbol),{splits:actions.splits,adjustmentAsOf:date}),
      Boolean(date && actions.checkedAt && actions.checkedAt.slice(0,10) >= date))
  })
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
    // 仅作事后年度对账，不用于历史决策；取财年末之前最后交易日。
    const px = prices.filter(p => p.date <= r.fiscalEnd).at(-1)
    const f = fundamentals.filter(x => x.fiscalEnd === r.fiscalEnd).at(-1)
    const actions = loadSplitHistory(db,symbol)
    let ours: number | null = null
    if (px && f?.shares && f.sharesFiledAt && f.revenue && f.revenue > 0 && actions.checkedAt) {
      ours = px.close * f.shares * splitFactor(actions.splits,f.sharesFiledAt,prices.at(-1)!.date) / f.revenue
    }
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
