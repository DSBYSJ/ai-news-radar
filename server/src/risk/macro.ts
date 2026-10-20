/**
 * 宏观数据接入（可选）
 *
 * 为什么单独一层：**危机风险必须有市场数据**（利率、信用利差、指数位置）。
 * 新闻只能算"叙事温度"，算不出"估值是否过高"。
 *
 * 设计成「可插拔 + 明确缺失」：
 *   - 配了 FRED_API_KEY 且能连通 → 拉 10Y 国债、高收益债利差、纳斯达克指数
 *   - 没配 / 拉不到 / 超时 → 返回 available=false 且列出缺哪些，上层**不出危机概率**
 *     （而不是拿 0 填上、算出一个看起来很精确的假数字）
 */

export interface MacroPoint {
  key: string
  label: string
  /** 最新值 */
  value: number
  /** 数据日期（YYYY-MM-DD） */
  asOf: string
  /** 一年前值（用于算变化；没有则为 null） */
  yearAgo: number | null
  /** 200 日均值（指数用；其它为 null） */
  avg200: number | null
  source: string
}

export interface MacroSnapshot {
  available: boolean
  /** 缺哪些（给前端展示"为什么没有危机概率"） */
  missing: string[]
  series: Record<string, MacroPoint>
  notes: string[]
  fetchedAt: string
}

const TIMEOUT_MS = 8000

interface FredObservation {
  date: string
  value: string
}

/** 拉 FRED 单序列（最近 N 个观测，按时间倒序） */
async function fredSeries(seriesId: string, apiKey: string, limit: number): Promise<FredObservation[]> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=${limit}`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`FRED ${seriesId} HTTP ${res.status}`)
  const json = (await res.json()) as { observations?: FredObservation[] }
  return (json.observations ?? []).filter((o) => o.value !== '.')
}

function parseNum(s: string): number {
  return Number.parseFloat(s)
}

/** 取第 n 个观测（0 = 最新）；不足则 null */
function at(obs: FredObservation[], n: number): MacroPoint['yearAgo'] {
  const o = obs[n]
  if (!o) return null
  const v = parseNum(o.value)
  return Number.isFinite(v) ? v : null
}

/**
 * 读取宏观快照。
 * @param apiKey FRED API Key；为空则直接返回不可用（不发起网络请求）
 */
export async function loadMacro(apiKey: string | undefined): Promise<MacroSnapshot> {
  const fetchedAt = new Date().toISOString()
  const missing: string[] = []
  const notes: string[] = []
  const series: Record<string, MacroPoint> = {}

  if (!apiKey) {
    return {
      available: false,
      missing: ['10 年期美债收益率', '高收益债信用利差', '纳斯达克指数'],
      series,
      notes: [
        '未配置 FRED_API_KEY，模块不会输出「危机概率」——',
        '用新闻数据算危机概率是不成立的，宁可缺，也不编。',
      ],
      fetchedAt,
    }
  }

  // 10 年期国债（日频；260 个交易日≈1 年）
  try {
    const obs = await fredSeries('DGS10', apiKey, 300)
    const value = at(obs, 0)
    if (value !== null) {
      series.rates10y = {
        key: 'rates10y',
        label: '10 年期美债收益率',
        value,
        asOf: obs[0].date,
        yearAgo: at(obs, Math.min(obs.length - 1, 250)),
        avg200: null,
        source: 'FRED DGS10',
      }
    } else {
      missing.push('10 年期美债收益率')
    }
  } catch (err) {
    missing.push('10 年期美债收益率')
    notes.push(`DGS10 拉取失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 高收益债 OAS（信用利差）
  try {
    const obs = await fredSeries('BAMLH0A0HYM2', apiKey, 300)
    const value = at(obs, 0)
    if (value !== null) {
      series.creditSpread = {
        key: 'creditSpread',
        label: '高收益债信用利差（OAS）',
        value,
        asOf: obs[0].date,
        yearAgo: at(obs, Math.min(obs.length - 1, 250)),
        avg200: null,
        source: 'FRED BAMLH0A0HYM2',
      }
    } else {
      missing.push('高收益债信用利差')
    }
  } catch (err) {
    missing.push('高收益债信用利差')
    notes.push(`信用利差拉取失败：${err instanceof Error ? err.message : String(err)}`)
  }

  // 纳斯达克综合指数
  try {
    const obs = await fredSeries('NASDAQCOM', apiKey, 300)
    const value = at(obs, 0)
    if (value !== null) {
      const vals = obs.slice(0, 200).map((o) => parseNum(o.value)).filter(Number.isFinite)
      series.nasdaq = {
        key: 'nasdaq',
        label: '纳斯达克综合指数',
        value,
        asOf: obs[0].date,
        yearAgo: at(obs, Math.min(obs.length - 1, 250)),
        avg200: vals.length >= 60 ? vals.reduce((a, b) => a + b, 0) / vals.length : null,
        source: 'FRED NASDAQCOM',
      }
    } else {
      missing.push('纳斯达克指数')
    }
  } catch (err) {
    missing.push('纳斯达克指数')
    notes.push(`指数拉取失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const available = Object.keys(series).length > 0
  if (!available) {
    notes.push('宏观数据全部拉取失败（可能是境内网络无法访问 FRED），本次不输出危机概率。')
  }
  return { available, missing, series, notes, fetchedAt }
}
