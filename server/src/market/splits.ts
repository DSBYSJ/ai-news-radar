import type { DatabaseSync } from 'node:sqlite'
import { fetchSplits, type StockSplit } from './fmp.ts'
import { UNIVERSE } from './universe.ts'

export function loadSplitHistory(db: DatabaseSync, symbol: string): { splits: StockSplit[]; checkedAt: string | null } {
  const row = db.prepare('SELECT splits, checked_at AS checkedAt FROM market_split_history WHERE symbol = ?').get(symbol) as { splits: string; checkedAt: string } | undefined
  if (!row) return { splits: [], checkedAt: null }
  try { const splits: unknown = JSON.parse(row.splits); return Array.isArray(splits) ? { splits: splits as StockSplit[], checkedAt: row.checkedAt } : { splits: [], checkedAt: null } }
  catch { return { splits: [], checkedAt: null } }
}

export async function syncSplits(db: DatabaseSync, opts: { only?: string[] } = {}) {
  const priced = new Set((db.prepare('SELECT DISTINCT symbol FROM equity_daily').all() as { symbol: string }[]).map(r => r.symbol))
  const companies = UNIVERSE.filter(c => opts.only?.length ? opts.only.includes(c.symbol) : priced.has(c.symbol))
  const skipped: { symbol: string; reason: string }[] = []
  const changed: string[] = []
  let rows = 0
  for (const company of companies) {
    try {
      const splits = await fetchSplits(company.symbol)
      const previous = loadSplitHistory(db, company.symbol)
      if (!previous.checkedAt || JSON.stringify(previous.splits) !== JSON.stringify(splits)) changed.push(company.symbol)
      db.prepare(`INSERT INTO market_split_history(symbol,splits,checked_at) VALUES (?,?,?)
        ON CONFLICT(symbol) DO UPDATE SET splits=excluded.splits, checked_at=excluded.checked_at`)
        .run(company.symbol, JSON.stringify(splits), new Date().toISOString())
      rows++
    } catch (error) { skipped.push({ symbol: company.symbol, reason: String(error).slice(0,120) }) }
  }
  return { symbols: companies.length, rows, skipped, changed }
}

/** 把申报时股本转换为与历史股价相同的拆股调整基准。 */
export function splitFactor(splits: StockSplit[], basisDate: string, adjustmentAsOf: string): number {
  return splits.filter(s => s.date > basisDate && s.date <= adjustmentAsOf)
    .reduce((factor, s) => factor * s.numerator / s.denominator, 1)
}
