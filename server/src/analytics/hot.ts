import type { DatabaseSync } from 'node:sqlite'

/**
 * AI 热点榜（v0.17.0 重写）
 *
 * 与 AIHOT 的「事件级热度」对齐，修掉上一版的三处不合理：
 * 1. 衰减粒度：上一版按「天」算（当天 1.0、昨天 0.5），导致昨天 23:59 与今天 00:01 只差几分钟
 *    却差一倍权重。本版改为**连续小时衰减** 0.5^(ageHours/24)，任意两篇的权重都连续。
 * 2. 热度只数「独立来源」，不再把文章数计入热度：一家媒体连发 10 篇 ≠ 比 3 家各发 1 篇更热。
 *    文章数只用于同分时的排序与展示。
 * 3. 候选窗口按 `published_at >= now-48h` 精确取，不再取整到「今天 + 昨天」。
 *
 * 公式：hot = round( Σ over 独立来源 10 × 0.5^(该来源最新一篇的年龄小时 / 24) )，年龄截断到 48h。
 * 含义：一个 48 小时内持续被 N 家独立源报道的事件，热度≈10N，且越新越靠前。
 */

export interface HotItem {
  rank: number
  title: string
  category: string
  eventKeys: string[]
  /** 独立来源数（48h 内仍被报道的） */
  sources: number
  articles: number
  hot: number
  /** 近 6 小时文章数 */
  recent: number
  deltaPct: number | null
  isNew: boolean
  firstSeen: string
  lastSeen: string
  hourly: number[]
  related: { id: number; title: string; url: string; sourceName: string }[]
  topArticle: { id: number; title: string; url: string; sourceName: string; publishedAt: string; tldr: string | null; summary: string | null } | null
}

const HOUR_MS = 3_600_000
const WINDOW_HOURS = 48

function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、：；！？·—–\-""''（）()【】[\]<>《》:;,.!?"']/g, '')
}

function decay(hours: number): number {
  return Math.pow(0.5, Math.min(Math.max(hours, 0), WINDOW_HOURS) / 24)
}

interface ArticleRow {
  id: number
  event_key: string
  title: string
  category: string
  score: number | null
  published_at: string
  source_id: string
  source_name: string
  url: string
  tldr: string | null
  summary: string | null
}

interface Group {
  keys: Set<string>
  articles: ArticleRow[]
}

export function hotRanking(db: DatabaseSync, opts: { hours?: number; limit?: number; now?: number } = {}): HotItem[] {
  const hours = Math.max(6, Math.min(168, opts.hours ?? 48))
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10))
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - hours * HOUR_MS).toISOString()

  const rows = db
    .prepare(
      `SELECT a.id, a.event_key, a.title, a.category, a.score, a.published_at,
              r.source_id, s.name AS source_name, a.url, a.tldr, a.summary
         FROM articles a
         JOIN raw_items r ON r.id = a.raw_id
         JOIN sources s ON s.id = r.source_id
        WHERE a.event_key IS NOT NULL AND a.ai_relevant = 1 AND a.published_at >= ?
        ORDER BY a.published_at DESC`,
    )
    .all(cutoff) as unknown as ArticleRow[]

  // 按 event_key 分组，再按「标题归一化后相等」跨天合并（事件键按天分桶）
  const byKey = new Map<string, Group>()
  for (const row of rows) {
    const g = byKey.get(row.event_key)
    if (g) g.articles.push(row)
    else byKey.set(row.event_key, { keys: new Set([row.event_key]), articles: [row] })
  }

  const merged = new Map<string, Group>()
  for (const g of byKey.values()) {
    const first = g.articles[0]
    const nk = normTitle(first.title)
    if (!nk) continue
    const m = merged.get(nk)
    if (m) {
      for (const k of g.keys) m.keys.add(k)
      m.articles.push(...g.articles)
    } else {
      merged.set(nk, g)
    }
  }

  const items: HotItem[] = []
  for (const g of merged.values()) {
    const sorted = [...g.articles].sort(
      (a, b) => (b.score ?? 0) - (a.score ?? 0) || a.published_at.localeCompare(b.published_at),
    )
    const top = sorted[0]
    const firstSeen = sorted.reduce((min, a) => (a.published_at < min ? a.published_at : min), sorted[0].published_at)
    const lastSeen = sorted.reduce((max, a) => (a.published_at > max ? a.published_at : max), sorted[0].published_at)

    // 每个独立来源取「最新一篇」的年龄做衰减，求和；文章数不进热度
    const latestBySource = new Map<string, number>()
    for (const a of sorted) {
      const t = Date.parse(a.published_at)
      const cur = latestBySource.get(a.source_id)
      if (cur === undefined || t > cur) latestBySource.set(a.source_id, t)
    }
    let hotSum = 0
    for (const t of latestBySource.values()) {
      hotSum += decay((now - t) / HOUR_MS)
    }
    const hot = Math.round(hotSum * 10)

    // 动量：近 6 小时 vs 前 6 小时
    const recentCut = now - 6 * HOUR_MS
    const prevCut = now - 12 * HOUR_MS
    const recent = sorted.filter((a) => Date.parse(a.published_at) >= recentCut).length
    const prevRecent = sorted.filter((a) => {
      const t = Date.parse(a.published_at)
      return t >= prevCut && t < recentCut
    }).length
    const deltaPct =
      prevRecent > 0 ? Number((((recent - prevRecent) / prevRecent) * 100).toFixed(0)) : recent > 0 ? null : 0

    // 24 小时走势（旧 → 新）
    const hourly = new Array<number>(24).fill(0)
    const dayCut = now - 24 * HOUR_MS
    for (const a of sorted) {
      const idx = Math.floor((now - Date.parse(a.published_at)) / HOUR_MS)
      if (idx >= 0 && idx < 24) hourly[23 - idx] += 1
    }

    const topArticle = {
      id: Number(top.id),
      title: top.title,
      url: top.url,
      sourceName: top.source_name,
      publishedAt: top.published_at,
      tldr: top.tldr,
      summary: top.summary,
    }

    items.push({
      rank: 0,
      title: top.title,
      category: top.category,
      eventKeys: [...g.keys],
      sources: latestBySource.size,
      articles: sorted.length,
      hot,
      recent,
      deltaPct,
      isNew: Date.parse(firstSeen) >= now - 6 * HOUR_MS,
      firstSeen,
      lastSeen,
      hourly,
      related: [],
      topArticle,
    })
  }

  items.sort((a, b) => b.hot - a.hot || b.sources - a.sources || b.articles - a.articles)
  const top = items.slice(0, limit).map((it, i) => ({ ...it, rank: i + 1 }))

  // 只给前 3 名补「相关报道」：同一事件（含跨天合并的所有键）的其它文章
  const relatedStmt = db.prepare(
    `SELECT a.id, a.title, a.url, s.name AS sourceName
       FROM articles a JOIN raw_items r ON r.id = a.raw_id JOIN sources s ON s.id = r.source_id
      WHERE a.event_key = ? AND a.id != ? AND a.ai_relevant = 1
      ORDER BY COALESCE(a.score, 0) DESC, a.published_at DESC LIMIT 3`,
  )
  for (const it of top.slice(0, 3)) {
    if (!it.topArticle) continue
    const seen = new Set<number>([it.topArticle.id])
    const related: HotItem['related'] = []
    for (const k of it.eventKeys) {
      const rs = relatedStmt.all(k, it.topArticle.id) as unknown as { id: number; title: string; url: string; sourceName: string }[]
      for (const r of rs) {
        if (seen.has(Number(r.id)) || r.title === it.topArticle.title) continue
        seen.add(Number(r.id))
        related.push({ id: Number(r.id), title: r.title, url: r.url, sourceName: r.sourceName })
        if (related.length >= 3) break
      }
      if (related.length >= 3) break
    }
    it.related = related
  }

  return top
}
