import type { DatabaseSync } from 'node:sqlite'
import { velocity } from './trend.ts'

/** 桌面小组件用的快照（字段保持稳定，App 端按名取值） */
export interface WidgetSnapshot {
  /** 库内最新一天（UTC），无数据为 null */
  today: string | null
  todayCount: number
  /** 周环比（%，正为升温），数据不足为 null */
  changePct: number | null
  /** 今日被 2 家以上独立源报道的事件数 */
  crossToday: number
  /** 近 3 天触发的突发条数 */
  bursts3d: number
  /** 近 3 天最高 z 值 */
  topBurstZ: number | null
  topBurstCategory: string | null
  /** 今日负面情感占比（0~1），无判定数据为 null */
  negShare: number | null
  /** 今日已判定情感的条数 */
  classified: number
  /** 今日跨源事件（最多 3 条，按源数降序） */
  crossEvents: { title: string; sourceCount: number; category: string }[]
  /** 近 3 天突发（最多 3 条，按 z 降序） */
  bursts: { date: string; category: string; count: number; z: number }[]
  /** 最新一份每日简报（日期 + 标题） */
  summary: { date: string; title: string } | null
  updatedAt: string
}

const EMPTY = (updatedAt: string): WidgetSnapshot => ({
  today: null,
  todayCount: 0,
  changePct: null,
  crossToday: 0,
  bursts3d: 0,
  topBurstZ: null,
  topBurstCategory: null,
  negShare: null,
  classified: 0,
  crossEvents: [],
  bursts: [],
  summary: null,
  updatedAt,
})

/**
 * 轻量快照：几条聚合 + 少量标题（最多 3 条跨源事件 / 3 条突发）。
 * 供手机桌面小组件的不同尺寸共用 —— **不下发条目列表**，也避免无谓的数据下发。
 */
export function widgetSnapshot(db: DatabaseSync): WidgetSnapshot {
  const updatedAt = new Date().toISOString()
  const today = (db.prepare('SELECT MAX(date(published_at)) AS d FROM articles').get() as { d: string | null }).d
  if (!today) return EMPTY(updatedAt)

  const todayCount = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM articles WHERE ai_relevant = 1 AND date(published_at) = ?').get(today) as { n: number }).n,
  )
  const crossToday = Number(
    (
      db
        .prepare('SELECT COUNT(*) AS n FROM event_clusters WHERE publish_date = ? AND source_count >= 2')
        .get(today) as { n: number }
    ).n,
  )
  const burstRow = db
    .prepare("SELECT COUNT(*) AS n, MAX(z_score) AS z FROM burst_detection WHERE date >= date(?, '-2 day')")
    .get(today) as { n: number; z: number | null }
  const topBurst = db
    .prepare("SELECT category FROM burst_detection WHERE date >= date(?, '-2 day') ORDER BY z_score DESC LIMIT 1")
    .get(today) as { category: string } | undefined

  const senti = db
    .prepare(
      'SELECT sentiment, COUNT(*) AS n FROM articles WHERE ai_relevant = 1 AND date(published_at) = ? AND sentiment IS NOT NULL GROUP BY sentiment',
    )
    .all(today) as unknown as { sentiment: string; n: number }[]
  const classified = senti.reduce((sum, r) => sum + Number(r.n), 0)
  const negative = Number(senti.find((r) => r.sentiment === 'negative')?.n ?? 0)

  const crossEvents = (
    db
      .prepare(
        `SELECT representative_title AS title, source_count AS sourceCount, category
         FROM event_clusters WHERE publish_date = ? AND source_count >= 2
         ORDER BY source_count DESC, article_count DESC LIMIT 3`,
      )
      .all(today) as unknown as { title: string; sourceCount: number; category: string }[]
  ).map((r) => ({ title: r.title, sourceCount: Number(r.sourceCount), category: r.category }))

  const bursts = (
    db
      .prepare(
        `SELECT date, category, article_count AS count, z_score AS z FROM burst_detection
         WHERE date >= date(?, '-2 day') ORDER BY z_score DESC LIMIT 3`,
      )
      .all(today) as unknown as { date: string; category: string; count: number; z: number }[]
  ).map((r) => ({ date: r.date, category: r.category, count: Number(r.count), z: Number(Number(r.z).toFixed(2)) }))

  const summary = db.prepare('SELECT date, title FROM daily_summaries ORDER BY date DESC LIMIT 1').get() as
    | { date: string; title: string }
    | undefined

  return {
    today,
    todayCount,
    changePct: velocity(db, 7).changePct,
    crossToday,
    bursts3d: Number(burstRow.n),
    topBurstZ: burstRow.z === null ? null : Number(Number(burstRow.z).toFixed(2)),
    topBurstCategory: topBurst?.category ?? null,
    negShare: classified > 0 ? Number((negative / classified).toFixed(3)) : null,
    classified,
    crossEvents,
    bursts,
    summary: summary ?? null,
    updatedAt,
  }
}