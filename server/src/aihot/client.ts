/**
 * AIHOT 公开 API 客户端（v1）
 *
 * 用途：**只做外部基准对照**，不并入本站语料。原因见 `benchmark.ts` 顶部说明。
 *
 * 接入规则（照官方文档执行）：
 *   - 匿名只读，无需 key；个人使用免费（对外商业/再分发需书面授权）
 *   - 请求带压缩（Node 的 fetch 自动协商 gzip/br 并解压）
 *   - 用 ETag + If-None-Match，304 直接用缓存
 *   - 同端点最短间隔 60s；429 按 Retry-After 等待，**不并发重试**
 *   - 5xx 指数退避，本次失败就返回上次成功的结果
 *   - 保留 attribution（条目里自带 name/url），界面上必须显示来源
 *
 * ⚠️ 旧接口 `/api/public/*` 与旧域名 2026-10-31 停用，这里直接用 `/api/v1`。
 */

const BASE = 'https://aihot.news'
const UA = 'ai-news-radar/0.31 (personal feed reader; contact via site)'
const MIN_INTERVAL_MS = 60_000
const TIMEOUT_MS = 15_000

export interface AihotItem {
  id: string
  /** AIHOT 改写后的中文标题 */
  title: string
  originalTitle: string | null
  summary: string | null
  /** 原始出处名（含 X 账号） */
  source: string
  /** 原文链接 */
  url: string
  /** AIHOT 自己的条目页 */
  permalink: string
  publishedAt: string
  category: string
  /** AIHOT 的重要性打分 0~100 */
  score: number
  selected: boolean
  /** 为什么选它（AI 给的理由） */
  reason: string | null
}

export interface AihotResponse {
  items: AihotItem[]
  /** true = 内容未变（304），items 来自缓存 */
  notModified: boolean
  /** 本次实际发出的请求数（含翻页） */
  requests: number
}

interface CacheEntry {
  etag: string | null
  at: number
  body: unknown
}

const cache = new Map<string, CacheEntry>()
const lastCallAt = new Map<string, number>()

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function request(path: string, params: Record<string, string | number | undefined>): Promise<{
  status: number
  json: unknown
  etag: string | null
}> {
  const url = new URL(path, BASE)
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, String(v))

  // 同端点限速：文档要求"资讯/热点最快一分钟一次"
  const key = url.pathname
  const last = lastCallAt.get(key) ?? 0
  const wait = MIN_INTERVAL_MS - (Date.now() - last)
  if (wait > 0) await sleep(wait)

  const cached = cache.get(url.toString())
  const headers: Record<string, string> = { 'user-agent': UA, accept: 'application/json' }
  if (cached?.etag) headers['if-none-match'] = cached.etag

  for (let attempt = 0; attempt < 3; attempt++) {
    lastCallAt.set(key, Date.now())
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status === 304) {
      return { status: 304, json: cached?.body ?? null, etag: cached?.etag ?? null }
    }
    if (res.status === 429) {
      // 按 Retry-After 等一次，不并发重试
      const retry = Number(res.headers.get('retry-after') ?? 60)
      await sleep(Math.min(120, Math.max(5, retry)) * 1000)
      continue
    }
    if (res.status >= 500) {
      await sleep(1000 * 2 ** attempt)
      continue
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(`AIHOT ${url.pathname} HTTP ${res.status}：${text.slice(0, 200)}`)
    }
    const json = await res.json()
    cache.set(url.toString(), { etag: res.headers.get('etag'), at: Date.now(), body: json })
    return { status: res.status, json, etag: res.headers.get('etag') }
  }
  // 全部失败：退回上次成功的结果（比抛错更有用）
  if (cached) return { status: 200, json: cached.body, etag: cached.etag }
  throw new Error(`AIHOT ${url.pathname} 连续失败（限流或服务异常）`)
}

/** 把 v1 的条目结构转成内部形态（字段映射照官方迁移指南） */
function normalize(raw: unknown): AihotItem | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const links = (r.links ?? {}) as Record<string, unknown>
  const source = (r.source ?? {}) as Record<string, unknown>
  const url = String(links.original ?? '')
  if (!url) return null
  return {
    id: String(r.id ?? ''),
    title: String(r.title ?? ''),
    originalTitle: r.originalTitle ? String(r.originalTitle) : null,
    summary: r.summary ? String(r.summary) : null,
    source: String(source.name ?? '未知来源'),
    url,
    permalink: String(links.aihot ?? ''),
    publishedAt: String(r.publishedAt ?? ''),
    category: String(r.category ?? ''),
    score: Number(r.score ?? 0),
    selected: Boolean(r.selected),
    reason: r.reason ? String(r.reason) : null,
  }
}

export interface FetchOptions {
  /** 24h / 7d */
  window?: '24h' | '7d'
  /** 每页条数 */
  limit?: number
  /** 最多翻几页（防止无限翻） */
  maxPages?: number
  /** selected = 只要精选；all = 最近全部 */
  mode?: 'selected' | 'all'
}

/** 拉取资讯条目（自动翻页，翻到没有下一页为止） */
export async function fetchItems(opts: FetchOptions = {}): Promise<AihotResponse> {
  const limit = opts.limit ?? 50
  const maxPages = opts.maxPages ?? 4
  const out: AihotItem[] = []
  let cursor: string | undefined
  let requests = 0
  let notModified = false

  for (let page = 0; page < maxPages; page++) {
    const r = await request('/api/v1/items', {
      mode: opts.mode ?? 'selected',
      window: opts.window ?? '24h',
      limit,
      cursor,
    })
    requests += 1
    if (r.status === 304) {
      notModified = true
      break
    }
    const json = r.json as { items?: unknown[]; page?: { hasMore?: boolean; nextCursor?: string | null } } | null
    for (const raw of json?.items ?? []) {
      const it = normalize(raw)
      if (it) out.push(it)
    }
    const p = json?.page
    if (!p?.hasMore || !p.nextCursor) break
    cursor = p.nextCursor
  }

  return { items: out, notModified, requests }
}

/** 最近 7 天 + 精选模式的热点榜（备用） */
export async function fetchHotTopics(limit = 10): Promise<unknown> {
  const r = await request('/api/v1/hot-topics', { limit })
  return r.json
}
