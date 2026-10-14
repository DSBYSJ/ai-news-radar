import { createHash } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { DatabaseSync as Sqlite } from 'node:sqlite'
import { fnv1a64 } from '../analytics/simhash.ts'
import { textTokens } from '../analytics/tokens.ts'
import { config } from '../config.ts'
import { chat } from './deepseek.ts'
import { formatRowsAsAnswer, generateSql, stripNarrative, validateSql } from './sql.ts'

/**
 * 自然语言问答（/api/news/ask）
 *
 * 两类问题：
 *  · 统计类 → Text-to-SQL：模型生成只读 SQL → 三层安全校验 → 只读连接执行 → **数字由结果确定性格式化**
 *  · 归因类 → 本地哈希向量检索 Top5 → 连同统计上下文喂模型做归因（引用只允许来自检索结果）
 *
 * 关于 Embedding：DeepSeek 官方**没有 embeddings 接口**（只有对话模型），
 * 因此这里用零依赖的「哈希 TF 向量」做检索（hashed-tf-v1），
 * 再由模型在候选内重排 + 归因。若将来接入真 embedding，只需替换 hashVector() 一处。
 *
 * 合规：接口挂在 /api/news/* 下，与其它接口同样受登录鉴权（仅本人自用，不对外提供服务）。
 */
export type AskKind = 'stats' | 'attribution'
export type AskMode = 'ai' | 'fallback'

export interface AskSource {
  index: number
  title: string
  url: string
  sourceName: string
  date: string
  /** 摘要片段（TL;DR 优先，供模型做归因与前端展示） */
  snippet: string
  similarity: number
}

export interface AskResult {
  kind: AskKind
  answer: string
  sources: AskSource[]
  /** 回答中实际引用到的编号（1 起）；缺失表示模型未按编号引用 */
  cited?: number[]
  sql?: string
  mode: AskMode
  note?: string
}

const VECTOR_DIM = 256
const VECTOR_MODEL = 'hashed-tf-v1'
const DAY_MS = 86_400_000
const CACHE_TTL_MS = 5 * 60 * 1000

// ---------------------------------------------------------------- 问题路由

const STATS_PATTERNS = [/几篇/, /几条/, /多少/, /数量/, /统计/, /占比/, /比例/, /排名/, /条数/, /平均/, /top\s*\d/i, /列出/, /最多的/, /前几/]
const ATTRIBUTION_PATTERNS = [/为什么/, /为啥/, /原因/, /归因/, /怎么回事/, /发生了什么/, /啥情况/, /解读/, /分析/, /飙升/, /激增/, /暴涨/, /异动/, /突然/]

export function classifyQuestion(question: string): AskKind {
  if (STATS_PATTERNS.some((re) => re.test(question))) return 'stats'
  if (ATTRIBUTION_PATTERNS.some((re) => re.test(question))) return 'attribution'
  return 'stats'
}

/** 从问题里抽出日期（支持 2026-10-13 / 10-13 / 10月13日），默认当年 UTC */
export function extractDate(question: string): string | null {
  const iso = question.match(/(\d{4})-(\d{1,2})-(\d{1,2})/)
  if (iso) return `${iso[1]}-${iso[2].padStart(2, '0')}-${iso[3].padStart(2, '0')}`
  const cn = question.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]/)
  if (cn) return `${new Date().getUTCFullYear()}-${cn[1].padStart(2, '0')}-${cn[2].padStart(2, '0')}`
  const md = question.match(/(?:^|[^\d])(\d{1,2})-(\d{1,2})(?:[^\d]|$)/)
  if (md) return `${new Date().getUTCFullYear()}-${md[1].padStart(2, '0')}-${md[2].padStart(2, '0')}`
  return null
}

// ---------------------------------------------------------------- 本地向量

/** 哈希 TF 向量（次线性 TF + L2 归一化），零依赖、可持久化 */
export function hashVector(text: string, dim = VECTOR_DIM): Float32Array {
  const v = new Float32Array(dim)
  const tf = new Map<string, number>()
  for (const t of textTokens(text)) tf.set(t, (tf.get(t) ?? 0) + 1)
  for (const [token, count] of tf) {
    const h = Number(fnv1a64(token) & 0xfffffffn) % dim
    v[h] += 1 + Math.log(count)
  }
  let norm = 0
  for (const x of v) norm += x * x
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < dim; i++) v[i] /= norm
  return v
}

/** 余弦相似度（入参需已 L2 归一化） */
export function cosine(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < n; i++) dot += a[i] * b[i]
  return dot
}

function fingerprint(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 16)
}

function toFloat32(bytes: Uint8Array): Float32Array {
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  return new Float32Array(copy)
}

/** 建/增量更新文章向量表（内容指纹变化才重算） */
export function ensureVectors(db: DatabaseSync): { total: number; built: number } {
  db.exec(`CREATE TABLE IF NOT EXISTS article_vectors (
    article_id INTEGER PRIMARY KEY REFERENCES articles(id),
    dim        INTEGER NOT NULL,
    vec        BLOB    NOT NULL,
    model      TEXT    NOT NULL,
    fingerprint TEXT   NOT NULL,
    updated_at TEXT    NOT NULL
  )`)

  const existing = new Map<string, string>()
  for (const r of db.prepare('SELECT article_id, fingerprint FROM article_vectors WHERE model = ?').all(VECTOR_MODEL) as unknown as {
    article_id: number
    fingerprint: string
  }[]) {
    existing.set(String(r.article_id), r.fingerprint)
  }

  const rows = db
    .prepare(
      `SELECT id, title, COALESCE(tldr, '') AS tldr, COALESCE(summary, '') AS summary
       FROM articles`,
    )
    .all() as unknown as { id: number; title: string; tldr: string; summary: string }[]

  const insert = db.prepare(
    `INSERT INTO article_vectors (article_id, dim, vec, model, fingerprint, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(article_id) DO UPDATE SET dim = excluded.dim, vec = excluded.vec,
       model = excluded.model, fingerprint = excluded.fingerprint, updated_at = excluded.updated_at`,
  )

  const now = new Date().toISOString()
  let built = 0
  for (const r of rows) {
    const text = `${r.title} ${r.tldr} ${r.summary}`
    const fp = fingerprint(text)
    if (existing.get(String(r.id)) === fp) continue
    const vec = hashVector(text)
    insert.run(r.id, VECTOR_DIM, Buffer.from(vec.buffer), VECTOR_MODEL, fp, now)
    built += 1
  }
  return { total: rows.length, built }
}

/** 向量检索：返回最相关的若干篇（含来源与链接）
 *  · 问题里带日期时，把候选收窄到该日期前后 windowDays 天（避免捞到全库不相关的文章）
 *  · 得分 = 余弦相似度 + 标题命中加权（新闻检索里标题信号很强）
 */
export function retrieve(
  db: DatabaseSync,
  question: string,
  limit = 5,
  opts: { date?: string | null; windowDays?: number } = {},
): AskSource[] {
  ensureVectors(db)
  const qv = hashVector(question)
  const qTokens = new Set(textTokens(question))

  const date = opts.date ?? null
  const windowDays = opts.windowDays ?? 3
  const params: string[] = []
  let where = 'a.published_at >= ?'
  if (date && Number.isFinite(Date.parse(`${date}T00:00:00Z`))) {
    const center = Date.parse(`${date}T00:00:00Z`)
    where = 'a.published_at >= ? AND a.published_at < ?'
    params.push(
      new Date(center - windowDays * DAY_MS).toISOString(),
      new Date(center + (windowDays + 1) * DAY_MS).toISOString(),
    )
  } else {
    params.push(new Date(Date.now() - 120 * DAY_MS).toISOString())
  }

  const rows = db
    .prepare(
      `SELECT a.id, a.title, a.url, a.published_at,
              substr(COALESCE(NULLIF(a.tldr, ''), COALESCE(a.summary, ''), a.title), 1, 200) AS snippet,
              s.name AS sourceName, v.vec
       FROM articles a
       JOIN raw_items r ON r.id = a.raw_id
       JOIN sources s ON s.id = r.source_id
       JOIN article_vectors v ON v.article_id = a.id
       WHERE ${where}`,
    )
    .all(...params) as unknown as {
    id: number
    title: string
    url: string
    published_at: string
    snippet: string
    sourceName: string
    vec: Uint8Array
  }[]

  return rows
    .map((r) => {
      const overlap = (() => {
        if (qTokens.size === 0) return 0
        const titleTokens = new Set(textTokens(r.title))
        let hit = 0
        for (const t of qTokens) if (titleTokens.has(t)) hit += 1
        return hit / qTokens.size
      })()
      return { row: r, score: cosine(qv, toFloat32(r.vec)) + 0.35 * overlap }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, score }, i) => ({
      index: i + 1,
      title: row.title,
      url: row.url,
      sourceName: row.sourceName,
      date: row.published_at.slice(0, 10),
      snippet: row.snippet,
      similarity: Number(score.toFixed(4)),
    }))
}

// ---------------------------------------------------------------- 提示词

function narrativePrompt(question: string, sql: string, rows: Record<string, unknown>[]): string {
  const table = rows
    .slice(0, 10)
    .map((r) => Object.entries(r).map(([k, v]) => `${k}=${v}`).join('，'))
    .join('\n')
  return `你在解释一条数据库查询结果。用 2~3 句中文说明这个结果说明了什么。

【硬约束】只允许使用下面结果里出现过的数字，一个新数字都不许出现；没有依据就只做定性描述。

【问题】${question}
【SQL】${sql}
【结果】
${table}

解读：`
}

function attributionPrompt(question: string, context: string, sources: AskSource[]): string {
  const list = sources
    .map((s) => `[${s.index}] ${s.title}｜${s.sourceName}｜${s.date}｜${s.url}\n    摘要：${s.snippet || '（无）'}`)
    .join('\n')
  return `你是 AI 行业分析师。用户问某个现象的**原因**。下面是系统检索到的相关文章与统计上下文。

【检索到的文章（唯一事实来源）】
${list}

【统计上下文】
${context}

【要求】
1. 只能引用上面列出的文章，引用时用 [1] [2] 编号；不得补充任何未列出的事件、数字或来源；
2. 先给结论（1~2 句），再分 2~4 点解释证据（每点后面标注引用编号）；
3. 上下文里没有的数据，明确说"暂无数据"，不要猜；
4. 全部中文，不超过 400 字。`
}

/** 从问题里定位日期并汇总当天统计上下文 */
export function buildContext(db: DatabaseSync, question: string): string {
  const date =
    extractDate(question) ??
    ((db.prepare('SELECT MAX(date(published_at)) AS d FROM articles').get() as { d: string | null }).d ?? null)
  if (!date) return '（暂无日期上下文）'

  const total = Number((db.prepare('SELECT COUNT(*) AS n FROM articles WHERE date(published_at) = ?').get(date) as { n: number }).n)
  const prev = Number(
    (db.prepare("SELECT COUNT(*) AS n FROM articles WHERE date(published_at) = date(?, '-1 day')").get(date) as { n: number }).n,
  )
  const cats = db
    .prepare('SELECT category, COUNT(*) AS n FROM articles WHERE date(published_at) = ? GROUP BY category ORDER BY n DESC LIMIT 5')
    .all(date) as unknown as { category: string; n: number }[]
  const bursts = db
    .prepare('SELECT category, article_count, baseline_mean, z_score FROM burst_detection WHERE date = ? ORDER BY z_score DESC LIMIT 5')
    .all(date) as unknown as { category: string; article_count: number; baseline_mean: number; z_score: number }[]
  const events = db
    .prepare('SELECT representative_title, source_count, article_count FROM event_clusters WHERE publish_date = ? ORDER BY source_count DESC LIMIT 5')
    .all(date) as unknown as { representative_title: string; source_count: number; article_count: number }[]
  const senti = db
    .prepare('SELECT sentiment, COUNT(*) AS n FROM articles WHERE date(published_at) = ? AND sentiment IS NOT NULL GROUP BY sentiment')
    .all(date) as unknown as { sentiment: string; n: number }[]

  const lines = [
    `日期：${date}（UTC）；当天收录 ${total} 条，前一天 ${prev} 条`,
    `分类分布：${cats.map((c) => `${c.category} ${c.n}`).join('、') || '无'}`,
    `突发：${bursts.map((b) => `${b.category} ${b.article_count} 条(基线 ${b.baseline_mean}, z=${b.z_score})`).join('；') || '无'}`,
    `跨源事件：${events.map((e) => `「${e.representative_title}」${e.source_count} 源/${e.article_count} 条`).join('；') || '无'}`,
    `情感：${senti.map((s) => `${s.sentiment} ${s.n}`).join('、') || '暂无数据'}`,
  ]
  return lines.join('\n')
}

/** 抽取回答里引用到的编号 */
export function extractCitations(answer: string, sources: AskSource[]): number[] {
  const cited = new Set<number>()
  for (const m of answer.matchAll(/\[(\d{1,2})\]/g)) {
    const n = Number(m[1])
    if (n >= 1 && n <= sources.length) cited.add(n)
  }
  // 兜底：模型直接写了标题的情况
  for (const s of sources) {
    const key = s.title.slice(0, 12)
    if (key.length >= 6 && answer.includes(key)) cited.add(s.index)
  }
  return [...cited].sort((a, b) => a - b)
}

// ---------------------------------------------------------------- 执行与编排

/** 只读连接执行（即使校验有漏也写不进库） */
function execReadOnly(sql: string): Record<string, unknown>[] {
  const ro = new Sqlite(config.databasePath, { readOnly: true })
  try {
    return (ro.prepare(sql).all() as Record<string, unknown>[]).slice(0, 200)
  } finally {
    ro.close()
  }
}

async function answerStats(question: string, useAi: boolean): Promise<AskResult> {
  if (!useAi) {
    return { kind: 'stats', answer: 'AI 未配置，无法把自然语言翻译成 SQL。', sources: [], mode: 'fallback', note: 'no-ai' }
  }

  const sql = await generateSql(question)
  if (!sql) return { kind: 'stats', answer: '模型这次没生成可用查询，换个说法再试试。', sources: [], mode: 'fallback', note: 'sql-gen-failed' }

  const check = validateSql(sql)
  if (!check.ok) {
    return { kind: 'stats', answer: `为安全起见只允许只读查询（被拒原因：${check.reason}）。`, sources: [], mode: 'fallback', note: 'sql-rejected' }
  }

  let rows: Record<string, unknown>[]
  try {
    rows = execReadOnly(check.sql)
  } catch (err) {
    return {
      kind: 'stats',
      answer: `查询执行失败：${err instanceof Error ? err.message : String(err)}`,
      sources: [],
      sql: check.sql,
      mode: 'fallback',
      note: 'sql-error',
    }
  }

  const answer = formatRowsAsAnswer(rows, question)

  // 解读是可选的：其数字必须全部出现在结果里，否则整段丢弃（反编造闸门）
  let narrative: string | null = null
  if (rows.length > 0) {
    // 解读是自由文本 → json:false
    const res = await chat(narrativePrompt(question, check.sql, rows), { maxTokens: 300, json: false })
    if (res.ok) narrative = stripNarrative(res.content, rows)
  }

  return {
    kind: 'stats',
    answer: narrative ? `${answer}\n\n${narrative}` : answer,
    sources: [],
    sql: check.sql,
    mode: 'ai',
    note: narrative ? undefined : rows.length > 0 ? 'narrative-dropped' : undefined,
  }
}

async function answerAttribution(question: string, db: DatabaseSync, useAi: boolean, limit: number): Promise<AskResult> {
  const date = extractDate(question)
  const sources = retrieve(db, question, limit, { date })
  if (sources.length === 0) {
    return { kind: 'attribution', answer: '没检索到相关条目，试试换个说法或放宽时间范围。', sources: [], mode: 'fallback', note: 'no-hits' }
  }

  // 检索质量太差时先说清楚，避免"没有证据却硬归因"
  const weak = sources[0].similarity < 0.15
  const prefix = weak
    ? `库里没有与「${question}」高度相关的报道（下面是检索到的最接近的几篇，仅供参考，不要当作证据）：\n\n`
    : ''

  if (!useAi) {
    return {
      kind: 'attribution',
      answer: `${prefix}AI 未配置，先把最相关的几篇列给你（未做归因分析）。`,
      sources,
      mode: 'fallback',
      note: 'no-ai',
    }
  }

  const context = buildContext(db, question)
  // 归因是自由文本 → json:false
  const res = await chat(attributionPrompt(question, context, sources), { maxTokens: 800, json: false })
  if (!res.ok) {
    return { kind: 'attribution', answer: `${prefix}模型调用失败，先给你检索到的相关文章。`, sources, mode: 'fallback', note: 'llm-failed' }
  }

  const answer = res.content.trim()
  return {
    kind: 'attribution',
    answer: `${prefix}${answer}`,
    sources,
    cited: extractCitations(answer, sources),
    mode: 'ai',
    note: weak ? 'low-relevance' : undefined,
  }
}

const cache = new Map<string, { at: number; result: AskResult }>()

/** 统一入口（带 5 分钟结果缓存，避免重复的模型开销） */
export async function askQuestion(
  question: string,
  opts: { db?: DatabaseSync; useAi?: boolean; limit?: number } = {},
): Promise<AskResult> {
  const db = opts.db ?? (await import('../db.ts')).getDb()
  const useAi = opts.useAi ?? config.aiEnabled
  const kind = classifyQuestion(question)
  const key = `${kind}|${question.trim()}`

  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.result

  const result =
    kind === 'stats'
      ? await answerStats(question, useAi)
      : await answerAttribution(question, db, useAi, opts.limit ?? 5)

  cache.set(key, { at: Date.now(), result })
  return result
}