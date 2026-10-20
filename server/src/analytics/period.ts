import type { DatabaseSync } from 'node:sqlite'
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../ai/categories.ts'

/**
 * 周报 / 月报汇编（v0.12.0）
 *
 * 与"日报"的区别：日报看**今天发生了什么**，周报看**这段时间在往哪走**。
 * 因此这里只做确定性统计（条数 / 分类结构 / 跨源事件 / 实体 / 突发），
 * 不调用大模型——文案由模板拼装，数字永远和库内一致，不会编。
 */

export type PeriodKind = 'week' | 'month'

export interface PeriodReport {
  kind: PeriodKind
  /** 展示用：周 "10-19 ~ 10-25"，月 "2026-10" */
  label: string
  /** UTC 日期，含头含尾 */
  start: string
  end: string
  /** 周期是否还没结束（本周只过了几天） */
  partial: boolean
  /** 已过天数（未结束时用于日均归一） */
  daysElapsed: number
  /** 环比不可信时的说明（上期样本太少） */
  deltaNote: string | null
  totals: {
    articles: number
    perDay: number
    crossEvents: number
    bursts: number
    /** 与上一周期相比的条数变化（%），上期为 0 时是 null */
    deltaPct: number | null
  }
  categories: { category: string; label: string; count: number; share: number }[]
  topEvents: { title: string; sourceCount: number; articleCount: number; category: string; date: string }[]
  topEntities: { name: string; count: number }[]
  bursts: { date: string; category: string; count: number; z: number }[]
  /** 模板拼装的要点句（不是 AI 生成，数字可追溯） */
  highlights: string[]
}

const DAY_MS = 86_400_000
const iso = (ms: number): string => new Date(ms).toISOString().slice(0, 10)

function shiftDays(dateIso: string, days: number): string {
  return iso(Date.parse(`${dateIso}T00:00:00Z`) + days * DAY_MS)
}

/** 周一为一周之始（UTC） */
export function weekStart(dateIso: string): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  const dow = d.getUTCDay() // 0=周日
  const back = dow === 0 ? 6 : dow - 1
  return shiftDays(dateIso, -back)
}

export function monthStart(dateIso: string): string {
  return `${dateIso.slice(0, 7)}-01`
}

export function monthEnd(dateIso: string): string {
  const [y, m] = dateIso.split('-').map(Number)
  return iso(Date.UTC(y, m, 0)) // 下月 0 号 = 本月最后一天
}

/** 周期起止（含头含尾） */
export function periodRange(kind: PeriodKind, anchorIso: string): { start: string; end: string; label: string } {
  const anchor = /^\d{4}-\d{2}-\d{2}$/.test(anchorIso) ? anchorIso : iso(Date.now())
  if (kind === 'month') {
    const start = monthStart(anchor)
    const end = monthEnd(anchor)
    return { start, end, label: start.slice(0, 7) }
  }
  const start = weekStart(anchor)
  const end = shiftDays(start, 6)
  return { start, end, label: `${start.slice(5)} ~ ${end.slice(5)}` }
}

export function periodReport(
  db: DatabaseSync,
  kind: PeriodKind,
  anchorIso: string,
  nowIso: string = iso(Date.now()),
): PeriodReport {
  const { start, end, label } = periodRange(kind, anchorIso)
  const spanDays = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1
  // 周期未结束时只统计"已过的天数"，否则拿 2 天和完整 7 天比，环比永远难看
  const partial = end >= nowIso
  const daysElapsed = partial
    ? Math.max(1, Math.round((Date.parse(`${nowIso}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / DAY_MS) + 1)
    : spanDays
  // 上期取「上周同期 / 上月同期」而不是紧邻的等长时段：
  // 周报拿"本周一~周二"对比"上周一~周二"才有可比性（拿周末两天比会失真）
  let prevStart: string
  let prevEnd: string
  if (kind === 'week') {
    prevStart = shiftDays(start, -7)
    prevEnd = shiftDays(prevStart, daysElapsed - 1)
  } else {
    const [y, m] = start.split('-').map(Number)
    const pmStartMs = Date.UTC(y, m - 2, 1)
    const pmEndMs = Date.UTC(y, m - 1, 0)
    prevStart = iso(pmStartMs)
    prevEnd = iso(Math.min(pmStartMs + (daysElapsed - 1) * DAY_MS, pmEndMs))
  }

  const countArticles = (a: string, b: string): number =>
    Number(
      (db.prepare('SELECT COUNT(*) AS n FROM articles WHERE date(published_at) BETWEEN ? AND ?').get(a, b) as { n: number }).n,
    )

  const articles = countArticles(start, partial ? nowIso : end)
  const prevArticles = countArticles(prevStart, prevEnd)
  const perDayRaw = articles / daysElapsed
  const prevPerDayRaw = prevArticles / daysElapsed
  const perDay = Number(perDayRaw.toFixed(1))
  // 用「日均」而不是总量：首采回填（如 OpenAI 全量归档 1,287 条）会把某期总量顶高，总量对比会失真
  // 环比必须用**未取整**的值算，否则 3/7 与 1/7 会算成 180% 而不是 200%
  const deltaPct =
    prevPerDayRaw > 0 ? Number((((perDayRaw - prevPerDayRaw) / prevPerDayRaw) * 100).toFixed(1)) : null
  // 上期样本太少时环比会算出几万%（本项目刚上线时就是这种情形），标出来别当趋势
  const deltaNote =
    prevArticles === 0 ? '上期无数据，暂不比较' : prevArticles < 30 ? `上期仅 ${prevArticles} 条，环比仅供参考` : null

  const crossEvents = Number(
    (
      db
        .prepare(
          'SELECT COUNT(*) AS n FROM event_clusters WHERE publish_date BETWEEN ? AND ? AND source_count >= 2',
        )
        .get(start, end) as { n: number }
    ).n,
  )

  const burstRows = db
    .prepare(
      'SELECT date, category, article_count AS count, z_score AS z FROM burst_detection WHERE date BETWEEN ? AND ? ORDER BY z_score DESC LIMIT 3',
    )
    .all(start, end) as unknown as { date: string; category: string; count: number; z: number }[]
  const bursts = burstRows.map((b) => ({
    date: b.date,
    category: b.category,
    count: Number(b.count),
    z: Number(Number(b.z).toFixed(2)),
  }))
  const burstCount = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM burst_detection WHERE date BETWEEN ? AND ?').get(start, end) as { n: number }).n,
  )

  const catRows = db
    .prepare('SELECT category, COUNT(*) AS n FROM articles WHERE date(published_at) BETWEEN ? AND ? GROUP BY category')
    .all(start, end) as unknown as { category: string; n: number }[]
  const catMap = new Map(catRows.map((r) => [r.category, Number(r.n)]))
  const categories = (CATEGORIES as readonly Category[])
    .map((c) => ({
      category: c,
      label: CATEGORY_LABELS[c],
      count: catMap.get(c) ?? 0,
      share: articles > 0 ? Number(((catMap.get(c) ?? 0) / articles).toFixed(3)) : 0,
    }))
    .filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count)

  const topEvents = (
    db
      .prepare(
        `SELECT representative_title AS title, source_count AS sourceCount, article_count AS articleCount,
                category, publish_date AS date
           FROM event_clusters
          WHERE publish_date BETWEEN ? AND ? AND source_count >= 2
          ORDER BY source_count DESC, article_count DESC LIMIT 5`,
      )
      .all(start, end) as unknown as { title: string; sourceCount: number; articleCount: number; category: string; date: string }[]
  ).map((e) => ({
    title: e.title,
    sourceCount: Number(e.sourceCount),
    articleCount: Number(e.articleCount),
    category: e.category,
    date: e.date,
  }))

  // 实体聚合：entities 是 JSON 数组，交给 JS 数（SQLite 的 JSON1 不一定可用）
  const entityRows = db
    .prepare('SELECT entities FROM articles WHERE date(published_at) BETWEEN ? AND ? AND entities IS NOT NULL')
    .all(start, end) as unknown as { entities: string }[]
  const entityCount = new Map<string, number>()
  for (const row of entityRows) {
    try {
      const list = JSON.parse(row.entities) as unknown
      if (!Array.isArray(list)) continue
      for (const name of list) {
        if (typeof name !== 'string' || !name.trim()) continue
        entityCount.set(name, (entityCount.get(name) ?? 0) + 1)
      }
    } catch {
      // 脏数据跳过，不影响整体
    }
  }
  const topEntities = [...entityCount.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 6)

  const highlights: string[] = []
  if (articles > 0) {
    const deltaText =
      deltaPct === null
        ? '上期无数据，暂不比较'
        : deltaNote
          ? `较上期同期${deltaPct >= 0 ? '上升' : '下降'} ${Math.abs(deltaPct)}%（${deltaNote}）`
          : `较上期同期${deltaPct >= 0 ? '上升' : '下降'} ${Math.abs(deltaPct)}%`
    const scopeText = partial ? `（本期进行中，已过 ${daysElapsed} 天）` : ''
    highlights.push(`共收录 ${articles} 条，日均 ${perDay} 条${scopeText}，${deltaText}。`)
    if (categories.length > 0) {
      const top = categories[0]
      highlights.push(`结构上以「${top.label}」为主（${top.count} 条，占 ${Math.round(top.share * 100)}%）。`)
    }
    if (crossEvents > 0 && topEvents.length > 0) {
      highlights.push(
        `出现 ${crossEvents} 个跨源事件，其中「${topEvents[0].title}」被 ${topEvents[0].sourceCount} 家独立源同时报道。`,
      )
    } else {
      highlights.push('本期没有跨源事件（同一事件未见多家独立源同时报道）。')
    }
    if (burstCount > 0 && bursts.length > 0) {
      highlights.push(`触发 ${burstCount} 次突发，最高一次在 ${bursts[0].date}（${bursts[0].category}，z=${bursts[0].z}）。`)
    }
    if (topEntities.length > 0) {
      highlights.push(`被提及最多：${topEntities.slice(0, 3).map((e) => `${e.name}（${e.count}）`).join('、')}。`)
    }
  } else {
    highlights.push('本期没有入库条目。')
  }

  return {
    kind,
    label,
    start,
    end,
    partial,
    daysElapsed,
    deltaNote,
    totals: { articles, perDay, crossEvents, bursts: burstCount, deltaPct },
    categories,
    topEvents,
    topEntities,
    bursts,
    highlights,
  }
}
