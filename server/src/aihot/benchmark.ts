import type { DatabaseSync } from 'node:sqlite'
import { normalizeUrl } from '../collector/fingerprint.ts'
import { fetchItems, type AihotItem } from './client.ts'

/**
 * AIHOT 外部基准对照（v0.32.0）
 *
 * ## 为什么不把 AIHOT 当第 27 个采集源
 *
 * 1. **会污染本项目的核心指标**：跨源交叉度算的是"同一事件被几家独立源报道"。
 *    AIHOT 本身是聚合器，把它当"一个源"会让交叉度虚高；按它的 source 展开，
 *    又会和我们已有的源重复（同一篇文章两边都收）。
 * 2. **会打乱事件聚类**：它的标题是改写过的中文，与原文标题不同名，SimHash 会把同一事件
 *    判成两条，跨源事件数直接失真。
 * 3. **它的源包含 X 账号**：那是我们明确不抓的（不绕反爬）。
 *
 * ## 那接它做什么
 *
 * 当**独立的第二评判者**，回答一个之前没法回答的问题：**我们的精选准不准？**
 *
 * 之前 GPT 评审说"缺少人工标注样本，无法量化选品质量"。现在有了一个免费的、
 * 独立标准的对照：它选了什么、我们选了什么、分歧在哪。
 *
 * ⚠️ 它**不是 ground truth**：它是另一个团队的标准。所以只能做"一致性/分歧分析"，
 *    不能算"准确率"。报告里必须这么写。
 *
 * ## 合规
 *
 * - 匿名只读、个人使用免费（对外商业或再分发需书面授权）
 * - 只存标题 + 摘要 + 链接，不存正文
 * - 保留 attribution（条目自带 name/url），界面必须显示来源
 * - 请求遵守官方节奏：ETag 复用、同端点 ≥60s、429 按 Retry-After 等待
 */

/** 我们的分类 → AIHOT 的分类（用于一致性比较；other 不参与） */
export const CATEGORY_MAP: Record<string, string> = {
  model_release: 'ai-models',
  product_update: 'ai-products',
  open_source: 'ai-products',
  research_paper: 'paper',
  funding: 'industry',
  policy: 'industry',
  opinion: 'opinion',
}

export interface MatchSample {
  title: string
  source: string
  url: string
  aihotScore: number
  aihotCategory: string
  ourScore: number
  ourCategory: string
  categoryAgree: boolean
}

export interface BenchmarkResult {
  generatedAt: string
  window: { from: string; to: string; hours: number }
  aihot: {
    count: number
    categories: Record<string, number>
    /** 来源分布：用它反推"我们缺哪些官方源" */
    bySource: Record<string, number>
    sources: number
    /** 请求数（含翻页）与是否命中 304 */
    requests: number
    notModified: boolean
  }
  ours: {
    count: number
    /** 达到精选门槛的条数 */
    highScore: number
    minScore: number
  }
  overlap: {
    matched: number
    onlyAihot: number
    onlyOurs: number
    /** 我们覆盖了 AIHOT 精选的比例 */
    coverageOfAihot: number
    /** AIHOT 覆盖了我们精选的比例 */
    coverageOfOurs: number
  }
  /** 匹配上的条目里，分类一致的比例（口径映射后） */
  categoryAgreement: number | null
  /** 匹配上的条目里，两边分数的秩相关（-1~1） */
  scoreRankCorrelation: number | null
  /** 典型分歧样本，便于人工看 */
  samples: {
    onlyAihot: { title: string; source: string; category: string; score: number }[]
    onlyOurs: { title: string; source: string; category: string; score: number }[]
    matched: MatchSample[]
  }
  notes: string[]
}

export interface OurRow {
  url: string
  title: string
  score: number
  category: string
  published_at: string
  source_name: string
}

/** 秩相关（Spearman）：对异常值不敏感，适合两个不同量纲的分数 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length
  if (n < 3) return null
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
    const r = new Array<number>(n)
    let i = 0
    while (i < n) {
      let j = i
      while (j + 1 < n && idx[j + 1].v === idx[i].v) j += 1
      const avg = (i + j) / 2 + 1
      for (let k = i; k <= j; k++) r[idx[k].i] = avg
      i = j + 1
    }
    return r
  }
  const rx = rank(xs)
  const ry = rank(ys)
  const mean = (a: number[]): number => a.reduce((s, v) => s + v, 0) / a.length
  const mx = mean(rx)
  const my = mean(ry)
  let num = 0
  let dx = 0
  let dy = 0
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mx) * (ry[i] - my)
    dx += (rx[i] - mx) ** 2
    dy += (ry[i] - my) ** 2
  }
  if (dx === 0 || dy === 0) return null
  return num / Math.sqrt(dx * dy)
}

/** URL 比较用的归一：在项目既有 normalizeUrl 之上再抹掉协议与 www 差异 */
export function compareKey(rawUrl: string): string {
  const n = normalizeUrl(rawUrl)
  try {
    const u = new URL(n)
    const host = u.host.replace(/^www\./, '').toLowerCase()
    const path = u.pathname.replace(/\/+$/, '')
    return `${host}${path}${u.search}`
  } catch {
    return n.toLowerCase()
  }
}

export interface CompareResult {
  matched: MatchSample[]
  onlyAihot: AihotItem[]
  onlyOurs: OurRow[]
  oursHigh: OurRow[]
  categoryAgreement: number | null
  scoreRankCorrelation: number | null
}

/**
 * 纯函数：把两边条目按「原文 URL」对齐后算重合度。
 * 抽出来是为了能单测 —— 匹配逻辑一旦写错（比如归一化不彻底），
 * 重合度会静默变成 0，看起来像"我们全漏了"。
 */
export function compareBenchmark(aihotItems: AihotItem[], ourRows: OurRow[], minScore: number): CompareResult {
  const oursByKey = new Map<string, OurRow>()
  for (const r of ourRows) oursByKey.set(compareKey(r.url), r)

  const aihotByKey = new Map<string, AihotItem>()
  for (const it of aihotItems) {
    const k = compareKey(it.url)
    if (!aihotByKey.has(k)) aihotByKey.set(k, it)
  }

  const matched: MatchSample[] = []
  const onlyAihot: AihotItem[] = []
  for (const [k, it] of aihotByKey) {
    const ours = oursByKey.get(k)
    if (!ours) {
      onlyAihot.push(it)
      continue
    }
    const mapped = CATEGORY_MAP[ours.category] ?? null
    matched.push({
      title: ours.title,
      source: it.source,
      url: it.url,
      aihotScore: it.score,
      aihotCategory: it.category,
      ourScore: Number(ours.score),
      ourCategory: ours.category,
      categoryAgree: mapped === it.category,
    })
  }

  const oursHigh = ourRows.filter((r) => Number(r.score) >= minScore)
  const onlyOurs = oursHigh.filter((r) => !aihotByKey.has(compareKey(r.url)))

  const comparable = matched.filter((m) => CATEGORY_MAP[m.ourCategory])
  const categoryAgreement =
    comparable.length > 0 ? comparable.filter((m) => m.categoryAgree).length / comparable.length : null

  const rho = spearman(
    matched.map((m) => m.aihotScore),
    matched.map((m) => m.ourScore),
  )

  return {
    matched,
    onlyAihot,
    onlyOurs,
    oursHigh,
    categoryAgreement: categoryAgreement === null ? null : Number(categoryAgreement.toFixed(3)),
    scoreRankCorrelation: rho === null ? null : Number(rho.toFixed(3)),
  }
}

export interface BenchmarkOptions {
  db: DatabaseSync
  /** 对照窗口（小时），默认 24 */
  hours?: number
  /** 我方"精选"门槛，默认 45（与日报分区门槛一致） */
  minScore?: number
  /** 最多翻几页 */
  maxPages?: number
}

export async function runBenchmark(opts: BenchmarkOptions): Promise<BenchmarkResult> {
  const hours = opts.hours ?? 24
  const minScore = opts.minScore ?? 45
  const now = Date.now()
  const from = new Date(now - hours * 3_600_000)

  const aihot = await fetchItems({ window: hours <= 24 ? '24h' : '7d', limit: 50, maxPages: opts.maxPages ?? 4 })

  const rows = opts.db
    .prepare(
      `SELECT a.url, a.title, COALESCE(a.score, 0) AS score, a.category, a.published_at,
              COALESCE(s.name, '未知') AS source_name
         FROM articles a
         LEFT JOIN raw_items r ON r.id = a.raw_id
         LEFT JOIN sources s ON s.id = r.source_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ?
        ORDER BY a.published_at DESC`,
    )
    .all(from.toISOString()) as unknown as OurRow[]

  const cmp = compareBenchmark(aihot.items, rows, minScore)
  const { matched, onlyAihot, onlyOurs, oursHigh, categoryAgreement } = cmp

  const cats: Record<string, number> = {}
  for (const it of aihot.items) cats[it.category] = (cats[it.category] ?? 0) + 1

  const notes: string[] = []
  notes.push('AIHOT 是独立的第二标准，不是 ground truth —— 只能看一致性/分歧，不能算准确率')
  if (aihot.notModified) notes.push('本次命中 ETag 304，用的是缓存结果')
  if (aihot.items.length === 0) notes.push('AIHOT 未返回条目（可能限流或窗口内无精选）')
  if (rows.length === 0) notes.push('本站该窗口内无成品条目，无法对照 —— 先跑采集与加工')

  return {
    generatedAt: new Date().toISOString(),
    window: { from: from.toISOString(), to: new Date(now).toISOString(), hours },
    aihot: {
      count: aihot.items.length,
      categories: cats,
      bySource: Object.fromEntries(
        [...new Set(aihot.items.map((i) => i.source))]
          .map((s) => [s, aihot.items.filter((i) => i.source === s).length] as const)
          .sort((a, b) => b[1] - a[1]),
      ),
      sources: new Set(aihot.items.map((i) => i.source)).size,
      requests: aihot.requests,
      notModified: aihot.notModified,
    },
    ours: { count: rows.length, highScore: oursHigh.length, minScore },
    overlap: {
      matched: matched.length,
      onlyAihot: onlyAihot.length,
      onlyOurs: onlyOurs.length,
      coverageOfAihot: aihot.items.length > 0 ? Number((matched.length / aihot.items.length).toFixed(3)) : 0,
      coverageOfOurs: oursHigh.length > 0 ? Number((matched.length / oursHigh.length).toFixed(3)) : 0,
    },
    categoryAgreement,
    scoreRankCorrelation: cmp.scoreRankCorrelation,
    samples: {
      onlyAihot: onlyAihot.slice(0, 8).map((i) => ({
        title: i.title,
        source: i.source,
        category: i.category,
        score: i.score,
      })),
      onlyOurs: onlyOurs.slice(0, 8).map((r) => ({
        title: r.title,
        source: r.source_name,
        category: r.category,
        score: Number(r.score),
      })),
      matched: matched.slice(0, 8),
    },
    notes,
  }
}

/* ============================ 每日快照（v0.34.0） ============================ */

/**
 * 落库：一天一条，重复跑覆盖同一天。
 *
 * 为什么存快照而不只跑 CLI：单次对照只能看"今天重合多少"，看不出"改源之后有没有变好"。
 * 有了日序列，才能回答"这次扩源到底有没有用"——v0.33.0 那次就是从 14% 提到 26%。
 */
export function saveBenchmark(db: DatabaseSync, r: BenchmarkResult, date: string): void {
  db.prepare(
    `INSERT INTO aihot_benchmark
       (date, generated_at, aihot_count, ours_count, ours_high, matched,
        coverage_of_aihot, coverage_of_ours, category_agreement, rank_corr, payload)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       generated_at = excluded.generated_at,
       aihot_count = excluded.aihot_count,
       ours_count = excluded.ours_count,
       ours_high = excluded.ours_high,
       matched = excluded.matched,
       coverage_of_aihot = excluded.coverage_of_aihot,
       coverage_of_ours = excluded.coverage_of_ours,
       category_agreement = excluded.category_agreement,
       rank_corr = excluded.rank_corr,
       payload = excluded.payload`,
  ).run(
    date,
    r.generatedAt,
    r.aihot.count,
    r.ours.count,
    r.ours.highScore,
    r.overlap.matched,
    r.overlap.coverageOfAihot,
    r.overlap.coverageOfOurs,
    r.categoryAgreement,
    r.scoreRankCorrelation,
    JSON.stringify(r),
  )
}

export interface BenchmarkTrendRow {
  date: string
  aihotCount: number
  oursCount: number
  oursHigh: number
  matched: number
  coverageOfAihot: number | null
  coverageOfOurs: number | null
  categoryAgreement: number | null
  rankCorr: number | null
}

/** 近 N 天的对照趋势（升序，便于直接画折线） */
export function benchmarkTrend(db: DatabaseSync, days = 30): BenchmarkTrendRow[] {
  const rows = db
    .prepare(
      `SELECT date, aihot_count, ours_count, ours_high, matched,
              coverage_of_aihot, coverage_of_ours, category_agreement, rank_corr
         FROM aihot_benchmark ORDER BY date DESC LIMIT ?`,
    )
    .all(days) as unknown as {
    date: string
    aihot_count: number
    ours_count: number
    ours_high: number
    matched: number
    coverage_of_aihot: number | null
    coverage_of_ours: number | null
    category_agreement: number | null
    rank_corr: number | null
  }[]
  return rows.reverse().map((r) => ({
    date: r.date,
    aihotCount: Number(r.aihot_count),
    oursCount: Number(r.ours_count),
    oursHigh: Number(r.ours_high),
    matched: Number(r.matched),
    coverageOfAihot: r.coverage_of_aihot === null ? null : Number(r.coverage_of_aihot),
    coverageOfOurs: r.coverage_of_ours === null ? null : Number(r.coverage_of_ours),
    categoryAgreement: r.category_agreement === null ? null : Number(r.category_agreement),
    rankCorr: r.rank_corr === null ? null : Number(r.rank_corr),
  }))
}
