import type { DatabaseSync } from 'node:sqlite'
import { deriveAll, summarizeSegments, type DerivedMetrics, type SegmentSummary } from './fundamentals.ts'
import { SEGMENT_LABELS, UNIVERSE } from './universe.ts'
import { buildDailyValuation } from './valuation.ts'
import { loadFundamentals } from './fundamentals.ts'
import { loadPrices } from './prices.ts'

/**
 * 估值看板的数据装配（v0.38.0）
 *
 * 一条纪律：**覆盖不足必须显式说出来**。
 * FMP 免费档只覆盖部分标的（实测 18 家里 8 家），如果页面上直接留空，
 * 用户会以为是"这家公司没估值"，而不是"我们的数据源没权限"。
 */

export interface MarketCompanyRow {
  symbol: string
  name: string
  segment: string
  segmentLabel: string
  role: string
  /** 财年（YYYY-MM-DD） */
  fiscalEnd: string | null
  revenue: number | null
  netIncome: number | null
  revenueGrowth: number | null
  netMargin: number | null
  roe: number | null
  /** 最新财年超过 2 年（多半是 XBRL 标签问题） */
  stale: boolean
  /** 以下为估值字段：缺价格时为 null */
  close: number | null
  marketCap: number | null
  ps: number | null
  /** P/S 在自身历史中的分位 0~1 */
  psPercentile: number | null
  pe: number | null
  pePercentile: number | null
  /** 估值序列点数（≈ 交易日数）= 分位的有效样本数 */
  points: number
  /** 最新价格是否来自手工补录 */
  manualPrice: boolean
  /** 为什么没有估值（给界面直接显示，避免"空着"） */
  missingValuation: string | null
}

export interface MarketOverview {
  generatedAt: string
  coverage: {
    total: number
    /** 有价格的 */
    priced: number
    /** 能算 P/S 的 */
    valued: number
    /** 数据源说明（为什么覆盖不全） */
    note: string
    /** 分位所用的历史窗口（从实际数据算，不写死） */
    windowFrom: string | null
    windowTo: string | null
    /** 窗口年数（保留一位小数） */
    windowYears: number | null
  }
  segments: (SegmentSummary & { psMedian: number | null; percentileMedian: number | null; valuationCovered: number })[]
  companies: MarketCompanyRow[]
}

function median(xs: number[]): number | null {
  const clean = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b)
  if (clean.length === 0) return null
  const mid = Math.floor(clean.length / 2)
  return clean.length % 2 === 0 ? (clean[mid - 1] + clean[mid]) / 2 : clean[mid]
}

export function buildMarketOverview(db: DatabaseSync): MarketOverview {
  const fundamentals = deriveAll(db)
  const fundBySymbol = new Map<string, DerivedMetrics>(fundamentals.map((f) => [f.company.symbol, f]))

  const rows: MarketCompanyRow[] = UNIVERSE.map((c) => {
    const f = fundBySymbol.get(c.symbol)
    const prices = loadPrices(db, c.symbol)
    const series = buildDailyValuation(prices, loadFundamentals(db, c.symbol))
    const latest = series.length > 0 ? series[series.length - 1] : null
    const psSeries = series.map((p) => p.ps).filter((v): v is number => v !== null)

    let missing: string | null = null
    if (prices.length === 0) missing = 'FMP 免费档未覆盖该标的行情（可手工补录收盘价）'
    else if (!latest) missing = '缺少股本或营收，无法计算市值'
    else if (latest.ps === null) missing = '缺少营收，无法计算 P/S'

    return {
      symbol: c.symbol,
      name: c.name,
      segment: c.segment,
      segmentLabel: SEGMENT_LABELS[c.segment],
      role: c.role,
      fiscalEnd: f?.latest?.fiscalEnd ?? null,
      revenue: f?.latest?.revenue ?? null,
      netIncome: f?.latest?.netIncome ?? null,
      revenueGrowth: f?.revenueGrowth ?? null,
      netMargin: f?.netMargin ?? null,
      roe: f?.roe ?? null,
      stale: f?.stale ?? false,
      close: latest?.close ?? null,
      marketCap: latest?.marketCap ?? null,
      ps: latest?.ps ?? null,
      psPercentile: latest?.ps != null && psSeries.length >= 60 ? percentile(latest.ps, psSeries) : null,
      pe: latest?.pe ?? null,
      pePercentile: latest?.pe != null ? percentile(latest.pe, series.map((p) => p.pe).filter((v): v is number => v !== null)) : null,
      points: series.length,
      manualPrice: latest?.manual === true,
      missingValuation: missing,
    }
  })

  const baseSegments = summarizeSegments(fundamentals, SEGMENT_LABELS)
  const segments = baseSegments.map((s) => {
    const inSeg = rows.filter((r) => r.segment === s.segment && r.ps !== null)
    return {
      ...s,
      psMedian: median(inSeg.map((r) => r.ps as number)),
      percentileMedian: median(inSeg.map((r) => r.psPercentile).filter((v): v is number => v !== null)),
      valuationCovered: inSeg.length,
    }
  })

  const priced = rows.filter((r) => r.points > 0).length
  const valued = rows.filter((r) => r.ps !== null).length

  // 窗口从实际数据算，不写死 —— 写死"近 3 年"而实际是 5 年，就是在骗人
  const span = db.prepare('SELECT MIN(date) AS a, MAX(date) AS b FROM equity_daily').get() as
    | { a: string | null; b: string | null }
    | undefined
  const windowFrom = span?.a ?? null
  const windowTo = span?.b ?? null
  const windowYears =
    windowFrom && windowTo
      ? Number(((Date.parse(windowTo) - Date.parse(windowFrom)) / (365 * 86_400_000)).toFixed(1))
      : null

  return {
    generatedAt: new Date().toISOString(),
    coverage: {
      total: rows.length,
      priced,
      valued,
      note:
        valued < rows.length
          ? `行情数据来自 FMP 免费档，只覆盖部分标的（${valued}/${rows.length} 可算估值）；` +
            '未覆盖的标的不显示倍数，不是"没有估值"'
          : '全部标的均可计算估值',
      windowFrom,
      windowTo,
      windowYears,
    },
    segments,
    companies: rows,
  }
}

function percentile(value: number, series: number[]): number | null {
  const clean = series.filter((v) => Number.isFinite(v))
  if (clean.length < 60) return null
  let below = 0
  for (const v of clean) if (v < value) below += 1
  return Number((below / clean.length).toFixed(3))
}
