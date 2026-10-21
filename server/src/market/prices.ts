import type { DatabaseSync } from 'node:sqlite'
import { fetchEodLight, fetchRatios, hasFmpKey } from './fmp.ts'
import { UNIVERSE } from './universe.ts'

/**
 * 行情与估值比率同步（v0.37.0）
 *
 * 两条纪律：
 *   1. **首次全量、之后增量** —— 免费档每月只有 512MB 带宽，
 *      18 家 × 126KB × 30 天 = 68MB/月，全量重下会翻 5 倍
 *   2. **不删旧数据** —— FMP 免费档只给近 5 年，今天能拿到的窗口明天可能变窄，
 *      删了就要不回来了
 */

export interface PriceSyncReport {
  symbols: number
  rows: number
  skipped: { symbol: string; reason: string }[]
  ms: number
}

export async function syncPrices(
  db: DatabaseSync,
  opts: { only?: string[]; full?: boolean } = {},
): Promise<PriceSyncReport> {
  if (!hasFmpKey()) throw new Error('未配置 FMP_API_KEY')
  const started = Date.now()
  const list = opts.only?.length ? UNIVERSE.filter((c) => opts.only!.includes(c.symbol)) : UNIVERSE

  const upsert = db.prepare(
    `INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close, volume = excluded.volume`,
  )
  const lastDate = db.prepare('SELECT MAX(date) AS d FROM equity_daily WHERE symbol = ?')

  const skipped: PriceSyncReport['skipped'] = []
  let rows = 0
  let inTx = false

  for (const c of list) {
    try {
      const last = (lastDate.get(c.symbol) as { d: string | null } | undefined)?.d ?? null
      // 增量：从最后一天往前推 5 天，覆盖"当天数据被修订"的情况
      const from = !opts.full && last ? shiftDays(last, -5) : undefined
      const eod = await fetchEodLight(c.symbol, from)
      if (eod.length === 0) {
        skipped.push({ symbol: c.symbol, reason: '接口返回空（可能超出免费档 5 年窗口）' })
        continue
      }
      db.exec('BEGIN')
      inTx = true
      for (const r of eod) {
        upsert.run(c.symbol, r.date, r.price, r.volume)
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

  return { symbols: list.length, rows, skipped, ms: Date.now() - started }
}

export interface RatioSyncReport {
  symbols: number
  rows: number
  skipped: { symbol: string; reason: string }[]
  ms: number
}

export async function syncRatios(db: DatabaseSync, opts: { only?: string[] } = {}): Promise<RatioSyncReport> {
  if (!hasFmpKey()) throw new Error('未配置 FMP_API_KEY')
  const started = Date.now()
  const list = opts.only?.length ? UNIVERSE.filter((c) => opts.only!.includes(c.symbol)) : UNIVERSE

  const upsert = db.prepare(
    `INSERT INTO company_ratios (symbol, fiscal_end, pe, ps, pb, revenue_per_share, net_income_per_share, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(symbol, fiscal_end) DO UPDATE SET
       pe = excluded.pe, ps = excluded.ps, pb = excluded.pb,
       revenue_per_share = excluded.revenue_per_share,
       net_income_per_share = excluded.net_income_per_share,
       updated_at = excluded.updated_at`,
  )

  const skipped: RatioSyncReport['skipped'] = []
  let rows = 0
  let inTx = false
  const now = new Date().toISOString()

  for (const c of list) {
    try {
      const ratios = await fetchRatios(c.symbol)
      if (ratios.length === 0) {
        skipped.push({ symbol: c.symbol, reason: '无估值比率' })
        continue
      }
      db.exec('BEGIN')
      inTx = true
      for (const r of ratios) {
        upsert.run(c.symbol, r.fiscalEnd, r.pe, r.ps, r.pb, r.revenuePerShare, r.netIncomePerShare, now)
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

  return { symbols: list.length, rows, skipped, ms: Date.now() - started }
}

/* ============================ 读取 ============================ */

export interface PriceRow {
  date: string
  close: number
  /** true = 这一天的价格是手工补录的（界面必须标出来，不能和接口数据混为一谈） */
  manual?: boolean
}

/**
 * 读取价格序列：接口数据 + 手工补录，按日期合并，**补录优先**。
 * 补录行带 `manual: true`，上层据此在界面上打标。
 */
export function loadPrices(db: DatabaseSync, symbol: string): PriceRow[] {
  const auto = db
    .prepare('SELECT date, close FROM equity_daily WHERE symbol = ?')
    .all(symbol) as unknown as PriceRow[]
  const manual = db
    .prepare('SELECT date, close FROM manual_price WHERE symbol = ?')
    .all(symbol) as unknown as PriceRow[]

  const byDate = new Map<string, PriceRow>()
  for (const r of auto) byDate.set(r.date, { date: r.date, close: Number(r.close), manual: false })
  for (const r of manual) byDate.set(r.date, { date: r.date, close: Number(r.close), manual: true })

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date))
}

export interface ManualPriceRow {
  symbol: string
  date: string
  close: number
  note: string | null
  updatedAt: string
}

/** 补录一条收盘价（同一天重复补录会覆盖） */
export function saveManualPrice(
  db: DatabaseSync,
  r: { symbol: string; date: string; close: number; note?: string },
): void {
  if (!Number.isFinite(r.close) || r.close <= 0) throw new Error('价格必须是正数')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.date)) throw new Error('日期格式应为 YYYY-MM-DD')
  db.prepare(
    `INSERT INTO manual_price (symbol, date, close, note, updated_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(symbol, date) DO UPDATE SET close = excluded.close, note = excluded.note, updated_at = excluded.updated_at`,
  ).run(r.symbol.toUpperCase(), r.date, r.close, r.note ?? null, new Date().toISOString())
}

export function listManualPrices(db: DatabaseSync, symbol?: string): ManualPriceRow[] {
  const sql = `SELECT symbol, date, close, note, updated_at AS updatedAt FROM manual_price
               ${symbol ? 'WHERE symbol = ?' : ''} ORDER BY symbol, date DESC`
  const stmt = db.prepare(sql)
  return (symbol ? stmt.all(symbol.toUpperCase()) : stmt.all()) as unknown as ManualPriceRow[]
}

export interface RatioRecord {
  fiscalEnd: string
  pe: number | null
  ps: number | null
  pb: number | null
}

export function loadRatios(db: DatabaseSync, symbol: string): RatioRecord[] {
  return db
    .prepare('SELECT fiscal_end AS fiscalEnd, pe, ps, pb FROM company_ratios WHERE symbol = ? ORDER BY fiscal_end')
    .all(symbol) as unknown as RatioRecord[]
}

function shiftDays(date: string, days: number): string {
  return new Date(Date.parse(date) + days * 86_400_000).toISOString().slice(0, 10)
}
