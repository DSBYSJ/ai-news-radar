import type { DatabaseSync } from 'node:sqlite'
import { CATEGORIES, CATEGORY_LABELS, type Category } from '../ai/categories.ts'

/** 日报里的一条内容（文章 + 来源 + 跨源印证信息） */
export interface EditionItem {
  id: number
  title: string
  /** 一句话（第 1 级深度） */
  tldr: string | null
  /** 2~3 句中文摘要（第 3 级深度） */
  summary: string | null
  url: string
  category: string
  score: number | null
  sourceName: string
  /** 来源质量权重 1~3（1/2/3 分别对应当年媒体、准官方、官方一手） */
  sourceWeight: number
  publishedAt: string
  /** 事件聚类键（同日）；用于同一事件只出现一次 */
  eventKey: string | null
  /** 同一事件被几家独立源报道（跨源印证；1 = 只有一家） */
  sourceCount: number
  sources: string[]
}

export interface EditionSection {
  category: string
  label: string
  items: EditionItem[]
}

export interface Edition {
  date: string
  /** 头条：优先当天被最多独立源报道的事件 */
  headline: EditionItem | null
  sections: EditionSection[]
  /** 快讯：分数未过门槛的短条目，只有标题与来源 */
  flash: EditionItem[]
  /** 当天 AI 简报（作为日报导语；没有则为 null） */
  brief: { title: string; content: string; model: string; updatedAt: string } | null
  stats: { total: number; crossSource: number; byCategory: Record<string, number> }
}

/** 分区门槛：低于它不进分区，落到快讯（实测 41 条/天时 45 太严，只有 7 条过线） */
const SECTION_MIN_SCORE = 35
/** 每个分区最多几条 */
const PER_SECTION = 4
/** 快讯最多几条 */
const FLASH_LIMIT = 8

interface Row {
  id: number
  title: string
  tldr: string | null
  summary: string | null
  url: string
  category: string
  score: number | null
  event_key: string | null
  published_at: string
  source_name: string
  source_weight: number
  source_count: number | null
  sources_list: string | null
}

function safeList(text: string | null): string[] {
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : []
  } catch {
    return []
  }
}

/**
 * 结构化日报：把当天的文章编成「头条 + 分类分区 + 快讯」，前端按版面渲染。
 *
 * 与 AIHOT 的差异（见 docs/参考AIHOT的取舍.md）：
 * · 只在同日聚类（本项目事件簇按天分桶），不做跨天的后续进展归并
 * · 不做二次 LLM 归组复核（成本翻倍，个人项目不划算）
 * · 不产出公开页面（合规：个人主体不做面向公众的新闻服务）
 */
export function dailyEdition(db: DatabaseSync, date: string): Edition {
  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.tldr, a.summary, a.url, a.category, a.score, a.event_key, a.published_at,
              s.name AS source_name, COALESCE(s.weight, 1) AS source_weight,
              ec.source_count AS source_count, ec.sources_list AS sources_list
         FROM articles a
         JOIN raw_items r ON r.id = a.raw_id
         JOIN sources s ON s.id = r.source_id
         LEFT JOIN event_clusters ec
                ON ec.event_id = a.event_key AND ec.publish_date = date(a.published_at)
        WHERE date(a.published_at) = ? AND a.ai_relevant = 1
        ORDER BY COALESCE(a.score, 0) DESC, a.published_at DESC`,
    )
    .all(date) as unknown as Row[]

  const items: EditionItem[] = rows.map((r) => ({
    id: Number(r.id),
    title: r.title,
    tldr: r.tldr,
    summary: r.summary,
    url: r.url,
    category: r.category,
    score: r.score === null ? null : Number(r.score),
    sourceName: r.source_name,
    sourceWeight: Number(r.source_weight),
    publishedAt: r.published_at,
    eventKey: r.event_key ?? null,
    sourceCount: Number(r.source_count ?? 1),
    sources: safeList(r.sources_list),
  }))

  const byCategory: Record<string, number> = {}
  for (const it of items) byCategory[it.category] = (byCategory[it.category] ?? 0) + 1
  const crossSource = Number(
    (
      db
        .prepare(
        `SELECT COUNT(*) AS n FROM event_clusters ec
          WHERE ec.publish_date = ? AND ec.source_count >= 2
            AND EXISTS (SELECT 1 FROM articles a WHERE a.event_key = ec.event_id AND a.ai_relevant = 1)`,
      )
        .get(date) as { n: number }
    ).n,
  )

  const briefRow = db
    .prepare('SELECT title, content, model, updated_at FROM daily_summaries WHERE date = ?')
    .get(date) as { title: string; content: string; model: string; updated_at: string } | undefined

  // 头条：先看跨源事件（源数最多的），并列时取分数高的
  const crossCandidates = items.filter((it) => it.sourceCount >= 2)
  const pool = crossCandidates.length > 0 ? crossCandidates : items
  const headline =
    pool.length === 0
      ? null
      : pool.reduce((best, cur) => {
          const better =
            cur.sourceCount > best.sourceCount ||
            (cur.sourceCount === best.sourceCount && (cur.score ?? 0) > (best.score ?? 0))
          return better ? cur : best
        })

  // 同一事件只出现一次：头条占掉的事件，其其它报道也不再进分区/快讯
  const used = new Set<number>()
  const seenEvents = new Set<string>()
  const take = (it: EditionItem): void => {
    used.add(it.id)
    if (it.eventKey) seenEvents.add(it.eventKey)
  }
  if (headline) take(headline)

  const sections: EditionSection[] = []
  for (const category of CATEGORIES as readonly Category[]) {
    const bucket: EditionItem[] = []
    for (const it of items) {
      if (bucket.length >= PER_SECTION) break
      if (it.category !== category || used.has(it.id)) continue
      if ((it.score ?? 0) < SECTION_MIN_SCORE) continue
      if (it.eventKey && seenEvents.has(it.eventKey)) continue
      bucket.push(it)
      take(it)
    }
    if (bucket.length === 0) continue
    sections.push({ category, label: CATEGORY_LABELS[category], items: bucket })
  }

  const flash: EditionItem[] = []
  for (const it of items) {
    if (flash.length >= FLASH_LIMIT) break
    if (used.has(it.id) || (it.score ?? 0) >= SECTION_MIN_SCORE) continue
    if (it.eventKey && seenEvents.has(it.eventKey)) continue
    flash.push(it)
    take(it)
  }

  return {
    date,
    headline,
    sections,
    flash,
    brief: briefRow ? { title: briefRow.title, content: briefRow.content, model: briefRow.model, updatedAt: briefRow.updated_at } : null,
    stats: { total: items.length, crossSource, byCategory },
  }
}
