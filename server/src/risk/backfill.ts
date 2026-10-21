import type { DatabaseSync } from 'node:sqlite'
import { computeCrs, computeNfi, type RiskParams } from './calculation.ts'
import { loadMacro } from './macro.ts'
import { narrativeInputs } from './narrative.ts'
import { loadParams } from './params.ts'

/**
 * 风险日快照回算（异步任务，v0.26.0）
 *
 *   node src/risk/backfill.ts --days=180 [--apply]
 *
 * 做什么：
 *   1. 拉宏观长历史（20 年）→ 写入 `macro_history`（供分位数与回溯）
 *   2. 逐日计算 NFI（30 日尾随窗口）与 CRS → 写入 `risk_daily`
 *
 * 为什么要异步：一年 = 365 次窗口聚合，接口里同步跑必然超时；
 * 这里作为独立 CLI / 后台任务跑，接口只负责"发起 + 查进度"。
 */

export interface BackfillReport {
  days: number
  macroRows: number
  snapshots: number
  nfiRange: [number | null, number | null]
  crsRange: [number | null, number | null]
  ms: number
}

/** 把宏观历史写入 macro_history（幂等 upsert） */
export function storeMacroHistory(db: DatabaseSync, series: Record<string, { history: number[]; asOf: string }>): number {
  const upsert = db.prepare(
    `INSERT INTO macro_history (date, series, value) VALUES (?, ?, ?)
     ON CONFLICT(date, series) DO UPDATE SET value = excluded.value`,
  )
  let rows = 0
  db.exec('BEGIN')
  try {
    for (const [key, s] of Object.entries(series)) {
      // history 是按时间升序的值序列；没有日期数组，用末尾日期倒推（仅供分位数粗用）
      const n = s.history.length
      if (n === 0) continue
      const end = Date.parse(s.asOf)
      for (let i = 0; i < n; i++) {
        const date = new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10)
        upsert.run(date, key, s.history[i])
        rows += 1
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return rows
}

/** 从 macro_history 取出某天之前的历史序列（用于分位数） */
function historyUntil(db: DatabaseSync, series: string, date: string): number[] {
  return (
    db.prepare('SELECT value FROM macro_history WHERE series = ? AND date <= ? ORDER BY date').all(series, date) as unknown as {
      value: number
    }[]
  ).map((r) => Number(r.value))
}

/** 逐日回算 NFI / CRS */
export function backfillRisk(
  db: DatabaseSync,
  opts: { days?: number; now?: number; apply?: boolean } = {},
): BackfillReport {
  const started = Date.now()
  const days = Math.max(7, Math.min(400, opts.days ?? 180))
  const now = opts.now ?? Date.now()
  const params: RiskParams = loadParams(db)
  const dayMs = 86_400_000

  const insert = db.prepare(
    `INSERT INTO risk_daily (date, nfi, nfi_factors, crs, crs_factors, divergences, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET nfi = excluded.nfi, nfi_factors = excluded.nfi_factors,
       crs = excluded.crs, crs_factors = excluded.crs_factors, divergences = excluded.divergences,
       created_at = excluded.created_at`,
  )

  let snapshots = 0
  let nfiMin: number | null = null
  let nfiMax: number | null = null
  let crsMin: number | null = null
  let crsMax: number | null = null

  if (opts.apply) db.exec('BEGIN')
  try {
    for (let i = days; i >= 0; i--) {
      const dayEnd = now - i * dayMs
      const date = new Date(dayEnd).toISOString().slice(0, 10)
      const inputs = narrativeInputs(db, { days: 30, now: dayEnd })
      const nfi = computeNfi(
        {
          articles: inputs.articles,
          moneyShare: inputs.moneyShare,
          sentimentSkew: inputs.sentimentSkew,
          concentration: inputs.concentration,
          acceleration: inputs.acceleration,
          fomo: inputs.fomo,
        },
        params,
      )

      const macroAt = (series: string): number | null => {
        const row = db
          .prepare('SELECT value FROM macro_history WHERE series = ? AND date <= ? ORDER BY date DESC LIMIT 1')
          .get(series, date) as { value: number } | undefined
        return row ? Number(row.value) : null
      }
      const ratesV = macroAt('rates10y')
      const creditV = macroAt('creditSpread')
      const indexV = macroAt('nasdaq')
      const macroInput = (key: string, label: string, value: number | null) =>
        value === null
          ? null
          : {
              key,
              label,
              value,
              history: historyUntil(db, key, date),
              yearAgo: null,
              avg200: null,
              high52w: null,
            }
      const crs = computeCrs(
        {
          nfi: nfi.score,
          rates: macroInput('rates', '10 年期美债收益率', ratesV),
          credit: macroInput('credit', '高收益债信用利差（OAS）', creditV),
          index: macroInput('index', '纳斯达克综合指数', indexV),
          inversion: null,
        },
        params,
      )

      if (nfi.score !== null) {
        nfiMin = nfiMin === null ? nfi.score : Math.min(nfiMin, nfi.score)
        nfiMax = nfiMax === null ? nfi.score : Math.max(nfiMax, nfi.score)
      }
      crsMin = crsMin === null ? crs.score : Math.min(crsMin, crs.score)
      crsMax = crsMax === null ? crs.score : Math.max(crsMax, crs.score)

      if (opts.apply) {
        insert.run(
          date,
          nfi.score,
          JSON.stringify(nfi.factors),
          crs.score,
          JSON.stringify(crs.factors),
          '[]',
          new Date().toISOString(),
        )
      }
      snapshots += 1
    }
    if (opts.apply) db.exec('COMMIT')
  } catch (err) {
    if (opts.apply) db.exec('ROLLBACK')
    throw err
  }

  return {
    days,
    macroRows: 0,
    snapshots,
    nfiRange: [nfiMin, nfiMax],
    crsRange: [crsMin, crsMax],
    ms: Date.now() - started,
  }
}

/** 拉宏观并回算（完整流程） */
export async function runBackfill(
  db: DatabaseSync,
  opts: { days?: number; now?: number; apply?: boolean } = {},
): Promise<BackfillReport> {
  const macro = await loadMacro(undefined)
  let macroRows = 0
  if (opts.apply && macro.available) {
    const series: Record<string, { history: number[]; asOf: string }> = {}
    for (const [k, v] of Object.entries(macro.series)) series[k] = { history: v.history, asOf: v.asOf }
    macroRows = storeMacroHistory(db, series)
  }
  const report = backfillRisk(db, opts)
  report.macroRows = macroRows
  return report
}
