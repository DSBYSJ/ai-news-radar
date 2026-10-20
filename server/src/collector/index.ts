import { config } from '../config.ts'
import { getDb } from '../db.ts'
import { fetchText } from './fetch.ts'
import { parseFeed } from './parse.ts'
import { SEED_SOURCES } from './sources.ts'
import { insertRawItems, markSourceFail, markSourceOk, seedSources } from './store.ts'

export interface SourceRunResult {
  sourceId: string
  name: string
  ok: boolean
  fetched: number // 本次抓到的条目数
  inserted: number // 新增入库数
  skipped: number // 去重跳过数
  error?: string
  ms: number
}

export interface CollectSummary {
  ranAt: string // UTC ISO
  sources: SourceRunResult[]
  totalFetched: number
  totalInserted: number
}

interface SourceRow {
  id: string
  name: string
  url: string
  fail_streak: number
  last_fetch_at: string | null
}

/** 采集并发上限（合规要求：并发 ≤3） */
const CONCURRENCY = 3

/**
 * 执行一轮采集。
 * 单源失败只记录 last_status 并跳过，不中断整轮（见 docs/项目方案.md 第二节）。
 */
export async function runCollect(opts: { sourceIds?: string[] } = {}): Promise<CollectSummary> {
  const db = getDb()
  seedSources(db, SEED_SOURCES)

  let sources = db
    .prepare('SELECT id, name, url, fail_streak, last_fetch_at FROM sources WHERE enabled = 1 ORDER BY id')
    .all() as unknown as SourceRow[]

  if (opts.sourceIds && opts.sourceIds.length > 0) {
    const wanted = new Set(opts.sourceIds)
    sources = sources.filter((s) => wanted.has(s.id))
  }

  const collectOne = async (source: SourceRow): Promise<SourceRunResult> => {
    const startedAt = Date.now()

    // 失败退避：连续失败后按 min(backoffMax, base * 2^failStreak) 跳过，避免每轮空等 20s 超时
    const exponent = Math.min(source.fail_streak, 6)
    const backoffMs = Math.min(config.sourceBackoffMaxMin, config.sourceBackoffBaseMin * 2 ** exponent) * 60_000
    const lastTry = source.last_fetch_at ? Date.parse(source.last_fetch_at) : 0
    if (source.fail_streak > 0 && Date.now() - lastTry < backoffMs) {
      return {
        sourceId: source.id,
        name: source.name,
        ok: false,
        fetched: 0,
        inserted: 0,
        skipped: 0,
        error: `backoff(${Math.round(backoffMs / 60_000)}min)`,
        ms: 0,
      }
    }

    try {
      const res = await fetchText(source.url)
      if (!res.ok) throw new Error(res.error ?? `HTTP ${res.status}`)

      const feed = parseFeed(res.body)

      // 只收最近 N 天：挡住新源首次抓到的全量历史归档（如 OpenAI 曾有 1,287 条）
      const cutoff = Date.now() - config.collectMaxAgeDays * 86_400_000
      const recent = feed.items.filter((it) => !it.publishedAt || it.publishedAt.getTime() >= cutoff)
      // 单源单轮条数上限：防止大流量源（HN/IT之家）一次刷几百条、吃掉分类 token
      const capped = recent.slice(0, config.maxItemsPerSource)

      const fetchedAt = new Date()
      const inserted = insertRawItems(db, source.id, capped, fetchedAt)
      markSourceOk(db, source.id, fetchedAt)

      return {
        sourceId: source.id,
        name: source.name,
        ok: true,
        fetched: feed.items.length,
        inserted,
        skipped: feed.items.length - inserted,
        ms: Date.now() - startedAt,
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      markSourceFail(db, source.id, message, new Date())
      return {
        sourceId: source.id,
        name: source.name,
        ok: false,
        fetched: 0,
        inserted: 0,
        skipped: 0,
        error: message,
        ms: Date.now() - startedAt,
      }
    }
  }

  // 分波执行，每波 ≤ CONCURRENCY
  const results: SourceRunResult[] = []
  for (let i = 0; i < sources.length; i += CONCURRENCY) {
    const wave = sources.slice(i, i + CONCURRENCY)
    results.push(...(await Promise.all(wave.map(collectOne))))
  }

  return {
    ranAt: new Date().toISOString(),
    sources: results,
    totalFetched: results.reduce((sum, r) => sum + r.fetched, 0),
    totalInserted: results.reduce((sum, r) => sum + r.inserted, 0),
  }
}
