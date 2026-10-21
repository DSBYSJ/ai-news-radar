import { setDefaultResultOrder } from 'node:dns'
import { setDefaultAutoSelectFamily } from 'node:net'

setDefaultResultOrder('ipv4first')
setDefaultAutoSelectFamily(false)

/**
 * Financial Modeling Prep 客户端（v0.37.0）
 *
 * 只做**行情与估值比率**，财报仍走 SEC —— 理由：
 *   - SEC 的 XBRL 是原始事实，口径自己定；FMP 的财务是二次加工，免费档年限也受限
 *   - 但 FMP 有 SEC 没有的东西：股价、市值、以及**已经算好的历史估值比率**
 *
 * ⚠️ 免费档实测限制（2026-10-21 验证）：
 *   - 每天 250 次调用、每月 512MB 带宽
 *   - 日线只给**近 5 年**（1253 个交易日），不是 20 年
 *   - **旧版 /api/v3/* 已全部停用**（返回 403 Legacy Endpoint），必须用 /stable/*
 *   - 所以：首次全量拉一次，之后用 from/to 增量，别每天重下 5 年数据（18 家 × 126KB × 30 天会吃光带宽）
 */

const BASE = 'https://financialmodelingprep.com/stable'
const TIMEOUT_MS = 20_000

function apiKey(): string {
  const k = process.env.FMP_API_KEY?.trim()
  if (!k) throw new Error('缺少 FMP_API_KEY（写进 server/.env，不要提交到仓库）')
  return k
}

export function hasFmpKey(): boolean {
  return Boolean(process.env.FMP_API_KEY?.trim())
}

async function get<T>(path: string, params: Record<string, string | undefined>): Promise<T> {
  const url = new URL(`${BASE}${path}`)
  url.searchParams.set('apikey', apiKey())
  for (const [k, v] of Object.entries(params)) if (v !== undefined) url.searchParams.set(k, v)

  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, {
      headers: { 'user-agent': 'ai-news-radar/0.37 (personal research)', accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)))
      continue
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`FMP ${path} HTTP ${res.status}：${body.slice(0, 160)}`)
    }
    return (await res.json()) as T
  }
  throw new Error(`FMP ${path} 连续限流`)
}

export interface EodRow {
  date: string
  price: number
  volume: number
}

/**
 * 日线（light 版：只有收盘价与成交量）。
 * 用 light 不用 full：18 家 × 5 年，full 是 288KB/家，light 是 126KB/家 —— 省一半带宽，
 * 而我们要的只有收盘价。
 */
export async function fetchEodLight(symbol: string, from?: string, to?: string): Promise<EodRow[]> {
  const rows = await get<{ date?: string; price?: number; volume?: number }[]>('/historical-price-eod/light', {
    symbol,
    from,
    to,
  })
  if (!Array.isArray(rows)) return []
  return rows
    .filter((r) => typeof r.date === 'string' && typeof r.price === 'number' && Number.isFinite(r.price))
    .map((r) => ({ date: r.date as string, price: r.price as number, volume: Number(r.volume ?? 0) }))
    .sort((a, b) => a.date.localeCompare(b.date))
}

export interface RatioRow {
  fiscalEnd: string
  pe: number | null
  ps: number | null
  pb: number | null
  revenuePerShare: number | null
  netIncomePerShare: number | null
}

/**
 * 年度估值比率（FMP 已按各期财报口径算好）。
 *
 * ⚠️ 免费档对 limit 有限制：实测 limit=10 返回 402「Premium Query Parameter」，
 *    不传或 limit≤5 才 200。所以这里不传 limit，用它的默认值（约 5 期）。
 *    我们主要靠自己的日频序列做分位，FMP 这几期只用于交叉校验。
 */
export async function fetchRatios(symbol: string): Promise<RatioRow[]> {
  const rows = await get<Record<string, unknown>[]>('/ratios', { symbol })
  if (!Array.isArray(rows)) return []
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return rows
    .filter((r) => typeof r.date === 'string')
    .map((r) => ({
      fiscalEnd: r.date as string,
      pe: num(r.priceToEarningsRatio),
      ps: num(r.priceToSalesRatio),
      pb: num(r.priceToBookRatio),
      revenuePerShare: num(r.revenuePerShare),
      netIncomePerShare: num(r.netIncomePerShare),
    }))
    .sort((a, b) => a.fiscalEnd.localeCompare(b.fiscalEnd))
}
