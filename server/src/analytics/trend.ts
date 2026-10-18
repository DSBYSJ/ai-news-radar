import type { DatabaseSync } from 'node:sqlite'
import { CATEGORIES } from '../ai/categories.ts'

const DAY_MS = 86_400_000

/** ⚠️ 所有时间桶统一按 UTC 日期（与库内存储一致），展示层再转本地 */
function cutoffIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

export function dayRange(days: number): string[] {
  const now = new Date()
  const base = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  const out: string[] = []
  for (let i = days - 1; i >= 0; i--) out.push(new Date(base - i * DAY_MS).toISOString().slice(0, 10))
  return out
}

export interface DailyPoint {
  date: string
  value: number
}

/** 第 1 层 · 当日条数 —— ⚠️ 假趋势（源一变多数字就涨），只作基线对照 */
export function dailyVolume(db: DatabaseSync, days = 30): DailyPoint[] {
  const rows = db
    .prepare("SELECT date(published_at) AS d, COUNT(*) AS n FROM articles WHERE published_at >= ? GROUP BY d")
    .all(cutoffIso(days)) as { d: string; n: number }[]
  const map = new Map(rows.map((r) => [r.d, Number(r.n)]))
  return dayRange(days).map((d) => ({ date: d, value: map.get(d) ?? 0 }))
}

export interface CategoryRatioPoint {
  date: string
  total: number
  ratios: Record<string, number>
}

/** 第 2 层 · 分类占比 —— Y 轴用占比而非条数，才排除了「源数量变化」的干扰 */
export function categoryRatio(db: DatabaseSync, days = 30): CategoryRatioPoint[] {
  const rows = db
    .prepare(
      `SELECT date(published_at) AS d, category AS c, COUNT(*) AS n
       FROM articles WHERE published_at >= ? GROUP BY d, c`,
    )
    .all(cutoffIso(days)) as { d: string; c: string; n: number }[]

  const byDate = new Map<string, Map<string, number>>()
  for (const r of rows) {
    const m = byDate.get(r.d) ?? new Map<string, number>()
    m.set(r.c, Number(r.n))
    byDate.set(r.d, m)
  }

  return dayRange(days).map((d) => {
    const m = byDate.get(d) ?? new Map<string, number>()
    const total = [...m.values()].reduce((a, b) => a + b, 0)
    const ratios: Record<string, number> = {}
    for (const c of CATEGORIES) ratios[c] = total > 0 ? (m.get(c) ?? 0) / total : 0
    return { date: d, total, ratios }
  })
}

export interface VelocityPoint {
  date: string
  count: number
  ma7: number | null
}

export interface VelocityResult {
  points: VelocityPoint[]
  thisWeekAvg: number
  lastWeekAvg: number
  changePct: number | null
}

/** 第 3 层 · 斜率 —— 7 日移动平均 + 周环比（看出「在涨还是在跌」） */
export function velocity(db: DatabaseSync, days = 30): VelocityResult {
  const series = dailyVolume(db, days)
  const points: VelocityPoint[] = series.map((p, i) => {
    if (i < 6) return { date: p.date, count: p.value, ma7: null }
    let sum = 0
    for (let k = i - 6; k <= i; k++) sum += series[k].value
    return { date: p.date, count: p.value, ma7: Number((sum / 7).toFixed(2)) }
  })

  // ⚠️ 周环比要两周的数据。早先直接拿返回窗口算，窗口只有 7 天时
  // 「上一周」永远是空数组 → lastWeekAvg 恒为 0 → changePct 恒为 null，
  // 概览 KPI 与桌面小组件的环比一直是空的。这里多取 7 天专用于算基线，
  // 返回的点仍按调用方要的窗口（ma7 的 null 语义保持不变）。
  const extended = days >= 14 ? series : dailyVolume(db, 14)
  const avg = (from: number, to: number) => {
    const slice = extended.slice(from, to).map((p) => p.value)
    if (slice.length === 0) return 0
    return slice.reduce((a, b) => a + b, 0) / slice.length
  }

  const thisWeekAvg = Number(avg(Math.max(0, extended.length - 7), extended.length).toFixed(2))
  const lastWeekAvg = Number(avg(Math.max(0, extended.length - 14), Math.max(0, extended.length - 7)).toFixed(2))
  const changePct = lastWeekAvg > 0 ? Number((((thisWeekAvg - lastWeekAvg) / lastWeekAvg) * 100).toFixed(1)) : null

  return { points, thisWeekAvg, lastWeekAvg, changePct }
}

export interface CrossSourcePoint {
  date: string
  avgSources: number
  maxSources: number
  eventCount: number
}

export interface CrossSourceEvent {
  eventKey: string
  title: string
  category: string
  sourceCount: number
  articleCount: number
  date: string
  /** 全部来源名（来自 event_clusters.sources_list） */
  sources: string[]
}

export interface Burst {
  date: string
  category: string
  count: number
  baseline: number
  z: number
}

export interface CrossSourceResult {
  points: CrossSourcePoint[]
  topEvents: CrossSourceEvent[]
  /** 按日期分组的事件（供图表悬浮提示：标题 / 源列表 / 文章数） */
  dayEvents: Record<string, CrossSourceEvent[]>
  bursts: Burst[]
}

function parseSources(text: string | null): string[] {
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : []
  } catch {
    return []
  }
}

/**
 * 第 4 层 · 跨源交叉 + 突发 —— ★ 差异化核心
 * 数据源：event_clusters（聚类输出）与 burst_detection（突发输出），
 * 均由 analytics/events.ts、analytics/bursts.ts 在流水线中重建。
 */
export function crossSource(db: DatabaseSync, days = 30): CrossSourceResult {
  const cutoffDate = cutoffIso(days).slice(0, 10)
  const dates = dayRange(days)

  // 每日跨源指标（以事件为单位）
  const rows = db
    .prepare(
      `SELECT publish_date AS d,
              AVG(source_count)  AS avg_sources,
              MAX(source_count)  AS max_sources,
              COUNT(*)           AS event_count
       FROM event_clusters
       WHERE publish_date >= ?
       GROUP BY d`,
    )
    .all(cutoffDate) as { d: string; avg_sources: number; max_sources: number; event_count: number }[]

  const map = new Map(rows.map((r) => [r.d, r]))
  const points: CrossSourcePoint[] = dates.map((d) => {
    const r = map.get(d)
    return {
      date: d,
      avgSources: r ? Number(Number(r.avg_sources).toFixed(2)) : 0,
      maxSources: r ? Number(r.max_sources) : 0,
      eventCount: r ? Number(r.event_count) : 0,
    }
  })

  // 窗口内全部事件（含来源列表）：前 20 给列表，全量按日分组给悬浮提示
  const clusterRows = db
    .prepare(
      `SELECT event_id, representative_title, category, source_count, article_count, publish_date, sources_list
       FROM event_clusters
       WHERE publish_date >= ?
       ORDER BY source_count DESC, article_count DESC`,
    )
    .all(cutoffDate) as {
    event_id: string
    representative_title: string
    category: string
    source_count: number
    article_count: number
    publish_date: string
    sources_list: string | null
  }[]

  const allEvents: CrossSourceEvent[] = clusterRows.map((r) => ({
    eventKey: r.event_id,
    title: r.representative_title,
    category: r.category,
    sourceCount: Number(r.source_count),
    articleCount: Number(r.article_count),
    date: r.publish_date,
    sources: parseSources(r.sources_list),
  }))

  const topEvents = allEvents.slice(0, 20)
  const dayEvents: Record<string, CrossSourceEvent[]> = {}
  for (const e of allEvents) {
    ;(dayEvents[e.date] ??= []).push(e)
  }

  // 突发：直接读 burst_detection（rebuildBursts 写入；14 天滑动基线，z ≥ 2.5）
  const burstRows = db
    .prepare(
      `SELECT date, category, article_count, baseline_mean, z_score
       FROM burst_detection
       WHERE date >= ?
       ORDER BY z_score DESC
       LIMIT 50`,
    )
    .all(cutoffDate) as { date: string; category: string; article_count: number; baseline_mean: number; z_score: number }[]

  const bursts: Burst[] = burstRows.map((r) => ({
    date: r.date,
    category: r.category,
    count: Number(r.article_count),
    baseline: Number(r.baseline_mean),
    z: Number(r.z_score),
  }))

  return { points, topEvents, dayEvents, bursts }
}

/** 实体热度（mentions 表） */
export function topEntities(db: DatabaseSync, days = 30, limit = 15): { entity: string; count: number }[] {
  const rows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n
       FROM mentions m
       JOIN articles a ON a.id = m.article_id
       WHERE a.published_at >= ?
       GROUP BY m.entity
       ORDER BY n DESC
       LIMIT ?`,
    )
    .all(cutoffIso(days), limit) as { entity: string; n: number }[]
  return rows.map((r) => ({ entity: r.entity, count: Number(r.n) }))
}
