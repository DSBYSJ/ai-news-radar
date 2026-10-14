import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { CATEGORY_LABELS, type Category } from './categories.ts'
import { chat } from './deepseek.ts'
import { extractJson } from './parse.ts'

const DAY_MS = 86_400_000

export interface SummaryHighlight {
  title: string
  url: string
  sourceName: string
  category: string
  categoryLabel: string
  sourceCount: number | null
  score: number | null
}

export interface DailyStats {
  total: number
  byCategory: Record<string, number>
  crossSource: number
  prevTotal: number
  deltaPct: number | null
  topSources: { name: string; count: number }[]
}

interface ArticleRow {
  id: number
  title: string
  tldr: string | null
  summary: string | null
  url: string
  category: string
  score: number | null
  sourceName: string
  sourceCount: number | null
}

export interface DailySummaryRow {
  date: string
  title: string
  content: string
  highlights: SummaryHighlight[]
  stats: DailyStats | null
  model: string
  created_at: string
  updated_at: string
}

export interface ParsedSummary {
  title: string
  overview: string
  sections: { heading: string; points: string[] }[]
  watch: string
}

export function prevDate(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10)
}

export function yesterdayUtc(): string {
  return new Date(Date.now() - DAY_MS).toISOString().slice(0, 10)
}

function label(category: string): string {
  return CATEGORY_LABELS[category as Category] ?? category
}

function safeParse<T>(text: unknown, fallback: T): T {
  if (typeof text !== 'string') return fallback
  try {
    return JSON.parse(text) as T
  } catch {
    return fallback
  }
}

function loadDayArticles(db: DatabaseSync, date: string): ArticleRow[] {
  return db
    .prepare(
      `SELECT a.id, a.title, a.tldr, a.summary, a.url, a.category, a.score,
              s.name AS sourceName, e.source_count AS sourceCount
       FROM articles a
       JOIN raw_items r ON r.id = a.raw_id
       JOIN sources s ON s.id = r.source_id
       LEFT JOIN events e ON e.event_key = a.event_key
       WHERE date(a.published_at) = ?
       ORDER BY COALESCE(e.source_count, 0) DESC, COALESCE(a.score, 0) DESC
       LIMIT 80`,
    )
    .all(date) as unknown as ArticleRow[]
}

export function collectStats(db: DatabaseSync, date: string, total: number): DailyStats {
  const byCategory: Record<string, number> = {}
  for (const row of db
    .prepare('SELECT category, COUNT(*) AS n FROM articles WHERE date(published_at) = ? GROUP BY category')
    .all(date) as unknown as { category: string; n: number }[]) {
    byCategory[row.category] = Number(row.n)
  }

  const crossSource = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM articles a JOIN events e ON e.event_key = a.event_key
           WHERE date(a.published_at) = ? AND e.source_count >= 2`,
        )
        .get(date) as unknown as { n: number }
    ).n,
  )

  const prevTotal = Number(
    (db.prepare('SELECT COUNT(*) AS n FROM articles WHERE date(published_at) = ?').get(prevDate(date)) as unknown as { n: number }).n,
  )
  const deltaPct = prevTotal > 0 ? Number((((total - prevTotal) / prevTotal) * 100).toFixed(1)) : null

  const topSources = (
    db
      .prepare(
        `SELECT s.name AS name, COUNT(*) AS n FROM articles a
         JOIN raw_items r ON r.id = a.raw_id JOIN sources s ON s.id = r.source_id
         WHERE date(a.published_at) = ? GROUP BY s.id ORDER BY n DESC LIMIT 5`,
      )
      .all(date) as unknown as { name: string; n: number }[]
  ).map((r) => ({ name: r.name, count: Number(r.n) }))

  return { total, byCategory, crossSource, prevTotal, deltaPct, topSources }
}

export function buildDailyPrompt(date: string, articles: ArticleRow[], stats: DailyStats): string {
  const lines = articles
    .slice(0, 60)
    .map((a) => {
      const tags = `[${label(a.category)}][${a.score ?? '-'}分]${a.sourceCount && a.sourceCount >= 2 ? `[${a.sourceCount}源]` : ''}`
      const text = (a.tldr || a.summary || '').replace(/\s+/g, ' ').slice(0, 120)
      return `${tags} ${a.title}${text ? ` —— ${text}` : ''}`
    })
    .join('\n')

  const dist = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${label(c)} ${n}`)
    .join('、')

  const delta =
    stats.deltaPct === null ? '无对比' : `${stats.deltaPct >= 0 ? '+' : ''}${stats.deltaPct}%（前一日 ${stats.prevTotal} 条）`

  return `你是 AI 行业分析师。请为 ${date}（UTC）写一份中文每日简报。

【当日数据】共收录 ${stats.total} 条；分类分布：${dist || '无'}；多源交叉报道 ${stats.crossSource} 条；条数较前一日 ${delta}

【要求】
1. 只输出 JSON，不要 Markdown 代码块，不要任何解释；
2. 内容具体、保留数字（金额/版本号/百分比），不写"据悉""值得注意"这类空话；
3. 带 [N源] 标记的（多家独立源报道）和重要度高的条目优先；
4. 全部用中文；正文不要出现 # * \` 等 Markdown 标记。

【输出格式】
{"title":"一句话主题（20字内，概括当天最重要的动向）","overview":"3~5 句综述，说清当天最值得知道的事","sections":[{"heading":"分类或主题","points":["要点1","要点2"]}],"watch":"一句话：值得持续关注的方向或潜在信号"}

【当日条目】
${lines}`
}

export function parseSummaryResult(raw: string): ParsedSummary | null {
  const data = extractJson<Record<string, unknown>>(raw)
  if (!data || typeof data !== 'object') return null

  const title = typeof data.title === 'string' ? data.title.trim().slice(0, 60) : ''
  const overview = typeof data.overview === 'string' ? data.overview.trim().slice(0, 1200) : ''
  const watch = typeof data.watch === 'string' ? data.watch.trim().slice(0, 300) : ''

  const sections = Array.isArray(data.sections)
    ? data.sections
        .filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null)
        .map((s) => ({
          heading: typeof s.heading === 'string' ? s.heading.trim().slice(0, 40) : '',
          points: Array.isArray(s.points)
            ? s.points
                .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
                .map((p) => p.trim().slice(0, 300))
                .slice(0, 8)
            : [],
        }))
        .filter((s) => s.heading && s.points.length > 0)
        .slice(0, 8)
    : []

  if (!title && !overview) return null
  return { title: title || '（无标题）', overview, sections, watch }
}

export function renderSummaryContent(parsed: ParsedSummary): string {
  const parts: string[] = []
  if (parsed.overview) parts.push(parsed.overview)
  for (const s of parsed.sections) {
    parts.push('', `■ ${s.heading}`)
    for (const p of s.points) parts.push(`· ${p}`)
  }
  if (parsed.watch) parts.push('', `【关注】${parsed.watch}`)
  return parts.join('\n').trim()
}

/** AI 不可用时的统计兜底版（绝不因为 AI 失败就缺一天的简报） */
export function statisticalSummary(date: string, articles: ArticleRow[], stats: DailyStats): ParsedSummary {
  const dist = Object.entries(stats.byCategory)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${label(c)} ${n} 条`)
    .join('、')
  const delta = stats.deltaPct === null ? '' : `，较前一日${stats.deltaPct >= 0 ? '+' : ''}${stats.deltaPct}%`

  const overview =
    `${date} 共收录 ${stats.total} 条${delta}。` +
    (dist ? `分布以 ${dist} 为主。` : '') +
    (stats.crossSource > 0 ? `其中 ${stats.crossSource} 条属于多源交叉报道。` : '') +
    '（AI 摘要暂不可用，本条为统计版）'

  const byCat = new Map<string, string[]>()
  for (const a of articles) {
    const key = label(a.category)
    const arr = byCat.get(key) ?? []
    if (arr.length < 5) arr.push(a.title)
    byCat.set(key, arr)
  }

  return {
    title: `收录 ${stats.total} 条 · 多源事件 ${stats.crossSource} 条`,
    overview,
    sections: [...byCat.entries()].map(([heading, points]) => ({ heading, points })),
    watch: '',
  }
}

export interface GenerateOptions {
  date: string
  force?: boolean
  useAi?: boolean
  db?: DatabaseSync
}

export interface GenerateResult {
  ok: boolean
  date: string
  skipped: boolean
  model: string
  reason?: string
}

/**
 * 生成某一天的简报（幂等）：
 * - 已存在则跳过；但若已有的是"统计版"而现在 AI 可用 → 升级重生成
 * - 当天没有条目 → 跳过（不算失败）
 * - AI 失败 → 统计兜底版（model = 'statistical'），绝不留空
 */
export async function generateDailySummary(opts: GenerateOptions): Promise<GenerateResult> {
  const db = opts.db ?? (await import('../db.ts')).getDb()
  const date = opts.date
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`日期格式应为 YYYY-MM-DD，收到：${date}`)

  const useAi = opts.useAi ?? config.aiEnabled
  const existing = db.prepare('SELECT model FROM daily_summaries WHERE date = ?').get(date) as { model: string } | undefined

  if (existing && !opts.force) {
    const canUpgrade = existing.model === 'statistical' && useAi
    if (!canUpgrade) return { ok: true, date, skipped: true, model: existing.model, reason: '已存在' }
  }

  const articles = loadDayArticles(db, date)
  if (articles.length === 0) {
    return { ok: false, date, skipped: true, model: '-', reason: '当天没有条目' }
  }

  const stats = collectStats(db, date, articles.length)
  let parsed: ParsedSummary | null = null
  let model = 'statistical'

  if (useAi) {
    const res = await chat(buildDailyPrompt(date, articles, stats), { maxTokens: 2000 })
    if (res.ok) parsed = parseSummaryResult(res.content)
    if (parsed) model = config.deepseek.model
  }
  if (!parsed) parsed = statisticalSummary(date, articles, stats)

  const highlights: SummaryHighlight[] = articles.slice(0, 6).map((a) => ({
    title: a.title,
    url: a.url,
    sourceName: a.sourceName,
    category: a.category,
    categoryLabel: label(a.category),
    sourceCount: a.sourceCount,
    score: a.score,
  }))

  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO daily_summaries (date, title, content, highlights, stats, model, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       title = excluded.title, content = excluded.content, highlights = excluded.highlights,
       stats = excluded.stats, model = excluded.model, updated_at = excluded.updated_at`,
  ).run(date, parsed.title, renderSummaryContent(parsed), JSON.stringify(highlights), JSON.stringify(stats), model, now, now)

  return { ok: true, date, skipped: false, model }
}

export function listSummaries(db: DatabaseSync, limit = 60): Omit<DailySummaryRow, 'content' | 'highlights'>[] {
  const rows = db
    .prepare('SELECT date, title, model, stats, created_at, updated_at FROM daily_summaries ORDER BY date DESC LIMIT ?')
    .all(limit) as unknown as { date: string; title: string; model: string; stats: string | null; created_at: string; updated_at: string }[]

  return rows.map((r) => ({
    date: r.date,
    title: r.title,
    model: r.model,
    stats: safeParse<DailyStats | null>(r.stats, null),
    created_at: r.created_at,
    updated_at: r.updated_at,
  }))
}

export function getSummary(db: DatabaseSync, date: string): DailySummaryRow | null {
  const row = db
    .prepare('SELECT date, title, content, highlights, stats, model, created_at, updated_at FROM daily_summaries WHERE date = ?')
    .get(date) as unknown as
    | { date: string; title: string; content: string; highlights: string | null; stats: string | null; model: string; created_at: string; updated_at: string }
    | undefined

  if (!row) return null
  return {
    date: row.date,
    title: row.title,
    content: row.content,
    highlights: safeParse<SummaryHighlight[]>(row.highlights, []),
    stats: safeParse<DailyStats | null>(row.stats, null),
    model: row.model,
    created_at: row.created_at,
    updated_at: row.updated_at,
  }
}
