import type { DatabaseSync } from 'node:sqlite'
import { aggregateByCanonical } from '../entities/realign.ts'
import { entityKey } from '../entities/alias.ts'
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
export function dailyVolume(db: DatabaseSync, days = 30, category?: string): DailyPoint[] {
  const where = ['ai_relevant = 1', 'published_at >= ?']
  const params: (string | number)[] = [cutoffIso(days)]
  if (category) {
    where.push('category = ?')
    params.push(category)
  }
  const rows = db
    .prepare(
      `SELECT date(published_at) AS d, COUNT(*) AS n FROM articles WHERE ${where.join(' AND ')} GROUP BY d`,
    )
    .all(...params) as { d: string; n: number }[]
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
       FROM articles WHERE ai_relevant = 1 AND published_at >= ? GROUP BY d, c`,
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
  /** 两期都够数据才为 true；false 时 changePct 必为 null */
  comparable: boolean
  /** 不可比的原因（直接展示给用户），可比时为 null */
  note: string | null
  /** 两期各自有数据的天数 */
  thisWeekDays: number
  lastWeekDays: number
  /** 两期各自参与报道的源数量（变化则环比不可比） */
  thisWeekSources: number
  lastWeekSources: number
  points: VelocityPoint[]
  thisWeekAvg: number
  lastWeekAvg: number
  changePct: number | null
}

/** 第 3 层 · 斜率 —— 7 日移动平均 + 周环比（看出「在涨还是在跌」） */
export function velocity(db: DatabaseSync, days = 30, category?: string): VelocityResult {
  const series = dailyVolume(db, days, category)
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
  const extended = days >= 14 ? series : dailyVolume(db, 14, category)
  const avg = (from: number, to: number) => {
    const slice = extended.slice(from, to).map((p) => p.value)
    if (slice.length === 0) return 0
    return slice.reduce((a, b) => a + b, 0) / slice.length
  }

  const thisSlice = extended.slice(Math.max(0, extended.length - 7))
  const lastSlice = extended.slice(Math.max(0, extended.length - 14), Math.max(0, extended.length - 7))
  const thisWeekAvg = Number(avg(Math.max(0, extended.length - 7), extended.length).toFixed(2))
  const lastWeekAvg = Number(avg(Math.max(0, extended.length - 14), Math.max(0, extended.length - 7)).toFixed(2))
  const thisWeekDays = thisSlice.filter((p) => p.value > 0).length
  const lastWeekDays = lastSlice.filter((p) => p.value > 0).length

  /*
   * 可比性门槛：基期样本太少时，百分比会大得离谱（实测出现过 +1578%，
   * 原因是上一周只有 2 天有数据、日均不到 1 条）。这种数字比"暂无环比"更容易误导。
   * 规则：基期至少 4 天有数据，且基期日均 ≥ 5 条，才认为可比。
   */
  const MIN_DAYS = 4
  const MIN_AVG = 5

  // 两期参与报道的源数量：源集合一变（新增/停用），条数差异就主要来自"采集面"而不是"热度变化"
  const sourceCountOf = (slice: { date: string }[]): number => {
    if (slice.length === 0) return 0
    const from = slice[0].date
    const to = slice[slice.length - 1].date
    return Number(
      (
        db
          .prepare(
            `SELECT COUNT(DISTINCT r.source_id) AS n
               FROM articles a JOIN raw_items r ON r.id = a.raw_id
              WHERE a.ai_relevant = 1 AND date(a.published_at) BETWEEN ? AND ?`,
          )
          .get(from, to) as { n: number }
      ).n,
    )
  }
  const thisWeekSources = sourceCountOf(thisSlice)
  const lastWeekSources = sourceCountOf(lastSlice)
  const sourceSetChanged = thisWeekSources !== lastWeekSources

  const comparable = !sourceSetChanged && lastWeekDays >= MIN_DAYS && lastWeekAvg >= MIN_AVG
  const note = comparable
    ? null
    : sourceSetChanged
      ? `期间资讯源从 ${lastWeekSources} 个变为 ${thisWeekSources} 个，环比不可比`
      : lastWeekDays === 0
        ? '上一周没有数据，暂不比较'
        : lastWeekDays < MIN_DAYS
          ? `上一周只有 ${lastWeekDays} 天有数据，暂不比较`
          : `上一周日均仅 ${lastWeekAvg} 条，暂不比较`
  const changePct = comparable ? Number((((thisWeekAvg - lastWeekAvg) / lastWeekAvg) * 100).toFixed(1)) : null

  return {
    points,
    thisWeekAvg,
    lastWeekAvg,
    changePct,
    comparable,
    note,
    thisWeekDays,
    lastWeekDays,
    thisWeekSources,
    lastWeekSources,
  }
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
       FROM event_clusters ec
       WHERE ec.publish_date >= ?
         AND EXISTS (SELECT 1 FROM articles a WHERE a.event_key = ec.event_id AND a.ai_relevant = 1)
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
       FROM event_clusters ec
       WHERE ec.publish_date >= ?
         AND EXISTS (SELECT 1 FROM articles a WHERE a.event_key = ec.event_id AND a.ai_relevant = 1)
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

  /*
   * dayEvents 只服务"图表悬浮提示"，**不能把窗口内全部事件都塞进去**：
   * 30 天 × 每天上百个事件 × 每个事件的完整来源数组 = 396KB，
   * 这一个接口就占了概览首屏 98% 的传输量（安卓 WebView 上首屏明显慢）。
   * 每天只留来源数最高的 12 条，来源名最多 6 个（提示框也放不下更多）。
   */
  const MAX_PER_DAY = 12
  const MAX_SOURCES_IN_HINT = 6
  const dayEvents: Record<string, CrossSourceEvent[]> = {}
  for (const e of allEvents) {
    const list = (dayEvents[e.date] ??= [])
    if (list.length >= MAX_PER_DAY) continue
    list.push({ ...e, sources: e.sources.slice(0, MAX_SOURCES_IN_HINT) })
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
export function topEntities(
  db: DatabaseSync,
  days = 30,
  limit = 15,
  category?: string,
): { entity: string; count: number }[] {
  const where = ['a.ai_relevant = 1', 'a.published_at >= ?']
  const params: (string | number)[] = [cutoffIso(days)]
  if (category) {
    where.push('a.category = ?')
    params.push(category)
  }
  const rows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n
       FROM mentions m
       JOIN articles a ON a.id = m.article_id
       WHERE ${where.join(' AND ')}
       GROUP BY m.entity`,
    )
    .all(...params) as unknown as { entity: string; n: number }[]

  /*
   * 归并到"标准名"再排序截断：别名合并可能让排名后面的实体反超，
   * 所以先把窗口内所有原始行取回来再归并。mentions 里的原文不动。
   */
  const merged = aggregateByCanonical(db, rows, (r) => Number(r.n))
  return [...merged.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([entity, count]) => ({ entity, count }))
}

/** 多实体每日提及量（item 4：横向对比，最多 3 个实体） */
export function entityDailySeries(
  db: DatabaseSync,
  names: string[],
  days = 30,
): { dates: string[]; series: { name: string; values: number[] }[] } {
  const wanted = names.map((n) => n.trim()).filter(Boolean)
  if (wanted.length === 0) return { dates: dayRange(days), series: [] }
  const rows = db
    .prepare(
      `SELECT date(a.published_at) AS d, m.entity AS entity, COUNT(*) AS n
       FROM mentions m
       JOIN articles a ON a.id = m.article_id
       WHERE a.ai_relevant = 1 AND a.published_at >= ?
       GROUP BY d, m.entity`,
    )
    .all(cutoffIso(days)) as unknown as { d: string; entity: string; n: number }[]

  const perEntity = new Map<string, Map<string, number>>()
  for (const r of rows) {
    // 按 key 匹配请求的实体（兼容 "Open AI"/"OpenAI" 等不同写法）
    const matched = wanted.find((w) => entityKey(w) === entityKey(r.entity))
    if (!matched) continue
    const byDay = perEntity.get(matched) ?? new Map<string, number>()
    byDay.set(r.d, (byDay.get(r.d) ?? 0) + Number(r.n))
    perEntity.set(matched, byDay)
  }
  const dates = dayRange(days)
  return {
    dates,
    series: wanted.map((name) => ({
      name,
      values: dates.map((d) => perEntity.get(name)?.get(d) ?? 0),
    })),
  }
}
