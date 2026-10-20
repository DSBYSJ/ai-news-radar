import type { DatabaseSync } from 'node:sqlite'

/**
 * AI 热点榜（v0.14.0）
 *
 * 口径参考 AIHOT 的「事件级热度」，但适配本项目的数据结构：
 * · 候选：最近 48 小时内的 event_clusters（本项目事件键**按天分桶**，所以取今天+昨天）
 * · 合并：同一天已由聚类合并；跨天的同一件事按「代表标题归一化后相等」再合一次
 *   （措辞不同的跨天跟进会分成两条 —— 这是按天分桶的已知代价，写清楚而不是假装没有）
 * · 热度：Σ 每天 (独立源数 × 3 + 文章数) × 时间衰减（当天 1.0，前一天 0.5，对齐"24 小时减半"）
 * · 动量：近 6 小时的文章数 vs 前 6 小时，用来标「上升 / 下降 / 持平」；首次出现在 6 小时内标「新」
 */

export interface HotItem {
  rank: number
  title: string
  category: string
  /** 涉及的事件键（同日，可能跨两天） */
  eventKeys: string[]
  /** 独立来源数（两天里取最大值，避免重复计数） */
  sources: number
  /** 文章总数（两天累加） */
  articles: number
  /** 热度指数（整数，越大越热） */
  hot: number
  /** 近 6 小时文章数 */
  recent: number
  /** 相对前 6 小时的变化（%）；前 6 小时为 0 时是 null */
  deltaPct: number | null
  /** 6 小时内首次出现 */
  isNew: boolean
  firstSeen: string
  lastSeen: string
  /** 近 24 小时每小时的文章数（旧 → 新），给迷你走势图用 */
  hourly: number[]
  /** 同一事件的其它报道（最多 3 条，用于大卡的「相关报道」） */
  related: { id: number; title: string; url: string; sourceName: string }[]
  /** 代表条目（用于站内阅读/原文/摘要） */
  topArticle: { id: number; title: string; url: string; sourceName: string; publishedAt: string; tldr: string | null; summary: string | null } | null
}

const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

function normTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[，。、：；！？·—–\-""''（）()【】[\]<>《》:;,.!?"']/g, '')
}

interface ClusterRow {
  event_id: string
  publish_date: string
  representative_title: string
  source_count: number
  article_count: number
  category: string
  first_seen: string
  last_seen: string
}

export function hotRanking(db: DatabaseSync, opts: { hours?: number; limit?: number; now?: number } = {}): HotItem[] {
  const hours = Math.max(6, Math.min(168, opts.hours ?? 48))
  const limit = Math.max(1, Math.min(50, opts.limit ?? 10))
  const now = opts.now ?? Date.now()
  const todayIso = new Date(now).toISOString().slice(0, 10)
  const fromDate = new Date(now - (hours - 24) * HOUR_MS).toISOString().slice(0, 10)

  const clusters = db
    .prepare(
      `SELECT event_id, publish_date, representative_title, source_count, article_count, category, first_seen, last_seen
         FROM event_clusters
        WHERE publish_date BETWEEN ? AND ?
        ORDER BY publish_date DESC`,
    )
    .all(fromDate, todayIso) as unknown as ClusterRow[]

  // 跨天合并：标题归一化后相同即视为同一件事
  const groups = new Map<string, { keys: string[]; title: string; category: string; sources: number; articles: number; hot: number; firstSeen: string; lastSeen: string }>()
  for (const c of clusters) {
    const key = normTitle(c.representative_title)
    if (!key) continue
    const ageDays = (Date.parse(`${todayIso}T00:00:00Z`) - Date.parse(`${c.publish_date}T00:00:00Z`)) / DAY_MS
    const decay = ageDays <= 0 ? 1 : Math.pow(0.5, ageDays)
    const contribution = (Number(c.source_count) * 3 + Number(c.article_count)) * decay
    const g = groups.get(key)
    if (g) {
      g.keys.push(c.event_id)
      g.sources = Math.max(g.sources, Number(c.source_count))
      g.articles += Number(c.article_count)
      g.hot += contribution
      if (c.first_seen < g.firstSeen) g.firstSeen = c.first_seen
      if (c.last_seen > g.lastSeen) g.lastSeen = c.last_seen
    } else {
      groups.set(key, {
        keys: [c.event_id],
        title: c.representative_title,
        category: c.category,
        sources: Number(c.source_count),
        articles: Number(c.article_count),
        hot: contribution,
        firstSeen: c.first_seen,
        lastSeen: c.last_seen,
      })
    }
  }

  const recentCut = new Date(now - 6 * HOUR_MS).toISOString()
  const prevCut = new Date(now - 12 * HOUR_MS).toISOString()
  const countArticles = db.prepare(
    'SELECT COUNT(*) AS n FROM articles WHERE event_key = ? AND published_at >= ? AND published_at < ?',
  )
  const timesOf = db.prepare('SELECT published_at FROM articles WHERE event_key = ? AND published_at >= ? ORDER BY published_at')
  const relatedOf = db.prepare(
    `SELECT a.id, a.title, a.url, s.name AS sourceName
       FROM articles a JOIN raw_items r ON r.id = a.raw_id JOIN sources s ON s.id = r.source_id
      WHERE a.event_key = ? AND a.id != ?
      ORDER BY COALESCE(a.score, 0) DESC, a.published_at DESC LIMIT 3`,
  )
  const topOf = db.prepare(
    `SELECT a.id, a.title, a.url, a.published_at AS publishedAt, s.name AS sourceName, a.tldr, a.summary
       FROM articles a JOIN raw_items r ON r.id = a.raw_id JOIN sources s ON s.id = r.source_id
      WHERE a.event_key = ?
      ORDER BY COALESCE(a.score, 0) DESC, a.published_at DESC LIMIT 1`,
  )

  const items: HotItem[] = []
  for (const g of groups.values()) {
    let recent = 0
    let prevRecent = 0
    for (const k of g.keys) {
      recent += Number((countArticles.get(k, recentCut, new Date(now).toISOString()) as { n: number }).n)
      prevRecent += Number((countArticles.get(k, prevCut, recentCut) as { n: number }).n)
    }
    // 动量：近 6 小时 vs 前 6 小时；两边都没新增就算持平
    const deltaPct =
      prevRecent > 0
        ? Number((((recent - prevRecent) / prevRecent) * 100).toFixed(0))
        : recent > 0
          ? null
          : 0
    let topArticle: HotItem['topArticle'] = null
    for (const k of g.keys) {
      const row = topOf.get(k) as HotItem['topArticle'] | undefined
      if (row && (!topArticle || (row.publishedAt ?? '') > (topArticle.publishedAt ?? ''))) topArticle = row
    }
    // 近 24 小时逐小时计数（24 个桶，最旧在前）
    const hourly = new Array<number>(24).fill(0)
    const dayCut = new Date(now - 24 * HOUR_MS).toISOString()
    for (const k of g.keys) {
      for (const row of timesOf.all(k, dayCut) as unknown as { published_at: string }[]) {
        const idx = Math.floor((now - Date.parse(row.published_at)) / HOUR_MS)
        if (idx >= 0 && idx < 24) hourly[23 - idx] += 1
      }
    }

    items.push({
      rank: 0,
      hourly,
      title: g.title,
      category: g.category,
      eventKeys: g.keys,
      sources: g.sources,
      articles: g.articles,
      hot: Math.round(g.hot * 10),
      recent,
      deltaPct,
      isNew: Date.parse(g.firstSeen) >= now - 6 * HOUR_MS,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      topArticle: topArticle ?? null,
      related: [],
    })
  }

  items.sort((a, b) => b.hot - a.hot || b.sources - a.sources)
  const top = items.slice(0, limit).map((it, i) => ({ ...it, rank: i + 1 }))

  // 只给前 3 名补「相关报道」（大卡里展示），避免为 10 条都查一遍
  for (const it of top.slice(0, 3)) {
    if (!it.topArticle) continue
    const rows = relatedOf.all(it.eventKeys[0], it.topArticle.id) as unknown as {
      id: number
      title: string
      url: string
      sourceName: string
    }[]
    it.related = rows
      .filter((r) => r.title !== it.topArticle?.title)
      .map((r) => ({ id: Number(r.id), title: r.title, url: r.url, sourceName: r.sourceName }))
  }
  return top
}
