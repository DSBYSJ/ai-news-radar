import type { Category } from './categories.ts'
import { isCategory } from './categories.ts'

export interface Stage1Result {
  id: number
  category: Category
  score: number
  /** 模型判定的 AI 相关性；未给出时为 undefined，由关键词兜底 */
  ai?: boolean
  reason?: string
}

export interface Stage2Result {
  tldr: string
  summary: string
  entities: string[]
}

/** 从模型输出里提取 JSON（容忍 ```json 围栏与前后多余文字） */
export function extractJson<T>(text: string): T | null {
  const cleaned = text
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/, '')
    .trim()

  try {
    return JSON.parse(cleaned) as T
  } catch {
    const start = cleaned.search(/[[{]/)
    const end = Math.max(cleaned.lastIndexOf(']'), cleaned.lastIndexOf('}'))
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(cleaned.slice(start, end + 1)) as T
      } catch {
        return null
      }
    }
    return null
  }
}

function toScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(100, Math.round(n)))
}

const ARRAY_KEYS = ['results', 'items', 'data', 'articles', 'output', 'list']

/**
 * 模型可能返回顶层数组，也可能包一层对象（{"results":[...]}，JSON 模式常见）。
 * 这里两种都吃，并兜底扫描出「元素是对象且带 id」的数组。
 */
function findResultArray(data: unknown): unknown[] | null {
  if (Array.isArray(data)) return data.length > 0 ? data : null
  if (typeof data !== 'object' || data === null) return null

  const obj = data as Record<string, unknown>
  for (const key of ARRAY_KEYS) {
    const v = obj[key]
    if (Array.isArray(v) && v.length > 0) return v
  }

  const queue: unknown[] = Object.values(obj)
  while (queue.length > 0) {
    const cur = queue.shift()
    if (Array.isArray(cur)) {
      const first = cur[0]
      if (cur.length > 0 && typeof first === 'object' && first !== null && 'id' in (first as object)) return cur
    } else if (typeof cur === 'object' && cur !== null) {
      queue.push(...Object.values(cur as Record<string, unknown>))
    }
  }
  return null
}

/** 解析阶段 1 结果：非法分类兜底 other、分数夹取 0~100、未知 id 直接丢弃 */
export function parseStage1(raw: string, validIds: number[]): Stage1Result[] | null {
  const list = findResultArray(extractJson<unknown>(raw))
  if (!list) return null

  const allowed = new Set(validIds)
  const out: Stage1Result[] = []

  for (const entry of list) {
    if (typeof entry !== 'object' || entry === null) continue
    const row = entry as Record<string, unknown>
    const id = Number(row.id)
    if (!allowed.has(id)) continue

    out.push({
      id,
      category: isCategory(row.category) ? row.category : 'other',
      score: toScore(row.score),
      ai: typeof row.ai === 'boolean' ? row.ai : undefined,
      reason: typeof row.reason === 'string' ? row.reason.slice(0, 200) : undefined,
    })
  }

  return out.length > 0 ? out : null
}

/** 解析阶段 2 结果 */
export function parseStage2(raw: string): Stage2Result | null {
  const data = extractJson<Record<string, unknown>>(raw)
  if (!data) return null

  const tldr = typeof data.tldr === 'string' ? data.tldr.trim().slice(0, 120) : ''
  const summary = typeof data.summary === 'string' ? data.summary.trim().slice(0, 1000) : ''
  const entities = Array.isArray(data.entities)
    ? data.entities
        .filter((e): e is string => typeof e === 'string' && e.trim().length > 0)
        .map((e) => e.trim().slice(0, 60))
        .slice(0, 10)
    : []

  if (!tldr && !summary) return null
  return { tldr, summary, entities }
}
