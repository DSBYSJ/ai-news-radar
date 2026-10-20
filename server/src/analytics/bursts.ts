import type { DatabaseSync } from 'node:sqlite'
import { CATEGORIES } from '../ai/categories.ts'
import { dayRange } from './trend.ts'

/**
 * 突发检测（14 天滑动窗口 z-score）
 *
 * 口径（需求）：
 *  - 按「分类 × 日期」聚合每日文章数；类别含 'all'（全站合计）
 *  - 基线 = 当日之前 14 天的滑动均值/标准差（不含当日）
 *  - z = (当日文章数 - 均值) / 标准差；z ≥ 2.5 记为突发
 *  - 输出表 burst_detection(date, category, article_count, baseline_mean, z_score, …)
 *
 * 稳健性处理：
 *  - 基线不足 7 天 → 跳过（样本太少，z 不可信）
 *  - 标准差为 0 → 跳过（无法归一化）
 */
export interface BurstRow {
  date: string
  category: string
  articleCount: number
  baselineMean: number
  baselineStd: number
  z: number
}

export interface RebuildBurstsResult {
  scannedDays: number
  flagged: number
  rows: BurstRow[]
  /** 本次重建「新增」的突发（此前不在表中）—— 用于实时推送 */
  newBursts: BurstRow[]
}

const DAY_MS = 86_400_000

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length
}

/** 样本标准差（n-1，统计学惯例） */
function sampleStd(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((acc, v) => acc + (v - m) ** 2, 0) / (values.length - 1))
}

export async function rebuildBursts(
  opts: { db?: DatabaseSync; days?: number; baselineDays?: number; minBaselineDays?: number; threshold?: number } = {},
): Promise<RebuildBurstsResult> {
  const db = opts.db ?? (await import('../db.ts')).getDb()
  const days = opts.days ?? 30
  const baselineDays = opts.baselineDays ?? 14
  const minBaselineDays = opts.minBaselineDays ?? 7
  const threshold = opts.threshold ?? 2.5

  const dates = dayRange(days)
  const startIso = `${dates[0]}T00:00:00.000Z`
  const endIso = new Date(Date.parse(`${dates[dates.length - 1]}T00:00:00Z`) + DAY_MS).toISOString()

  // 逐日逐分类计数 + 全站合计
  const rows = db
    .prepare(
      `SELECT date(published_at) AS d, category AS c, COUNT(*) AS n
       FROM articles WHERE ai_relevant = 1 AND published_at >= ? AND published_at < ?
       GROUP BY d, c`,
    )
    .all(startIso, endIso) as unknown as { d: string; c: string; n: number }[]

  const byCategory = new Map<string, Map<string, number>>()
  const allCounts = new Map<string, number>()
  for (const r of rows) {
    const m = byCategory.get(r.c) ?? new Map<string, number>()
    m.set(r.d, Number(r.n))
    byCategory.set(r.c, m)
    allCounts.set(r.d, (allCounts.get(r.d) ?? 0) + Number(r.n))
  }

  const flagged: BurstRow[] = []
  for (const category of [...CATEGORIES, 'all']) {
    const series =
      category === 'all'
        ? dates.map((d) => allCounts.get(d) ?? 0)
        : dates.map((d) => byCategory.get(category)?.get(d) ?? 0)

    for (let i = 0; i < series.length; i++) {
      const baseline = series.slice(Math.max(0, i - baselineDays), i)
      if (baseline.length < minBaselineDays) continue

      const m = mean(baseline)
      const sd = sampleStd(baseline)
      if (sd === 0) continue

      const z = (series[i] - m) / sd
      if (z >= threshold) {
        flagged.push({
          date: dates[i],
          category,
          articleCount: series[i],
          baselineMean: Number(m.toFixed(3)),
          baselineStd: Number(sd.toFixed(3)),
          z: Number(z.toFixed(2)),
        })
      }
    }
  }

  // 按 Z-score 降序（前端列表直接可用）
  flagged.sort((a, b) => b.z - a.z)

  // 重建前记录已有 (date, category)，用于识别「本次新增」
  const existingKeys = new Set(
    (db.prepare('SELECT date, category FROM burst_detection').all() as unknown as { date: string; category: string }[]).map(
      (r) => `${r.date}|${r.category}`,
    ),
  )
  const newBursts = flagged.filter((r) => !existingKeys.has(`${r.date}|${r.category}`))

  // 重建语义：先清窗口内旧结果，再写入
  const now = new Date().toISOString()
  db.prepare('DELETE FROM burst_detection WHERE date >= ?').run(dates[0])
  const insert = db.prepare(
    `INSERT OR REPLACE INTO burst_detection (date, category, article_count, baseline_mean, baseline_std, z_score, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of flagged) {
    insert.run(r.date, r.category, r.articleCount, r.baselineMean, r.baselineStd, r.z, now)
  }

  return { scannedDays: dates.length, flagged: flagged.length, rows: flagged, newBursts }
}
