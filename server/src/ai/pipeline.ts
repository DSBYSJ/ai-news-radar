import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import type { Category } from './categories.ts'
import { chat } from './deepseek.ts'
import { normalizeEntity } from './entities.ts'
import { classifyByRules } from './heuristic.ts'
import { applySourceWeight } from './scoring.ts'
import { judgeRelevance } from './relevance.ts'
import { parseStage1, parseStage2, type Stage1Result } from './parse.ts'
import { buildStage1Prompt, buildStage2Prompt } from './prompts.ts'

export interface ProcessOptions {
  /** 只处理最近 N 天采集到的原始条目（默认 30 天） */
  sinceDays?: number
  /** 单次最多处理多少条原始条目 */
  limit?: number
  /** 单次最多对多少条高分条目做阶段 2 深加工（控成本） */
  deepLimit?: number
  /** 是否走 AI（默认取配置；关闭则纯启发式） */
  useAi?: boolean
  minScoreForDeep?: number
  db?: DatabaseSync
}

export interface ProcessSummary {
  ranAt: string
  mode: 'ai' | 'heuristic' | 'mixed'
  scanned: number
  classified: number
  deepProcessed: number
  aiErrors: number
  /** 最近一次 AI 失败原因（排障用，不写库） */
  lastError?: string
}

interface RawRow {
  id: number
  title: string
  summary: string | null
  url: string
  published_at: string
  source_name: string
  weight: number
}

/** 按字符预算分批，避免单批超 token（标题长度差异大时别写死 20） */
function chunkByBudget<T>(items: T[], sizeOf: (t: T) => number, maxItems: number, maxChars: number): T[][] {
  const chunks: T[][] = []
  let cur: T[] = []
  let curChars = 0
  for (const it of items) {
    const size = sizeOf(it)
    if (cur.length >= maxItems || (cur.length > 0 && curChars + size > maxChars)) {
      chunks.push(cur)
      cur = []
      curChars = 0
    }
    cur.push(it)
    curChars += size
  }
  if (cur.length > 0) chunks.push(cur)
  return chunks
}

/**
 * 两阶段 AI 加工：
 *  阶段 1 —— 批量分类 + 打分（轻量），失败重试 1 次，仍失败则该批走启发式
 *  阶段 2 —— 仅对 score ≥ 阈值（默认 60）的条目做深度摘要与实体抽取
 * 任何情况下都不丢数据：AI 不可用 → 启发式兜底；模型结果缺 id → 该条走启发式
 */
export async function runProcessing(opts: ProcessOptions = {}): Promise<ProcessSummary> {
  const db = opts.db ?? (await import('../db.ts')).getDb()
  const sinceDays = opts.sinceDays ?? 30
  const limit = opts.limit ?? 500
  const deepLimit = opts.deepLimit ?? 120
  const useAi = opts.useAi ?? config.aiEnabled
  const minScoreForDeep = opts.minScoreForDeep ?? config.minScoreForDeep

  const cutoff = new Date(Date.now() - sinceDays * 86_400_000).toISOString()
  const rows = db
    .prepare(
      `SELECT r.id, r.title, r.summary, r.url, r.published_at, s.name AS source_name, s.weight AS weight
       FROM raw_items r
       JOIN sources s ON s.id = r.source_id
       LEFT JOIN articles a ON a.raw_id = r.id
       WHERE a.id IS NULL AND r.published_at >= ?
       ORDER BY r.published_at DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as unknown as RawRow[]

  if (rows.length === 0) {
    return { ranAt: new Date().toISOString(), mode: useAi ? 'ai' : 'heuristic', scanned: 0, classified: 0, deepProcessed: 0, aiErrors: 0 }
  }

  const insertArticle = db.prepare(
    `INSERT OR IGNORE INTO articles
       (raw_id, url, title, tldr, summary, category, entities, score, score_parts, event_key, published_at, created_at, ai_relevant)
     VALUES (?, ?, ?, NULL, ?, ?, NULL, ?, ?, NULL, ?, ?, ?)`,
  )
  const insertMention = db.prepare('INSERT OR IGNORE INTO mentions (article_id, entity) VALUES (?, ?)')
  const updateDeep = db.prepare('UPDATE articles SET tldr = ?, summary = ?, entities = ? WHERE id = ?')

  let classified = 0
  let aiErrors = 0
  let usedFallback = false
  let lastError = ''

  for (const batch of chunkByBudget(rows, (r) => r.title.length + (r.summary?.length ?? 0), 20, 6000)) {
    // 交给模型的 id 用批次内序号（1..N），回来后再映射回真实条目
    const inputs = batch.map((r, i) => ({ id: i + 1, title: r.title, summary: r.summary ?? '', source: r.source_name }))
    const validIds = [...inputs.map((i) => i.id), ...batch.map((r) => r.id)]
    let results: Stage1Result[] | null = null

    if (useAi) {
      const prompt = buildStage1Prompt(inputs)
      let res = await chat(prompt, { maxTokens: 4096 })
      results = res.ok ? parseStage1(res.content, validIds) : null
      if (res.ok && !results) lastError = '阶段1 返回的 JSON 校验失败'
      if (!results) {
        res = await chat(prompt, { maxTokens: 4096 }) // 重试 1 次
        results = res.ok ? parseStage1(res.content, validIds) : null
        if (res.ok && !results) lastError = '阶段1 返回的 JSON 校验失败（重试后仍失败）'
      }
      if (!results) {
        aiErrors += batch.length
        usedFallback = true
        lastError = res.error || lastError || '未知原因'
      }
    }

    const byId = new Map<number, Stage1Result>()
    if (results) for (const r of results) byId.set(r.id, r)

    const now = new Date().toISOString()
    for (let i = 0; i < batch.length; i++) {
      const row = batch[i]
      // 优先按序号取，其次容忍模型直接回真实 id
      const hit = byId.get(i + 1) ?? byId.get(row.id)
      const picked: { category: Category; score: number; reason?: string } =
        hit ?? classifyByRules(row.title, row.summary ?? '')
      if (!hit) usedFallback = true

      const mode = hit ? 'ai' : 'heuristic'
      // 信源权重统一在这里生效：官方一手 +5，聚合 -5，媒体 0
      const weighted = applySourceWeight(picked.score, row.weight)
      // AI 相关性：模型给了就用模型的（语义更准），没给则用关键词兜底
      const keyword = judgeRelevance(row.title, row.summary ?? '')
      const aiRelevant = hit?.ai ?? keyword.relevant
      const scoreParts = JSON.stringify({
        mode,
        reason: picked.reason ?? '',
        sourceWeight: row.weight,
        baseScore: weighted.baseScore,
        weightBonus: weighted.bonus,
        aiRelevant,
        aiBy: hit?.ai === undefined ? 'keyword' : 'model',
        aiHits: keyword.hits,
      })

      const res = insertArticle.run(
        row.id,
        row.url,
        row.title,
        row.summary ?? null,
        picked.category,
        weighted.score,
        scoreParts,
        row.published_at,
        now,
        aiRelevant ? 1 : 0,
      )
      if (Number(res.changes) > 0) classified += 1
    }
  }

  // 阶段 2：仅对高分条目深加工（控成本）
  let deepProcessed = 0
  if (useAi) {
    const pending = db
      .prepare(
        `SELECT a.id, a.title, a.url, COALESCE(a.summary, r.summary, '') AS content, s.name AS source_name
         FROM articles a
         JOIN raw_items r ON r.id = a.raw_id
         JOIN sources s ON s.id = r.source_id
         WHERE a.score >= ? AND a.tldr IS NULL
         ORDER BY a.score DESC
         LIMIT ?`,
      )
      .all(minScoreForDeep, deepLimit) as unknown as {
      id: number
      title: string
      url: string
      content: string
      source_name: string
    }[]

    for (const item of pending) {
      const res = await chat(buildStage2Prompt({ title: item.title, source: item.source_name, content: item.content }))
      if (!res.ok) continue
      const parsed = parseStage2(res.content)
      if (!parsed) continue

      const entities: string[] = []
      for (const raw of parsed.entities) {
        const e = normalizeEntity(raw)
        if (e && !entities.includes(e)) entities.push(e)
      }

      updateDeep.run(parsed.tldr, parsed.summary || item.content.slice(0, 500), JSON.stringify(entities), item.id)
      for (const e of entities) insertMention.run(item.id, e)
      deepProcessed += 1
    }
  }

  return {
    ranAt: new Date().toISOString(),
    mode: !useAi ? 'heuristic' : usedFallback ? 'mixed' : 'ai',
    scanned: rows.length,
    classified,
    deepProcessed,
    aiErrors,
    lastError: lastError || undefined,
  }
}
