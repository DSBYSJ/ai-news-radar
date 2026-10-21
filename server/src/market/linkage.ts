import type { DatabaseSync } from 'node:sqlite'
import { loadSeries, type SeriesData } from '../risk/macroHistory.ts'
import { loadPrices } from './prices.ts'
import { companyOf, symbolOfEntity } from './universe.ts'

/**
 * 新闻热度 × 股价表现联动（v0.42.0）
 *
 * ## 要回答的问题（必须先能证伪）
 *
 * 「某实体在一天内被 ≥N 家**独立源**报道之后，它随后的股价表现是否与市场不同？」
 *
 * 这是个可证伪的命题：
 *   · 如果跨源确认真有信息量 → 事件后的超额收益应显著偏离 0
 *   · 如果只是噪声 → 超额收益应围绕 0 波动，胜率接近 50%
 *
 * 所以这里算的是**超额收益**（个股 − 纳指），不是绝对涨跌 ——
 * 否则大盘普涨时所有事件都"有效"，等于什么都没验证。
 *
 * ## 已知的硬约束（必须写在界面上）
 *
 * 新闻历史只有约 1 个月，而事件窗口要 5 个交易日 → **样本极少**。
 * 因此本模块的首要职责不是"给结论"，而是**如实报告样本量**，
 * 并在样本不足时明确说"无法判断"，而不是画一条看起来有洞见的曲线。
 */

export interface LinkageEvent {
  date: string
  symbol: string
  entity: string
  /** 当日报道该实体的独立信源数 */
  sources: number
  mentions: number
  /** 事件当日超额收益（相对前一交易日收盘）—— 事件日即可得，但可能由新闻本身驱动 */
  sameDayExcess: number | null
  /** 事件日收盘为基准，之后 horizon 个交易日的个股收益 */
  stockReturn: number | null
  /** 同期纳指收益 */
  indexReturn: number | null
  /** 超额收益 = 个股 − 纳指 */
  excessReturn: number | null
  /** 无法计算时的原因 */
  reason: string | null
}

export interface LinkageSummary {
  horizon: number
  minSources: number
  windowDays: number
  newsFrom: string | null
  newsTo: string | null
  /** 识别到的原始事件数（实体级） */
  rawEvents: number
  /** 能映射到有价格标的的事件数 */
  mappedEvents: number
  /** 能算出超额收益的事件数 */
  evaluated: number
  /** 事件当日超额（T0） */
  sameDay: { evaluated: number; avg: number | null; median: number | null; winRate: number | null }
  /** 事件后 horizon 个交易日超额（T+1..T+h） */
  forward: { evaluated: number; avg: number | null; median: number | null; winRate: number | null }
  /**
   * 无法映射到上市公司的热门实体（按提及数排序）。
   * 这不是缺陷而是**发现**：叙事热度最集中的主体（OpenAI / DeepSeek / Claude）
   * 根本没有股票可交易 —— 这正是"叙事与可投资资产脱节"的直接证据。
   */
  unmappedTop: { entity: string; mentions: number; sources: number }[]
  /** 样本是否足以支撑结论 */
  sufficient: boolean
  note: string
  bySymbol: { symbol: string; events: number; evaluated: number; avgExcess: number | null; winRate: number | null }[]
  items: LinkageEvent[]
}

/** 在升序日期数组里找第一个 >= date 的下标 */
function firstIndexAtOrAfter(dates: string[], date: string): number {
  let lo = 0
  let hi = dates.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid] >= date) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

/** 某序列在 date 之后第 n 个交易日的收益（以 date 当天或之后第一个交易日为基准） */
function forwardReturn(s: SeriesData, date: string, n: number): number | null {
  const i = firstIndexAtOrAfter(s.dates, date)
  if (i < 0 || i + n >= s.dates.length) return null
  const base = s.values[i]
  if (!Number.isFinite(base) || base <= 0) return null
  return s.values[i + n] / base - 1
}

interface RawEvent {
  date: string
  entity: string
  sources: number
  mentions: number
}

function rawEvents(db: DatabaseSync, sinceDate: string, minSources: number): RawEvent[] {
  return db
    .prepare(
      `SELECT date(a.published_at) AS date, m.entity AS entity,
              COUNT(DISTINCT r.source_id) AS sources, COUNT(*) AS mentions
         FROM mentions m
         JOIN articles a ON a.id = m.article_id
         JOIN raw_items r ON r.id = a.raw_id
        WHERE a.ai_relevant = 1 AND date(a.published_at) >= ?
        GROUP BY date(a.published_at), m.entity
       HAVING sources >= ?`,
    )
    .all(sinceDate, minSources) as unknown as RawEvent[]
}

export interface LinkageOptions {
  /** 预测窗口（交易日），默认 5 */
  horizon?: number
  /** 独立源门槛，默认 3 */
  minSources?: number
  /** 回看天数，默认 60 */
  windowDays?: number
}

export function buildLinkage(db: DatabaseSync, opts: LinkageOptions = {}): LinkageSummary {
  const horizon = opts.horizon ?? 5
  const minSources = opts.minSources ?? 3
  const windowDays = opts.windowDays ?? 60

  const span = db
    .prepare('SELECT MIN(date(published_at)) AS a, MAX(date(published_at)) AS b FROM articles WHERE ai_relevant = 1')
    .get() as { a: string | null; b: string | null } | undefined

  const since = new Date(Date.now() - windowDays * 86_400_000).toISOString().slice(0, 10)
  const raw = rawEvents(db, since, minSources)
  const nasdaq = loadSeries(db, 'nasdaq')
  const priceCache = new Map<string, SeriesData>()

  const items: LinkageEvent[] = []
  for (const e of raw) {
    const symbol = symbolOfEntity(e.entity)
    if (!symbol) continue
    let prices = priceCache.get(symbol)
    if (!prices) {
      const rows = loadPrices(db, symbol)
      prices = { dates: rows.map((r) => r.date), values: rows.map((r) => r.close) }
      priceCache.set(symbol, prices)
    }
    if (prices.dates.length === 0) continue

    // 当日超额：事件日（或其后第一个交易日）相对前一日
    const ti = firstIndexAtOrAfter(prices.dates, e.date)
    const ni = firstIndexAtOrAfter(nasdaq.dates, e.date)
    let sameDayExcess: number | null = null
    if (ti > 0 && ni > 0) {
      const s0 = prices.values[ti - 1]
      const s1 = prices.values[ti]
      const n0 = nasdaq.values[ni - 1]
      const n1 = nasdaq.values[ni]
      if (s0 > 0 && n0 > 0) sameDayExcess = s1 / s0 - n1 / n0
    }

    const stockReturn = forwardReturn(prices, e.date, horizon)
    const indexReturn = forwardReturn(nasdaq, e.date, horizon)
    const excessReturn =
      stockReturn !== null && indexReturn !== null ? stockReturn - indexReturn : null

    items.push({
      date: e.date,
      symbol,
      entity: e.entity,
      sources: Number(e.sources),
      mentions: Number(e.mentions),
      sameDayExcess,
      stockReturn,
      indexReturn,
      excessReturn,
      reason:
        stockReturn === null
          ? '事件日之后交易日不足，窗口未走完'
          : indexReturn === null
            ? '同期纳指数据缺失'
            : null,
    })
  }

  items.sort((a, b) => b.date.localeCompare(a.date))

  // 无法映射到上市公司的实体（按提及数）
  const unmappedMap = new Map<string, { mentions: number; sources: number }>()
  for (const e of raw) {
    if (symbolOfEntity(e.entity)) continue
    const cur = unmappedMap.get(e.entity) ?? { mentions: 0, sources: 0 }
    unmappedMap.set(e.entity, {
      mentions: cur.mentions + Number(e.mentions),
      sources: Math.max(cur.sources, Number(e.sources)),
    })
  }
  const unmappedTop = [...unmappedMap.entries()]
    .map(([entity, v]) => ({ entity, ...v }))
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 8)

  const stat = (vals: number[]): { evaluated: number; avg: number | null; median: number | null; winRate: number | null } => {
    if (vals.length === 0) return { evaluated: 0, avg: null, median: null, winRate: null }
    const sorted = [...vals].sort((a, b) => a - b)
    const avg = sorted.reduce((s, v) => s + v, 0) / sorted.length
    const median =
      sorted.length % 2 === 1
        ? sorted[(sorted.length - 1) / 2]
        : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    return {
      evaluated: sorted.length,
      avg: Number(avg.toFixed(4)),
      median: Number(median.toFixed(4)),
      winRate: Number((sorted.filter((v) => v > 0).length / sorted.length).toFixed(3)),
    }
  }
  const sameDay = stat(items.map((i) => i.sameDayExcess).filter((v): v is number => v !== null))
  const forward = stat(items.map((i) => i.excessReturn).filter((v): v is number => v !== null))
  const evaluated = items.filter((i) => i.excessReturn !== null)

  // 按标的汇总
  const bySymMap = new Map<string, LinkageEvent[]>()
  for (const i of items) {
    if (!bySymMap.has(i.symbol)) bySymMap.set(i.symbol, [])
    bySymMap.get(i.symbol)!.push(i)
  }
  const bySymbol = [...bySymMap.entries()]
    .map(([symbol, list]) => {
      const ev = list.filter((x) => x.excessReturn !== null)
      const arr = ev.map((x) => x.excessReturn as number)
      return {
        symbol,
        events: list.length,
        evaluated: ev.length,
        avgExcess: arr.length > 0 ? arr.reduce((s, v) => s + v, 0) / arr.length : null,
        winRate: arr.length > 0 ? arr.filter((v) => v > 0).length / arr.length : null,
      }
    })
    .sort((a, b) => b.evaluated - a.evaluated)

  /*
   * 样本门槛：<30 个可评估事件时，任何均值/胜率都在噪声范围内。
   * 这不是保守 —— 30 个事件、每次 5 日窗口，已经是最低限度的可读样本。
   */
  const MIN_EVENTS = 30
  const sufficient = evaluated.length >= MIN_EVENTS

  const unmappedNote =
    unmappedTop.length > 0
      ? `另有 ${unmappedMap.size} 个高频实体无法映射到上市公司（如 ${unmappedTop
          .slice(0, 3)
          .map((u) => u.entity)
          .join('、')}）—— 它们没有股票可联动。`
      : ''
  const note = sufficient
    ? `已评估 ${evaluated.length} 个事件，可做初步观察（仍需更多独立事件才能下结论）`
    : `仅 ${evaluated.length} 个可评估事件（门槛 ${MIN_EVENTS}）—— 当前样本量不足以判断跨源确认是否带来超额收益。` +
      '下面的事件明细可以看，但**不要从均值/胜率里读结论**。'

  return {
    horizon,
    minSources,
    windowDays,
    newsFrom: span?.a ?? null,
    newsTo: span?.b ?? null,
    rawEvents: raw.length,
    mappedEvents: items.length,
    evaluated: evaluated.length,
    sameDay,
    forward,
    unmappedTop,
    sufficient,
    note: note + unmappedNote,
    bySymbol,
    items: items.slice(0, 60),
  }
}
