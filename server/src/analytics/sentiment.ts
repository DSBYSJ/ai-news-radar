import type { DatabaseSync } from 'node:sqlite'
import { dayRange } from './trend.ts'

/** 情感趋势分析：每日正/负/中比例、实体负面占比曲线、实体负面飙升预警 */

const DAY_MS = 86_400_000

export type SentimentKey = 'positive' | 'neutral' | 'negative'
export const SENTIMENT_KEYS: SentimentKey[] = ['positive', 'neutral', 'negative']

export interface SentimentDay {
  date: string
  total: number
  classified: number
  counts: Record<SentimentKey, number>
  ratios: Record<SentimentKey, number>
}

function cutoffIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

export function dailySentiment(db: DatabaseSync, days = 30): SentimentDay[] {
  const totals = new Map<string, number>()
  for (const r of db
    .prepare('SELECT date(published_at) AS d, COUNT(*) AS n FROM articles WHERE published_at >= ? GROUP BY d')
    .all(cutoffIso(days)) as unknown as { d: string; n: number }[]) {
    totals.set(r.d, Number(r.n))
  }

  const counts = new Map<string, Record<SentimentKey, number>>()
  for (const r of db
    .prepare(
      `SELECT date(published_at) AS d, sentiment AS s, COUNT(*) AS n
       FROM articles
       WHERE published_at >= ? AND sentiment IS NOT NULL
       GROUP BY d, s`,
    )
    .all(cutoffIso(days)) as unknown as { d: string; s: SentimentKey; n: number }[]) {
    const row = counts.get(r.d) ?? { positive: 0, neutral: 0, negative: 0 }
    row[r.s] = Number(r.n)
    counts.set(r.d, row)
  }

  return dayRange(days).map((date) => {
    const c = counts.get(date) ?? { positive: 0, neutral: 0, negative: 0 }
    const classified = c.positive + c.neutral + c.negative
    return {
      date,
      total: totals.get(date) ?? 0,
      classified,
      counts: c,
      ratios: {
        positive: classified > 0 ? c.positive / classified : 0,
        neutral: classified > 0 ? c.neutral / classified : 0,
        negative: classified > 0 ? c.negative / classified : 0,
      },
    }
  })
}

export interface EntitySentimentPoint {
  date: string
  count: number
  negative: number
  negRatio: number
  ma7: number | null
}

export interface EntitySentimentResult {
  entity: string
  points: EntitySentimentPoint[]
  total: number
  negative: number
}

/** 某实体的负面占比曲线（7 日滑动平均） */
export function entitySentiment(db: DatabaseSync, entity: string, days = 30): EntitySentimentResult {
  const rows = db
    .prepare(
      `SELECT date(a.published_at) AS d, COUNT(*) AS n,
              SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS neg
       FROM mentions m JOIN articles a ON a.id = m.article_id
       WHERE m.entity = ? AND a.published_at >= ? AND a.sentiment IS NOT NULL
       GROUP BY d`,
    )
    .all(entity, cutoffIso(days)) as unknown as { d: string; n: number; neg: number }[]

  const map = new Map(rows.map((r) => [r.d, { n: Number(r.n), neg: Number(r.neg) }]))

  const raw = dayRange(days).map((date) => {
    const r = map.get(date)
    return { date, count: r?.n ?? 0, negative: r?.neg ?? 0, negRatio: r && r.n > 0 ? r.neg / r.n : 0 }
  })

  const points: EntitySentimentPoint[] = raw.map((p, i) => {
    const window = raw.slice(Math.max(0, i - 6), i + 1).filter((x) => x.count > 0)
    const ma7 = window.length > 0 ? window.reduce((a, b) => a + b.negRatio, 0) / window.length : null
    return { ...p, ma7: ma7 === null ? null : Number(ma7.toFixed(3)) }
  })

  const total = raw.reduce((a, b) => a + b.count, 0)
  const negative = raw.reduce((a, b) => a + b.negative, 0)
  return { entity, points, total, negative }
}

export interface SentimentAlert {
  date: string
  entity: string
  negativeCount: number
  baseline: number
  z: number
}

/**
 * 实体负面情感飙升预警：
 * 对窗口内提及最多的实体，逐日统计「负面文章数」，
 * 基线取前 14 天滑动均值/标准差，z ≥ 2 且当日负面数 ≥ 3 → 预警。
 */
export function sentimentAlerts(
  db: DatabaseSync,
  days = 30,
  opts: { topN?: number; threshold?: number; baselineDays?: number; minCount?: number } = {},
): SentimentAlert[] {
  const topN = opts.topN ?? 12
  const threshold = opts.threshold ?? 2
  const baselineDays = opts.baselineDays ?? 14
  const minCount = opts.minCount ?? 3

  const top = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n
       FROM mentions m JOIN articles a ON a.id = m.article_id
       WHERE a.ai_relevant = 1 AND a.published_at >= ?
       GROUP BY m.entity ORDER BY n DESC LIMIT ?`,
    )
    .all(cutoffIso(days), topN) as unknown as { entity: string; n: number }[]

  const extended = dayRange(days + baselineDays)
  const result: SentimentAlert[] = []

  for (const { entity } of top) {
    const rows = db
      .prepare(
        `SELECT date(a.published_at) AS d, COUNT(*) AS n
         FROM mentions m JOIN articles a ON a.id = m.article_id
         WHERE m.entity = ? AND a.sentiment = 'negative' AND a.published_at >= ?
         GROUP BY d`,
      )
      .all(entity, cutoffIso(days + baselineDays)) as unknown as { d: string; n: number }[]

    const map = new Map(rows.map((r) => [r.d, Number(r.n)]))
    const series = extended.map((d) => map.get(d) ?? 0)

    for (let i = baselineDays; i < series.length; i++) {
      const baseline = series.slice(Math.max(0, i - baselineDays), i)
      if (baseline.length < 7) continue
      const mean = baseline.reduce((a, b) => a + b, 0) / baseline.length
      if (baseline.length < 2) continue
      const sd = Math.sqrt(baseline.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (baseline.length - 1))
      if (sd === 0) continue
      const z = (series[i] - mean) / sd
      if (z >= threshold && series[i] >= minCount) {
        result.push({
          date: extended[i],
          entity,
          negativeCount: series[i],
          baseline: Number(mean.toFixed(2)),
          z: Number(z.toFixed(2)),
        })
      }
    }
  }

  result.sort((a, b) => b.z - a.z)
  return result.slice(0, 30)
}

export interface EntitySentimentBrief {
  entity: string
  count: number
  negative: number
  negShare: number
}

/** 窗口内提及最多的实体（带负面占比），供前端选择器用 */
export function topEntitiesWithSentiment(db: DatabaseSync, days = 30, limit = 8): EntitySentimentBrief[] {
  const rows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n,
              SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS neg
       FROM mentions m JOIN articles a ON a.id = m.article_id
       WHERE a.ai_relevant = 1 AND a.published_at >= ?
       GROUP BY m.entity ORDER BY n DESC LIMIT ?`,
    )
    .all(cutoffIso(days), limit) as unknown as { entity: string; n: number; neg: number }[]

  return rows.map((r) => ({
    entity: r.entity,
    count: Number(r.n),
    negative: Number(r.neg),
    negShare: Number(r.n) > 0 ? Number((Number(r.neg) / Number(r.n)).toFixed(3)) : 0,
  }))
}
