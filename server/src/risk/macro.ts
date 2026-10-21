/**
 * 宏观数据接入（免 API key 也能用）
 *
 * 为什么单独一层：**危机风险必须有市场数据**（利率、信用利差、指数位置）。
 * 新闻只能算"叙事温度"，算不出"资产多贵"。
 *
 * 数据源（按优先级）：
 *   1. FRED 的 CSV 下载 `fredgraph.csv?id=<ID>` —— **不需要 API key**（境内实测可达，~2s）
 *   2. FRED JSON API —— 需要 key，仅在 CSV 失败且配了 key 时兜底
 *   3. 都没有 → available=false，明确列出缺哪几项，上层**不出危机概率**
 *      （而不是拿 0 填上、算出一个看起来很精确的假数字）
 *
 * 序列：
 *   DGS10           10 年期美债收益率（%）
 *   BAMLH0A0HYM2    高收益债信用利差 OAS（%）
 *   NASDAQCOM       纳斯达克综合指数
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
  /** 200 个观测的均值（指数用；其它为 null） */
  avg200: number | null
  /** 52 周最高值（算回撤用；指数用） */
  high52w: number | null
  /** 历史序列（分位数 / Z-Score 用；由长历史 CSV 取得） */
  history: number[]
  /**
   * 与 history 一一对应的真实观测日期（v0.28.0 新增）。
   * 早期版本没有这个字段，回填 macro_history 时按「末尾日期倒推一天」伪造日期，
   * 把 20 年数据压进了 13.7 年 —— 那批历史日期不可信，必须靠这个字段重写。
   */
  dates: string[]
  source: string
}

export interface MacroSnapshot {
  available: boolean
  /** 缺哪些（给前端展示"为什么没有危机概率"） */
  missing: string[]
  series: Record<string, MacroPoint>
  /** 收益率曲线是否倒挂（2Y > 10Y）；无数据为 null */
  inversion: boolean | null
  notes: string[]
  fetchedAt: string
}

const TIMEOUT_MS = 12_000

interface Observation {
  date: string
  value: number
}

/** 解析 FRED 的 CSV（两列：observation_date, 值；缺值为 "."） */
function parseFredCsv(text: string): Observation[] {
  const out: Observation[] = []
  const lines = text.split('\n')
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const comma = line.indexOf(',')
    if (comma <= 0) continue
    const date = line.slice(0, comma).trim()
    const raw = line.slice(comma + 1).trim()
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const value = Number.parseFloat(raw)
    if (!Number.isFinite(value)) continue
    out.push({ date, value })
  }
  return out
}

/** 取离目标日期最近的观测（一年前用） */
function nearest(obs: Observation[], target: string): number | null {
  if (obs.length === 0) return null
  const t = Date.parse(target)
  let best: Observation | null = null
  let bestDiff = Infinity
  for (const o of obs) {
    const d = Math.abs(Date.parse(o.date) - t)
    if (d < bestDiff) {
      bestDiff = d
      best = o
    }
  }
  // 相差超过 30 天视为缺失
  return best && bestDiff <= 30 * 86_400_000 ? best.value : null
}

async function fetchFredCsv(seriesId: string, years = 20): Promise<Observation[]> {
  // cosd = 起始日期：默认拉 20 年（分位数需要长历史；DGS10 全量有 269KB / 1962 年至今）
  const cosd = new Date(Date.now() - years * 365 * 86_400_000).toISOString().slice(0, 10)
  const url = `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${encodeURIComponent(seriesId)}&cosd=${cosd}`
  const res = await fetch(url, {
    headers: { 'user-agent': 'ai-news-radar/0.1 (personal feed reader)' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`FRED CSV ${seriesId} HTTP ${res.status}`)
  return parseFredCsv(await res.text())
}

/** 兜底：FRED JSON API（需要 key） */
async function fetchFredApi(seriesId: string, apiKey: string): Promise<Observation[]> {
  const url =
    `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(seriesId)}` +
    `&api_key=${encodeURIComponent(apiKey)}&file_type=json&sort_order=desc&limit=400`
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) })
  if (!res.ok) throw new Error(`FRED API ${seriesId} HTTP ${res.status}`)
  const json = (await res.json()) as { observations?: { date: string; value: string }[] }
  const out: Observation[] = []
  for (const o of json.observations ?? []) {
    const v = Number.parseFloat(o.value)
    if (Number.isFinite(v)) out.push({ date: o.date, value: v })
  }
  return out
}

interface SeriesSpec {
  key: string
  label: string
  id: string
  needAvg200: boolean
}

const SPECS: SeriesSpec[] = [
  { key: 'rates10y', label: '10 年期美债收益率', id: 'DGS10', needAvg200: false },
  { key: 'rates2y', label: '2 年期美债收益率', id: 'DGS2', needAvg200: false },
  { key: 'creditSpread', label: '高收益债信用利差（OAS）', id: 'BAMLH0A0HYM2', needAvg200: false },
  /*
   * 长历史信用利差（Baa 级企业债 − 10Y），v0.28.0 新增。
   * 为什么要它：FRED 的 fredgraph.csv 对 BAMLH0A0HYM2（高收益 OAS）**只返回约 3 年**，
   * 无论 cosd 怎么设都是 793 行 —— 3 年样本做不了跨周期回测。
   * BAA10Y 能给到 2013 年起的完整日序列，因此专门用于历史回测与长周期分位。
   * 注意：两者**水平不可比**（HY OAS 通常 3~8%，Baa-10Y 约 1.4~3.5%），不能混用阈值。
   */
  { key: 'creditSpreadLong', label: 'Baa 级企业债利差（长历史）', id: 'BAA10Y', needAvg200: false },
  { key: 'nasdaq', label: '纳斯达克综合指数', id: 'NASDAQCOM', needAvg200: true },
]

/** 宏观快照缓存：一天只变几个点，30 分钟内复用（避免每次打开页面都等 2–4 秒） */
let cached: { at: number; data: MacroSnapshot } | null = null
const CACHE_TTL_MS = 30 * 60_000

/**
 * 读取宏观快照。
 * @param apiKey 可选的 FRED API Key；CSV 主路径不需要它
 */
export async function loadMacro(apiKey: string | undefined, opts: { force?: boolean } = {}): Promise<MacroSnapshot> {
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return { ...cached.data, notes: [...cached.data.notes, '（30 分钟缓存内，未重新拉取）'] } }
  const fetchedAt = new Date().toISOString()
  const missing: string[] = []
  const notes: string[] = []
  const series: Record<string, MacroPoint> = {}

  // 三个序列并发拉，任一失败不影响其它
  const results = await Promise.all(
    SPECS.map(async (spec) => {
      try {
        const obs = await fetchFredCsv(spec.id)
        if (obs.length === 0) throw new Error('空数据')
        return { spec, obs, via: 'FRED CSV（免 key）' }
      } catch (csvErr) {
        if (!apiKey) return { spec, obs: [] as Observation[], via: '', err: String(csvErr) }
        try {
          const obs = await fetchFredApi(spec.id, apiKey)
          if (obs.length === 0) throw new Error('空数据')
          return { spec, obs, via: 'FRED API' }
        } catch (apiErr) {
          return { spec, obs: [] as Observation[], via: '', err: `${csvErr} / ${apiErr}` }
        }
      }
    }),
  )

  for (const r of results) {
    if (r.obs.length === 0) {
      missing.push(r.spec.label)
      notes.push(`${r.spec.label} 拉取失败${r.err ? `：${r.err}` : ''}`)
      continue
    }
    const obs = r.obs
    const last = obs[obs.length - 1]
    const yearTarget = new Date(Date.parse(last.date) - 365 * 86_400_000).toISOString().slice(0, 10)
    const window200 = obs.slice(-200)
    const window52w = obs.slice(-252)
    series[r.spec.key] = {
      key: r.spec.key,
      label: r.spec.label,
      value: last.value,
      asOf: last.date,
      yearAgo: nearest(obs, yearTarget),
      avg200:
        r.spec.needAvg200 && window200.length >= 60
          ? window200.reduce((a, b) => a + b.value, 0) / window200.length
          : null,
      high52w:
        r.spec.needAvg200 && window52w.length > 0
          ? Math.max(...window52w.map((o) => o.value))
          : null,
      history: obs.map((o) => o.value),
      dates: obs.map((o) => o.date),
      source: `${r.spec.id} · ${r.via}`,
    }
  }

  // 倒挂：2 年期 > 10 年期
  const two = series.rates2y?.value
  const ten = series.rates10y?.value
  const inversion = two !== undefined && ten !== undefined ? two > ten : null

  const available = Object.keys(series).length > 0
  if (!available) {
    notes.push('宏观数据全部拉取失败（可能是网络受限），本次不输出危机概率。')
  } else {
    const dates = Object.values(series).map((s) => s.asOf).sort()
    notes.push(
      `宏观数据源：FRED（免 key 的 CSV 下载）；数据日期 ${dates[0]} ~ ${dates[dates.length - 1]}，滞后 1–2 个交易日属正常。`,
    )
  }
  const snapshot: MacroSnapshot = { available, missing, series, inversion, notes, fetchedAt }
  cached = { at: Date.now(), data: snapshot }
  return snapshot
}
