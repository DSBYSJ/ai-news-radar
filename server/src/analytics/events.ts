import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { simhash64, simhashSimilarity } from './simhash.ts'
import { jaccard, textTokens } from './tokens.ts'

/**
 * 事件聚类（跨源交叉度）—— 优化后口径：
 *
 *  1. 只对「同一天」（UTC）的文章做聚类（降低跨天误合并）；
 *  2. 文本相似度 = max(SimHash 相似度, token Jaccard)，对「标题 + 摘要（或 TL;DR）」计算；
 *     相似度 ≥ 0.75 视为同一事件（阈值见 SIMILARITY_THRESHOLD）；
 *  3. 辅助信号：实体交集 ≥ 2 也并入同一事件（改写幅度大 / 跨语言的场景）；
 *  4. 统计组内「独立源数量 source_count」与「文章总数 article_count」，
 *     输出到 event_clusters 表；同时兼容写入旧 events 表（既有接口继续可用）。
 */
export const SIMILARITY_THRESHOLD = 0.75
const ENTITY_INTERSECTION = 2
const DAY_MS = 86_400_000

interface ArticleRow {
  id: number
  title: string
  summary: string | null
  tldr: string | null
  category: string
  published_at: string
  source_id: string
  source_name: string
  entities: string | null
}

interface Cluster {
  key: string
  date: string
  tokens: Set<string>
  hash: bigint
  entities: Set<string>
  articleIds: number[]
  sources: Set<string>
  firstSeen: string
  lastSeen: string
  titleRepr: string
  category: string
}

export interface RebuildSummary {
  scanned: number
  events: number
  crossSourceEvents: number
  multiArticleEvents: number
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

function parseEntities(text: string | null): Set<string> {
  if (!text) return new Set()
  try {
    const parsed = JSON.parse(text) as unknown
    return new Set(Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : [])
  } catch {
    return new Set()
  }
}

export async function rebuildEvents(opts: { db?: DatabaseSync; days?: number } = {}): Promise<RebuildSummary> {
  const db = opts.db ?? (await import('../db.ts')).getDb()
  const days = opts.days ?? 90
  const cutoff = new Date(Date.now() - days * DAY_MS).toISOString()
  const cutoffDate = cutoff.slice(0, 10)

  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.summary, a.tldr, a.category, a.published_at,
              r.source_id AS source_id, s.name AS source_name, a.entities
       FROM articles a
       JOIN raw_items r ON r.id = a.raw_id
       JOIN sources s ON s.id = r.source_id
       WHERE a.published_at >= ?
       ORDER BY a.published_at ASC`,
    )
    .all(cutoff) as unknown as ArticleRow[]

  // 按日期分桶（同一天内比较）
  const byDate = new Map<string, Cluster[]>()
  const allClusters: Cluster[] = []

  for (const row of rows) {
    const date = row.published_at.slice(0, 10)
    const summaryText = row.tldr ?? row.summary ?? ''
    const tokens = new Set(textTokens(`${row.title} ${summaryText}`))
    const hash = simhash64(row.title, summaryText)
    const entities = parseEntities(row.entities)

    const bucket = byDate.get(date) ?? []
    let target: Cluster | undefined
    for (const c of bucket) {
      const similarity = Math.max(simhashSimilarity(hash, c.hash), jaccard(tokens, c.tokens))
      const entityInter = [...entities].filter((e) => c.entities.has(e)).length
      if (similarity >= SIMILARITY_THRESHOLD || entityInter >= ENTITY_INTERSECTION) {
        target = c
        break
      }
    }

    if (!target) {
      target = {
        key: `evt_${sha1(`${date}|${[...tokens].sort().join(' ') || row.title}`).slice(0, 16)}`,
        date,
        tokens,
        hash,
        entities,
        articleIds: [],
        sources: new Set(),
        firstSeen: row.published_at,
        lastSeen: row.published_at,
        titleRepr: row.title,
        category: row.category,
      }
      bucket.push(target)
      byDate.set(date, bucket)
      allClusters.push(target)
    }

    target.articleIds.push(row.id)
    target.sources.add(row.source_name)
    for (const e of entities) target.entities.add(e)
    if (row.published_at < target.firstSeen) target.firstSeen = row.published_at
    if (row.published_at > target.lastSeen) target.lastSeen = row.published_at
  }

  // 重建语义：先清窗口内旧结果（避免残留过期事件），再写入
  db.prepare('DELETE FROM events WHERE date(first_seen) >= ?').run(cutoffDate)
  db.prepare('DELETE FROM event_clusters WHERE publish_date >= ?').run(cutoffDate)

  const upsertEvent = db.prepare(
    `INSERT INTO events (event_key, first_seen, last_seen, source_count, article_count, title_repr, category)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_key) DO UPDATE SET
       first_seen = excluded.first_seen, last_seen = excluded.last_seen,
       source_count = excluded.source_count, article_count = excluded.article_count,
       title_repr = excluded.title_repr, category = excluded.category`,
  )
  const upsertCluster = db.prepare(
    `INSERT INTO event_clusters (event_id, publish_date, representative_title, source_count, article_count, sources_list, category, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(event_id) DO UPDATE SET
       publish_date = excluded.publish_date, representative_title = excluded.representative_title,
       source_count = excluded.source_count, article_count = excluded.article_count,
       sources_list = excluded.sources_list, category = excluded.category,
       first_seen = excluded.first_seen, last_seen = excluded.last_seen`,
  )
  const linkArticle = db.prepare('UPDATE articles SET event_key = ? WHERE id = ?')

  let crossSourceEvents = 0
  let multiArticleEvents = 0

  for (const c of allClusters) {
    const sourcesList = [...c.sources].sort()

    upsertEvent.run(c.key, c.firstSeen, c.lastSeen, c.sources.size, c.articleIds.length, c.titleRepr.slice(0, 300), c.category)
    upsertCluster.run(
      c.key,
      c.date,
      c.titleRepr.slice(0, 300),
      c.sources.size,
      c.articleIds.length,
      JSON.stringify(sourcesList),
      c.category,
      c.firstSeen,
      c.lastSeen,
    )
    for (const id of c.articleIds) linkArticle.run(c.key, id)

    if (c.sources.size >= 2) crossSourceEvents += 1
    if (c.articleIds.length >= 2) multiArticleEvents += 1
  }

  return {
    scanned: rows.length,
    events: allClusters.length,
    crossSourceEvents,
    multiArticleEvents,
  }
}
