import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { chat } from './deepseek.ts'
import { extractJson } from './parse.ts'

/**
 * 情感判定（对「AI 行业/公司」而言的利好/利空/中性）
 * - 优先走 DeepSeek 批量判定；AI 不可用时按关键词启发式兜底（不丢数据原则）
 * - 结果写入 articles.sentiment（positive / neutral / negative）
 */
export type Sentiment = 'positive' | 'neutral' | 'negative'

// 按「关键词」逐个计数（同一句里出现多个利好/利空词要累加，否则一句里两个利空
// 会被一个利好词打成平手 —— 早期版本按"模式"计数踩过这个坑）
const POS_WORDS = ['发布', '推出', '上线', '突破', '融资成功', '融资', '增长', '合作', '开源', '提升', '刷新', '领先', '获奖', '盈利', '成功']
const NEG_WORDS = ['裁员', '破产', '诉讼', '起诉', '罚款', '处罚', '下架', '泄露', '漏洞', '警告', '风险', '暴跌', '亏损', '失败', '关停', '调查', '禁令', '抵制', '罢工', '质疑']

const POS_EN = /\b(launch(es|ed)?|release[sd]?|raise[sd]?|surge[sd]?|breakthrough|partner(ship)?|growth|beat[s]?|win[s]?|improve[sd]?|milestone|open[- ]source[sd]?)\b/i
const NEG_EN = /\b(layoff[s]?|bankrupt(cy)?|lawsuit[s]?|fine[sd]?|breach(es)?|leak(s|ed)?|warn(s|ing)?|risk[s]?|shutdown|sue[sd]?|scandal|slump(ed)?|crash(ed)?|investigat(e|es|ed|ion)|probe[s]?|sanction(s|ed)?)\b/i

/** 关键词启发式（AI 不可用时的兜底）；附带返回命中的关键词，供「判定依据」溯源 */
export function sentimentHeuristic(text: string): { sentiment: Sentiment; hits: string[] } {
  const hits: string[] = []
  let pos = 0
  let neg = 0
  for (const word of POS_WORDS) {
    if (text.includes(word)) {
      pos += 1
      hits.push(`+${word}`)
    }
  }
  for (const word of NEG_WORDS) {
    if (text.includes(word)) {
      neg += 1
      hits.push(`-${word}`)
    }
  }
  if (POS_EN.test(text)) {
    pos += 1
    hits.push('+[英文正面]')
  }
  if (NEG_EN.test(text)) {
    neg += 1
    hits.push('-[英文负面]')
  }
  const sentiment: Sentiment = pos > neg ? 'positive' : neg > pos ? 'negative' : 'neutral'
  return { sentiment, hits: hits.slice(0, 8) }
}

export interface SentimentItem {
  title: string
  text: string
}

/** 批次提示词：id 用批次内序号（历史上用真实 id 会导致模型对不上而被静默丢弃） */
export function buildSentimentPrompt(items: SentimentItem[]): string {
  const lines = items
    .map((it, i) => `${i + 1}. ${it.title}${it.text ? ` —— ${it.text.replace(/\s+/g, ' ').slice(0, 100)}` : ''}`)
    .join('\n')

  return `你是 AI 行业分析师。请判断下列资讯「对 AI 行业/相关公司」的情感倾向。

【判定标准】
- positive：进展 / 利好（发布、突破、融资、增长、合作、开源等）
- negative：风险 / 利空（裁员、破产、诉讼、罚款、泄露、预警、下滑等）
- neutral：中性事实（观点、教程、常规更新、无明显倾向）

【要求】只输出 JSON，不要任何解释或 Markdown：
{"results":[{"id":序号,"sentiment":"positive|neutral|negative"}]}

【资讯列表】
${lines}`
}

/** 解析 AI 返回（id 为批次内序号，1 起） */
export function parseSentimentResult(raw: string): Map<number, Sentiment> | null {
  const data = extractJson<Record<string, unknown>>(raw)
  if (!data || typeof data !== 'object' || !Array.isArray(data.results)) return null

  const out = new Map<number, Sentiment>()
  for (const item of data.results) {
    if (typeof item !== 'object' || item === null) continue
    const { id, sentiment } = item as { id?: unknown; sentiment?: unknown }
    const n = Number(id)
    if (!Number.isInteger(n) || n < 1) continue
    if (sentiment === 'positive' || sentiment === 'neutral' || sentiment === 'negative') out.set(n, sentiment)
  }
  return out.size > 0 ? out : null
}

export interface SentimentRunResult {
  scanned: number
  updated: number
  mode: 'ai' | 'heuristic'
}

export async function runSentiment(
  opts: { db?: DatabaseSync; days?: number; limit?: number; useAi?: boolean } = {},
): Promise<SentimentRunResult> {
  const db = opts.db ?? (await import('../db.ts')).getDb()
  const days = opts.days ?? 30
  const limit = opts.limit ?? 500
  const useAi = opts.useAi ?? config.aiEnabled

  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString()
  const rows = db
    .prepare(
      `SELECT id, title, COALESCE(tldr, summary, '') AS text
       FROM articles
       WHERE sentiment IS NULL AND published_at >= ?
       ORDER BY published_at DESC
       LIMIT ?`,
    )
    .all(cutoff, limit) as unknown as { id: number; title: string; text: string }[]

  if (rows.length === 0) return { scanned: 0, updated: 0, mode: useAi ? 'ai' : 'heuristic' }

  const aiResults = new Map<number, Sentiment>()
  let aiUsed = false

  if (useAi) {
    const BATCH = 20
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH)
      const res = await chat(buildSentimentPrompt(batch.map((r) => ({ title: r.title, text: r.text }))), {
        maxTokens: 1200,
      })
      if (res.ok) {
        const parsed = parseSentimentResult(res.content)
        if (parsed) {
          aiUsed = true
          for (const [index, sentiment] of parsed) {
            const row = batch[index - 1]
            if (row) aiResults.set(row.id, sentiment)
          }
        }
      }
    }
  }

  // 同时记录「判定依据」：AI 判定时写模型与提示词摘要，启发式时写命中的关键词
  const update = db.prepare('UPDATE articles SET sentiment = ?, sentiment_keywords = ? WHERE id = ?')
  let updated = 0
  for (const row of rows) {
    const aiVerdict = aiResults.get(row.id)
    if (aiVerdict) {
      update.run(aiVerdict, `ai:${config.deepseek.model}`, row.id)
    } else {
      const { sentiment, hits } = sentimentHeuristic(`${row.title} ${row.text}`)
      update.run(sentiment, `heuristic:${hits.join(',') || '无命中'}`, row.id)
    }
    updated += 1
  }

  return { scanned: rows.length, updated, mode: aiUsed ? 'ai' : 'heuristic' }
}
