
import { setDefaultResultOrder } from 'node:dns'
import { setDefaultAutoSelectFamily } from 'node:net'

/**
 * ⚠️ 必须强制 IPv4 优先：境内服务器上 Node 默认会先试 AAAA 记录，
 * 而 sec.gov 的 IPv6 路由不通（ENETUNREACH），导致 fetch 直接失败；
 * curl 走 IPv4 所以能通 —— 这个差异排查起来很费时间，写在这里避免重踩。
 */
setDefaultResultOrder('ipv4first')
// 光设 ipv4first 不够：Node 22 的 happy-eyeballs 仍会并发尝试 IPv6，
// 而 AAAA 连接失败会让整个请求超时。必须同时关掉自动多地址选择。
setDefaultAutoSelectFamily(false)

/**
 * SEC EDGAR 客户端（v0.36.0）
 *
 * 为什么用 SEC 而不是 FMP 的财务接口：
 *   1. **免费且无需 key** —— FMP 免费档的财报/比率有额度与年限限制
 *   2. **权威** —— 直接来自 10-K/20-F 的 XBRL 事实，不是二次加工的比率
 *   3. 可以自己决定口径（哪一年、用哪个标签），而不是接受别人算好的 P/E
 *
 * SEC 的硬性要求（不是建议）：
 *   - User-Agent 必须能识别调用方，**带联系方式**；不带会被 403
 *   - 限流 10 请求/秒，超了会返回 "Request Rate Threshold Exceeded"
 *   - 所以这里统一 300ms 间隔 + 失败重试一次
 *
 * ⚠️ 我们只用它做**基本面**（营收/净利/权益/股本），不碰价格 ——
 *    价格必须来自行情接口，SEC 不提供。
 */

const SEC_UA =
  process.env.SEC_USER_AGENT ?? 'ai-news-radar/0.36 (personal research project; contact: set SEC_USER_AGENT)'
const THROTTLE_MS = 300
const TIMEOUT_MS = 25_000

let lastCallAt = 0

async function secGet(url: string): Promise<string> {
  const wait = THROTTLE_MS - (Date.now() - lastCallAt)
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
  lastCallAt = Date.now()

  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      headers: {
        'user-agent': SEC_UA,
        accept: 'application/json',
        'accept-encoding': 'gzip, deflate',
      },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })
    if (res.status === 429 || (res.status === 403 && attempt === 0)) {
      await new Promise((r) => setTimeout(r, 2000))
      continue
    }
    if (!res.ok) throw new Error(`SEC ${url} → HTTP ${res.status}`)
    const text = await res.text()
    // SEC 限流时会返回 HTML 而不是 JSON，必须识别出来（否则报"JSON 解析失败"掩盖真因）
    if (text.trimStart().startsWith('<')) {
      if (attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000))
        continue
      }
      throw new Error(`SEC ${url} 返回 HTML（多半是限流，检查 UA 与请求频率）`)
    }
    return text
  }
  throw new Error(`SEC ${url} 连续失败`)
}

export interface TickerEntry {
  cik: string
  ticker: string
  title: string
}

/** ticker → CIK 官方映射（~800KB，一次同步拉一次就够，缓存到内存） */
let tickerCache: Map<string, TickerEntry> | null = null

export async function loadTickerMap(force = false): Promise<Map<string, TickerEntry>> {
  if (tickerCache && !force) return tickerCache
  const text = await secGet('https://www.sec.gov/files/company_tickers.json')
  const json = JSON.parse(text) as Record<string, { cik_str: number; ticker: string; title: string }>
  const map = new Map<string, TickerEntry>()
  for (const v of Object.values(json)) {
    map.set(v.ticker.toUpperCase(), {
      cik: String(v.cik_str).padStart(10, '0'),
      ticker: v.ticker.toUpperCase(),
      title: v.title,
    })
  }
  tickerCache = map
  return map
}

/** XBRL 事实数组里的一条 */
interface Fact {
  start?: string
  end: string
  val: number
  fy?: number
  fp?: string
  form?: string
  filed: string
  frame?: string
}

export interface AnnualFundamentals {
  fiscalEnd: string
  /** 报告期覆盖的天数（用来区分年报/季报，XBRL 里没有直接的 period 字段） */
  days: number
  revenue: number | null
  netIncome: number | null
  equity: number | null
  epsDiluted: number | null
  /** 用于计算市值；SEC 只给"某一时点"的股本，取最近一次申报值 */
  shares: number | null
  filedAt: string
}

/**
 * 营收标签各公司不一致，按"年报条数最多"挑一个主口径。
 * 这是必须处理的现实问题：NVDA 用 Revenues，很多 SaaS 用 RevenueFromContractWithCustomer*。
 */
const REVENUE_TAGS = [
  'Revenues',
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'RevenueFromContractWithCustomerIncludingAssessedTax',
  'SalesRevenueNet',
  'RevenuesNetOfInterestExpense',
  // IFRS 报送人（如台积电 20-F）用另一套命名空间与标签
  'Revenue',
  'RevenueFromContractsWithCustomers',
]

/**
 * 选标签的规则：**最新财年优先，其次条数**。
 *
 * 踩过的坑：亚马逊早年用 SalesRevenueNet/Revenues，2018 年后改用
 * RevenueFromContractWithCustomerExcludingAssessedTax。如果按"条数最多"选，
 * 会选中那个 2017 年就停用的标签，结果"最新财年"显示成 2017 —— 静默错数据。
 */
function pickBestTag(
  namespaces: Record<string, Record<string, { units: Record<string, Fact[]> }>>,
  tags: string[],
): { tag: string; series: Fact[]; ns: string } | null {
  let best: { tag: string; series: Fact[]; ns: string } | null = null
  for (const ns of ['us-gaap', 'ifrs-full']) {
    const facts = namespaces[ns]
    if (!facts) continue
    for (const tag of tags) {
      const series = annualFacts(facts, tag)
      if (series.length === 0) continue
      const latest = series[series.length - 1].end
      if (
        !best ||
        latest > best.series[best.series.length - 1].end ||
        (latest === best.series[best.series.length - 1].end && series.length > best.series.length)
      ) {
        best = { tag, series, ns }
      }
    }
  }
  return best
}

function daysBetween(a?: string, b?: string): number {
  if (!a || !b) return 0
  return Math.round((Date.parse(b) - Date.parse(a)) / 86_400_000)
}

/**
 * 只接受美元计价的事实。
 *
 * 踩过的坑：台积电 20-F 用**新台币**报送，营收 2894B TWD 被当成 2894B USD 加进板块汇总，
 * 直接把"算力芯片"板块营收虚增约 90%。XBRL 的 units 字段能区分，但默认取第一个 unit 就会中招。
 * 没有汇率源之前，非美元一律跳过 —— 宁可缺，不能错。
 */
function pickUnits(units: Record<string, Fact[]>, keys: string[]): Fact[] {
  for (const k of keys) if (units[k]) return units[k]
  return []
}

const USD_UNITS = ['USD', 'USD/shares']
/**
 * ⚠️ 股本的单位是 `shares`，不是 USD。
 *    曾经为了过滤"新台币营收"加了一刀"只收 USD"，结果把股本也一起过滤掉了，
 *    表现为"估值全部缺股本"。所以单位必须按字段类型分开给。
 */
const SHARE_UNITS = ['shares']

/** 取某一标签的"年度"事实：优先 10-K/20-F，且期间长度 350~380 天 */
function annualFacts(
  facts: Record<string, { units: Record<string, Fact[]> }>,
  tag: string,
  unitKeys: string[] = USD_UNITS,
): Fact[] {
  const f = facts[tag]
  if (!f) return []
  const arr = pickUnits(f.units, unitKeys)
  const annual = arr.filter((x) => {
    const d = daysBetween(x.start, x.end)
    return (x.form === '10-K' || x.form === '20-F') && d >= 350 && d <= 380
  })
  // 同一 fiscalEnd 可能被多年年报重复引用 → 取最后申报的那条
  const byEnd = new Map<string, Fact>()
  for (const x of annual) {
    const prev = byEnd.get(x.end)
    if (!prev || x.filed > prev.filed) byEnd.set(x.end, x)
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end))
}

/** 时点型事实（权益/股本）：不限期间长度，取该日期最近申报 */
function instantFacts(
  facts: Record<string, { units: Record<string, Fact[]> }>,
  tag: string,
  unitKeys: string[] = USD_UNITS,
): Fact[] {
  const f = facts[tag]
  if (!f) return []
  const arr = pickUnits(f.units, unitKeys)
  const byEnd = new Map<string, Fact>()
  for (const x of arr) {
    const prev = byEnd.get(x.end)
    if (!prev || x.filed > prev.filed) byEnd.set(x.end, x)
  }
  return [...byEnd.values()].sort((a, b) => a.end.localeCompare(b.end))
}

export interface CompanyFacts {
  cik: string
  entityName: string
  annual: AnnualFundamentals[]
  /** 用了哪个营收标签，写进报告便于核对 */
  revenueTag: string | null
}

/** 拉取并解析一家公司的年度基本面 */
export async function fetchCompanyFundamentals(cik: string): Promise<CompanyFacts> {
  const text = await secGet(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`)
  const json = JSON.parse(text) as {
    entityName?: string
    facts?: Record<string, Record<string, { units: Record<string, Fact[]> }>>
  }
  const namespaces = json.facts ?? {}
  const gaap = namespaces['us-gaap'] ?? {}
  const ifrs = namespaces['ifrs-full'] ?? {}

  const picked = pickBestTag(namespaces, REVENUE_TAGS)
  const revenueTag = picked ? `${picked.ns}:${picked.tag}` : null
  const revenueSeries = picked?.series ?? []

  // 净利/权益也要回退：有的公司只用 "含少数股东权益" 或 "归属普通股股东" 的口径
  const firstNonEmpty = (fns: (() => Fact[])[]): Fact[] => {
    for (const fn of fns) {
      const r = fn()
      if (r.length > 0) return r
    }
    return []
  }
  const netIncome = firstNonEmpty([
    () => annualFacts(gaap, 'NetIncomeLoss'),
    () => annualFacts(gaap, 'NetIncomeLossAvailableToCommonStockholdersBasic'),
    () => annualFacts(gaap, 'ProfitLoss'),
    () => annualFacts(ifrs, 'ProfitLoss'),
  ])
  const eps = firstNonEmpty([() => annualFacts(gaap, 'EarningsPerShareDiluted')])
  const equity = firstNonEmpty([
    () => instantFacts(gaap, 'StockholdersEquity'),
    () => instantFacts(gaap, 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'),
    () => instantFacts(ifrs, 'Equity'),
  ])
  const shares = firstNonEmpty([
    () => instantFacts(gaap, 'CommonStockSharesOutstanding', SHARE_UNITS),
    () => instantFacts(gaap, 'EntityCommonStockSharesOutstanding', SHARE_UNITS),
  ])

  const map = <T>(arr: T[], key: (x: T) => string): Map<string, T> => new Map(arr.map((x) => [key(x), x]))

  const netByEnd = map(netIncome, (x) => x.end)
  const epsByEnd = map(eps, (x) => x.end)
  // 权益/股本取"不晚于该财年末的最近一条"
  const pickLatest = (arr: Fact[], end: string): Fact | null => {
    let best: Fact | null = null
    for (const x of arr) if (x.end <= end) best = x
    return best
  }

  const annual: AnnualFundamentals[] = revenueSeries.map((r) => {
    const eq = pickLatest(equity, r.end)
    const sh = pickLatest(shares, r.end)
    return {
      fiscalEnd: r.end,
      days: daysBetween(r.start, r.end),
      revenue: r.val,
      netIncome: netByEnd.get(r.end)?.val ?? null,
      equity: eq?.val ?? null,
      epsDiluted: epsByEnd.get(r.end)?.val ?? null,
      shares: sh?.val ?? null,
      filedAt: r.filed,
    }
  })

  return { cik, entityName: json.entityName ?? '', annual, revenueTag }
}

export function secUserAgent(): string {
  return SEC_UA
}
