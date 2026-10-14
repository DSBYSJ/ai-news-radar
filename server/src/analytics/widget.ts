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
  /** 最新一份每日简报（日期 + 标题） */
  summary: { date: string; title: string } | null
  updatedAt: string
}

/**
 * 轻量快照：只查 4 条聚合 + 1 条简报，供手机桌面小组件快速展示。
 * 不返回条目列表——小组件放不下，也避免无谓的数据下发。
 */
export function widgetSnapshot(db: DatabaseSync): WidgetSnapshot {
  const updatedAt = new Date().toISOString()
  const today = (db.prepare('SELECT MAX(date(published_at)) AS d FROM articles').get() as { d: string | null }).d

  if (!today) {
    return {
      today: null,
      todayCount: 0,
      changePct: null,
      crossToday: 0,
      bursts3d: 0,
      topBurstZ: null,
      topBurstCategory: null,
      summary: null,
      updatedAt,
    }
  }

  const todayCount = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM articles WHERE date(published_at) = ?').get(today) as { n: number }).n,
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
    summary: summary ?? null,
    updatedAt,
  }
}