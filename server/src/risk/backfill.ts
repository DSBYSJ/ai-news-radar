import type { DatabaseSync } from 'node:sqlite'
import { computeCrs, computeNfi, type RiskParams } from './calculation.ts'
import { loadMacro } from './macro.ts'
import { narrativeInputs } from './narrative.ts'
import { loadParams } from './params.ts'
import {
  buildMacroInput,
  inversionAt,
  loadSeries,
  type SeriesData,
} from './macroHistory.ts'

/**
 * 风险日快照回算（v0.26.0 起，v0.28.0 修数据层）
 *
 *   node src/risk/backfill.ts --days=180 [--apply]
 *
 * 做什么：
 *   1. 拉宏观长历史（20 年）→ 写入 `macro_history`（真实观测日期）
 *   2. 逐日计算 NFI（30 日尾随窗口）与 CRS → 写入 `risk_daily`
 *
 * 为什么要异步：一年 = 365 次窗口聚合，接口里同步跑必然超时；
 * 这里作为独立 CLI / 后台任务跑，接口只负责"发起 + 查进度"。
 *
 * ⚠️ v0.28.0 修掉的三个问题（历史快照曾因此不可信）：
 *   1. `storeMacroHistory` 原先按「末尾日期倒推一天」编日期 —— FRED 是交易日序列，
 *      20 年约 5000 个观测被压进 5000 个自然日（≈13.7 年），日期整体前移，分位数全错。
 *      现在直接用采集回来的真实日期。
 *   2. `historyUntil` 用的 key 是 `rates/credit/index`，而库内 series 名是
 *      `rates10y/creditSpread/nasdaq` —— 永远查不到数据，导致所有分位数恒为 null。
 *   3. 回算时 yearAgo / avg200 / high52w / inversion 全部传 null，
 *      于是「利差走阔」「指数超涨」「回撤」「倒挂」四类信号在历史快照里根本没参与计算。
 *      现在按 point-in-time 口径补齐（只用当天及以前的观测）。
 */

export interface BackfillReport {
  days: number
  macroRows: number
  snapshots: number
  nfiRange: [number | null, number | null]
  crsRange: [number | null, number | null]
  /** 分位数为非 null 的天数占比（数据层是否真的生效的体检指标） */
  percentileCoverage: number
  ms: number
}

/** 把宏观历史写入 macro_history（幂等 upsert，使用真实观测日期） */
export function storeMacroHistory(
  db: DatabaseSync,
  series: Record<string, { history: number[]; dates: string[]; asOf: string }>,
): number {
  const upsert = db.prepare(
    `INSERT INTO macro_history (date, series, value) VALUES (?, ?, ?)
     ON CONFLICT(date, series) DO UPDATE SET value = excluded.value`,
  )
  let rows = 0
  db.exec('BEGIN')
  try {
    for (const [key, s] of Object.entries(series)) {
      if (s.history.length !== s.dates.length) {
        throw new Error(`${key} 的 history 与 dates 长度不一致（${s.history.length} vs ${s.dates.length}）`)
      }
      /*
       * 先清空该序列再整段写入：旧版本用「末尾日期倒推」伪造过日期，
       * 那些行和真实日期对不上，只 upsert 不删会让同一条序列混进两套时间轴。
       * 我们每次都拉全量历史，所以整段替换是安全的。
       */
      db.prepare('DELETE FROM macro_history WHERE series = ?').run(key)
      for (let i = 0; i < s.dates.length; i++) {
        upsert.run(s.dates[i], key, s.history[i])
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

interface SeriesBundle {
  rates10y: SeriesData
  rates2y: SeriesData
  creditSpread: SeriesData
  nasdaq: SeriesData
}

function loadBundle(db: DatabaseSync): SeriesBundle {
  return {
    rates10y: loadSeries(db, 'rates10y'),
    rates2y: loadSeries(db, 'rates2y'),
    creditSpread: loadSeries(db, 'creditSpread'),
    nasdaq: loadSeries(db, 'nasdaq'),
  }
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
  const bundle = loadBundle(db)

  const insert = db.prepare(
    `INSERT INTO risk_daily (date, nfi, nfi_factors, crs, crs_factors, divergences, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET nfi = excluded.nfi, nfi_factors = excluded.nfi_factors,
       crs = excluded.crs, crs_factors = excluded.crs_factors, divergences = excluded.divergences,
       created_at = excluded.created_at`,
  )

  let snapshots = 0
  let withPercentile = 0
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

      // point-in-time：全部只用 <= date 的观测
      const rates = buildMacroInput(bundle.rates10y, date, 'rates', '10 年期美债收益率')
      const credit = buildMacroInput(bundle.creditSpread, date, 'credit', '高收益债信用利差（OAS）')
      const index = buildMacroInput(bundle.nasdaq, date, 'index', '纳斯达克综合指数')

      const crs = computeCrs(
        {
          nfi: nfi.score,
          rates,
          credit,
          index,
          inversion: inversionAt(bundle.rates2y, bundle.rates10y, date),
          concentration: inputs.concentration,
        },
        params,
      )

      if (rates?.history.length && rates.history.length >= 30) withPercentile += 1

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
    percentileCoverage: snapshots > 0 ? Number((withPercentile / snapshots).toFixed(3)) : 0,
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
    const series: Record<string, { history: number[]; dates: string[]; asOf: string }> = {}
    for (const [k, v] of Object.entries(macro.series)) {
      series[k] = { history: v.history, dates: v.dates, asOf: v.asOf }
    }
    macroRows = storeMacroHistory(db, series)
  }
  const report = backfillRisk(db, opts)
  report.macroRows = macroRows
  return report
}
