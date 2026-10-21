import type { DatabaseSync } from 'node:sqlite'
import { fetchCompanyFundamentals, loadTickerMap, type AnnualFundamentals } from './sec.ts'
import { UNIVERSE, type Company } from './universe.ts'

/**
 * 基本面同步（v0.36.0）
 *
 * 只做一件事：把 SEC XBRL 的年度事实拉下来、去重、落库。
 * **不算比率** —— 营收增速/净利率/ROE 都在读取时算（`deriveMetrics`），
 * 这样口径变了不用重跑全量同步。
 */

export interface SyncRow extends AnnualFundamentals {
  symbol: string
  revenueTag: string | null
}

export interface SyncReport {
  companies: number
  rows: number
  skipped: { symbol: string; reason: string }[]
  ms: number
}

export async function syncFundamentals(
  db: DatabaseSync,
  opts: { only?: string[] } = {},
): Promise<SyncReport> {
  const started = Date.now()
  const tickers = await loadTickerMap()
  const list = opts.only && opts.only.length > 0
    ? UNIVERSE.filter((c) => opts.only!.includes(c.symbol))
    : UNIVERSE

  const upsert = db.prepare(
    `INSERT INTO company_fundamentals
       (symbol, fiscal_end, revenue, net_income, equity, eps_diluted, shares, revenue_tag, filed_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, fiscal_end) DO UPDATE SET
       revenue = excluded.revenue, net_income = excluded.net_income, equity = excluded.equity,
       eps_diluted = excluded.eps_diluted, shares = excluded.shares,
       revenue_tag = excluded.revenue_tag, filed_at = excluded.filed_at, updated_at = excluded.updated_at`,
  )

  const skipped: SyncReport['skipped'] = []
  let rows = 0
  let inTx = false
  const now = new Date().toISOString()

  for (const c of list) {
    const t = tickers.get(c.symbol)
    if (!t) {
      skipped.push({ symbol: c.symbol, reason: 'SEC 未收录该 ticker（ADR/特殊结构常见）' })
      continue
    }
    try {
      const facts = await fetchCompanyFundamentals(t.cik)
      if (facts.annual.length === 0) {
        skipped.push({ symbol: c.symbol, reason: '没有可解析的年度营收事实' })
        continue
      }
      db.exec('BEGIN')
      inTx = true
      for (const a of facts.annual) {
        upsert.run(
          c.symbol,
          a.fiscalEnd,
          a.revenue,
          a.netIncome,
          a.equity,
          a.epsDiluted,
          a.shares,
          facts.revenueTag,
          a.filedAt,
          now,
        )
        rows += 1
      }
      db.exec('COMMIT')
      inTx = false
    } catch (err) {
      // 只有真的开了事务才回滚：否则 ROLLBACK 会抛 "no transaction is active"，
      // 把真正的错误（网络/参数）盖掉，排查时完全看不到原因
      if (inTx) {
        try {
          db.exec('ROLLBACK')
        } catch {
          /* 忽略回滚失败 */
        }
        inTx = false
      }
      skipped.push({ symbol: c.symbol, reason: String(err).slice(0, 120) })
    }
  }

  return { companies: list.length, rows, skipped, ms: Date.now() - started }
}

/* ============================ 读取与派生 ============================ */

export interface FundamentalsRow {
  fiscalEnd: string
  revenue: number | null
  netIncome: number | null
  equity: number | null
  epsDiluted: number | null
  shares: number | null
}

export interface DerivedMetrics {
  company: Company
  latest: FundamentalsRow | null
  /** 营收同比（%）—— 用相邻两个财年 */
  revenueGrowth: number | null
  /** 净利率（%） */
  netMargin: number | null
  /** ROE（%） */
  roe: number | null
  /** 连续营收年数，太少说明数据不可用 */
  years: number
  /**
   * 最新财年是否已经过时（超过 2 年）。
   * 为什么需要：标签选错时，"最新财年"可能是 2017 年，数字本身合法但毫无意义 ——
   * 不标记出来就会被当成当前基本面用。亚马逊踩过这个坑。
   */
  stale: boolean
}

/** 从库里读一家公司的年度序列（升序） */
export function loadFundamentals(db: DatabaseSync, symbol: string): FundamentalsRow[] {
  return db
    .prepare(
      `SELECT fiscal_end AS fiscalEnd, revenue, net_income AS netIncome, equity,
              eps_diluted AS epsDiluted, shares
         FROM company_fundamentals WHERE symbol = ? ORDER BY fiscal_end`,
    )
    .all(symbol) as unknown as FundamentalsRow[]
}

/** 派生指标：只算"能从财报直接读出"的东西，不掺价格 */
export function deriveMetrics(company: Company, rows: FundamentalsRow[]): DerivedMetrics {
  const latest = rows.length > 0 ? rows[rows.length - 1] : null
  const prev = rows.length > 1 ? rows[rows.length - 2] : null

  const revenueGrowth =
    latest?.revenue && prev?.revenue && prev.revenue > 0
      ? ((latest.revenue - prev.revenue) / prev.revenue) * 100
      : null

  const netMargin =
    latest?.revenue && latest?.netIncome !== null && latest.revenue > 0
      ? (latest.netIncome / latest.revenue) * 100
      : null

  const roe =
    latest?.netIncome !== null && latest?.equity && latest.equity > 0
      ? (latest.netIncome / latest.equity) * 100
      : null

  const stale =
    latest !== null && Date.now() - Date.parse(latest.fiscalEnd) > 2 * 365 * 86_400_000

  return { company, latest, revenueGrowth, netMargin, roe, years: rows.length, stale }
}

/** 整个清单的派生指标 */
export function deriveAll(db: DatabaseSync): DerivedMetrics[] {
  return UNIVERSE.map((c) => deriveMetrics(c, loadFundamentals(db, c.symbol)))
}

/**
 * 板块汇总。
 * ⚠️ 只汇总"有数据"的公司，并在结果里带上覆盖数 ——
 * 否则少了两家会让"板块净利率"看起来突然变好，其实是样本变了。
 */
export interface SegmentSummary {
  segment: string
  label: string
  companies: number
  covered: number
  /** 合计营收（美元） */
  revenue: number
  /** 合计净利（美元） */
  netIncome: number
  netMargin: number | null
  /** 净利率用的是哪几家（营收与净利都齐全的才算，否则分子分母口径不一致） */
  marginCovered: number
  /** 加权营收增速（按上年营收加权，避免小公司拉偏） */
  revenueGrowth: number | null
}

export function summarizeSegments(rows: DerivedMetrics[], labels: Record<string, string>): SegmentSummary[] {
  const bySeg = new Map<string, DerivedMetrics[]>()
  for (const r of rows) {
    const s = r.company.segment
    if (!bySeg.has(s)) bySeg.set(s, [])
    bySeg.get(s)!.push(r)
  }
  const out: SegmentSummary[] = []
  for (const [seg, list] of bySeg) {
    const withData = list.filter((x) => x.latest?.revenue)
    const revenue = withData.reduce((s, x) => s + (x.latest!.revenue ?? 0), 0)
    const netIncome = withData.reduce((s, x) => s + (x.latest!.netIncome ?? 0), 0)

    /*
     * 净利率必须用「营收与净利都齐全」的子集算。
     * 否则会出现：营收加了 6 家、净利只加到 5 家（某家缺 NetIncomeLoss），
     * 分母偏大分子偏小，比率被稀释；反之则虚高。这类口径错配极难在页面上看出来。
     */
    const withMargin = withData.filter((x) => x.latest!.netIncome !== null)
    const marginRevenue = withMargin.reduce((s, x) => s + (x.latest!.revenue ?? 0), 0)
    const marginNet = withMargin.reduce((s, x) => s + (x.latest!.netIncome ?? 0), 0)

    // 加权增速：权重 = 上年营收（用 latest.revenue / (1+g) 反推，避免再查一次库）
    let wsum = 0
    let acc = 0
    for (const x of withData) {
      if (x.revenueGrowth === null) continue
      const prevRev = (x.latest!.revenue ?? 0) / (1 + x.revenueGrowth / 100)
      if (prevRev <= 0) continue
      acc += x.revenueGrowth * prevRev
      wsum += prevRev
    }

    out.push({
      segment: seg,
      label: labels[seg] ?? seg,
      companies: list.length,
      covered: withData.length,
      revenue,
      netIncome,
      netMargin: marginRevenue > 0 ? (marginNet / marginRevenue) * 100 : null,
      marginCovered: withMargin.length,
      revenueGrowth: wsum > 0 ? acc / wsum : null,
    })
  }
  return out.sort((a, b) => b.revenue - a.revenue)
}
