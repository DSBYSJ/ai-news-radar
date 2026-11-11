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
/**
 * 实体是否足以判定"同一事件"。
 * 见常量区注释：只用首篇实体、汇总贴不参与、交集需占较小集 40%。
 */
function canMergeByEntity(articleEntities: Set<string>, core: Set<string>): boolean {
  if (articleEntities.size < ENTITY_INTERSECTION || core.size < ENTITY_INTERSECTION) return false
  if (articleEntities.size > MAX_ENTITIES_FOR_MERGE || core.size > MAX_ENTITIES_FOR_MERGE) return false
  let inter = 0
  for (const e of articleEntities) if (core.has(e)) inter += 1
  if (inter < ENTITY_INTERSECTION) return false
  return inter / Math.min(articleEntities.size, core.size) >= ENTITY_RATIO
}

export const SIMILARITY_THRESHOLD = 0.75
const ENTITY_INTERSECTION = 2
/**
 * 实体合并的三个额外约束（v0.44.3，修「晨报把全站串成一个大簇」）
 *
 * 旧逻辑：拿「簇内实体并集」和文章实体比，交集 ≥2 就合并 → 一篇晨报（30+ 实体）
 * 合并进来后，簇的实体集变成"什么都沾"，后续任何提 OpenAI/ChatGPT 的文章都能并进来，
 * 滚雪球成几十篇不相关新闻（实测出现 34 篇：罗技鼠标 + 小米门锁 + 期货夜盘同簇）。
 *
 * 新规则：
 *   ① 只用「簇内首篇的实体」做匹配（不滚雪球）
 *   ② 任一方实体数 > 6 视为汇总贴，**不参与**实体合并（只能靠标题相似度）
 *   ③ 交集至少占较小实体集的 40%（2/30 这种"沾边"不算）
 */
const ENTITY_RATIO = 0.4
const MAX_ENTITIES_FOR_MERGE = 6
/**
 * 标题相似必须"双证据"（v0.44.3 实测）：
 *   中文短标题的 simhash 分布极扁 —— 完全无关的两条标题（"派早报：MiniMax 发布…"
 *   vs "宁德时代三季度净利润…"）也能拿到 **0.656**，随便一对就越过 0.75 的线，
 *   于是链式合并（A~B, B~C 但 A 与 C 无关）把一天的中文新闻串成一坨（实测 31 条同簇）。
 *
 * 规则：
 *   · simhash ≥ 0.92        → 几乎同题（同一篇的转载）
 *   · simhash ≥ 0.75 且 词重叠 ≥ 0.2 → 改写幅度合理的同一事件
 *   · 词重叠 ≥ 0.6          → 关键词高度重合（改写大但核心词一致）
 *   单独一个"0.75~0.9 的 simhash"不再足以合并。
 */
const SIMHASH_STRONG = 0.92
const TOKEN_SUPPORT = 0.2
const TOKEN_STRONG = 0.6
/** 单簇文章上限：真实事件在本语料里很少超过 12 篇；超过视为链式误合 */
const MAX_ARTICLES_PER_CLUSTER = 12
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
  /** 首篇的实体（用于匹配，不随合并增长） */
  core: Set<string>
  /** 全部成员的实体并集（仅统计用） */
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
      const sh = simhashSimilarity(hash, c.hash)
      const jac = jaccard(tokens, c.tokens)
      const titleMatch =
        sh >= SIMHASH_STRONG ||
        (sh >= SIMILARITY_THRESHOLD && jac >= TOKEN_SUPPORT) ||
        jac >= TOKEN_STRONG
      const roomy = c.articleIds.length < MAX_ARTICLES_PER_CLUSTER
      if (roomy && (titleMatch || canMergeByEntity(entities, c.core))) {
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
        core: new Set(entities),
        entities: new Set(entities),
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
    // 只维护"统计用"并集；匹配始终用 core（首篇实体），避免滚雪球
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
