import type { DatabaseSync } from 'node:sqlite'
import type { MacroSnapshot } from './macro.ts'
import { seriesCoverage } from './macroHistory.ts'
import type { NarrativeInputs } from './narrative.ts'

/**
 * 风险数据质量 / 可信度（v0.28.0 新增）
 *
 * 解决的问题：页面上的「风险分 58」可能是"真的偏高"，也可能是"样本太少算出来的噪声"。
 * 两者长得一模一样，用户无法区分。这里把**数据够不够算**独立成一组可解释指标，
 * 明确回答：哪些项真的算出来了、哪些因为缺数据没算。
 *
 * 注意：可信度**不是**风险分的另一种说法，它只衡量"这组输入支不支持这个结论"。
 */

export interface QualitySeries {
  key: string
  label: string
  asOf: string | null
  rows: number
  from: string | null
  to: string | null
  ok: boolean
}

export interface RiskQuality {
  /** 0~100 综合可信度 */
  score: number
  level: 'high' | 'medium' | 'low'
  news: {
    articles: number
    /** 窗口内独立信源数 */
    independentSources: number
    /** 情感判定覆盖率 0~1 */
    sentimentCoverage: number
    /** 实体抽取覆盖率 0~1 */
    entityCoverage: number
    minSamples: number
    ok: boolean
  }
  macro: {
    series: QualitySeries[]
    /** 最新宏观数据距今天数 */
    staleDays: number | null
    missing: string[]
    ok: boolean
  }
  /** 因为缺数据而没参与计算的项（"没算" ≠ "0 分"） */
  unavailable: string[]
  notes: string[]
}

const MIN_SAMPLES = 20

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

export function assessQuality(
  db: DatabaseSync,
  opts: { days: number; now: number; inputs: NarrativeInputs; macro: MacroSnapshot },
): RiskQuality {
  const { inputs, macro, days, now } = opts
  const cutoff = new Date(now - days * 86_400_000).toISOString()

  const srcRow = db
    .prepare(
      `SELECT COUNT(DISTINCT r.source_id) AS n
         FROM articles a JOIN raw_items r ON r.id = a.raw_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ?`,
    )
    .get(cutoff) as { n: number } | undefined
  const independentSources = Number(srcRow?.n ?? 0)

  const entRow = db
    .prepare(
      `SELECT SUM(CASE WHEN a.entities IS NOT NULL AND a.entities != '[]' THEN 1 ELSE 0 END) AS withEnt,
              COUNT(*) AS total
         FROM articles a
        WHERE a.ai_relevant = 1 AND a.published_at >= ?`,
    )
    .get(cutoff) as { withEnt: number | null; total: number } | undefined
  const entityCoverage = entRow && entRow.total > 0 ? Number(entRow.withEnt ?? 0) / entRow.total : 0
  const sentimentCoverage = inputs.articles > 0 ? inputs.classified / inputs.articles : 0

  const coverage = new Map(seriesCoverage(db).map((c) => [c.series, c]))
  const series: QualitySeries[] = Object.entries(macro.series).map(([key, p]) => {
    const c = coverage.get(key)
    return {
      key,
      label: p.label,
      asOf: p.asOf,
      rows: c?.rows ?? 0,
      from: c?.from ?? null,
      to: c?.to ?? null,
      ok: true,
    }
  })
  // 配了但没拉到的序列也列出来（明确"缺"而不是静默消失）
  for (const key of ['rates10y', 'rates2y', 'creditSpread', 'nasdaq']) {
    if (series.some((s) => s.key === key)) continue
    const c = coverage.get(key)
    series.push({ key, label: key, asOf: null, rows: c?.rows ?? 0, from: c?.from ?? null, to: c?.to ?? null, ok: false })
  }

  const asOfDates = series.map((s) => s.asOf).filter((d): d is string => Boolean(d)).sort()
  const latestMacro = asOfDates.length > 0 ? asOfDates[asOfDates.length - 1] : null
  const staleDays = latestMacro ? Math.round((now - Date.parse(latestMacro)) / 86_400_000) : null

  const unavailable: string[] = []
  if (inputs.articles < MIN_SAMPLES) unavailable.push(`新闻样本不足（${inputs.articles} < ${MIN_SAMPLES} 条），NFI 不计算`)
  if (inputs.classified === 0) unavailable.push('情感判定尚未回填，情绪偏正度不参与加权')
  if (inputs.concentration === null) unavailable.push('实体抽取为空，叙事集中度不参与加权')
  if (inputs.acceleration === null) unavailable.push('基期样本不足，热度加速度不参与加权')
  if (!macro.available) unavailable.push('宏观数据全部缺失，CRS 不计算')
  for (const m of macro.missing) unavailable.push(`宏观序列缺失：${m}`)
  if (series.some((s) => s.key === 'creditSpread' && s.rows < 250)) {
    unavailable.push('信用利差历史不足 1 年，其分位数参考意义有限')
  }

  // 四个维度各自 0~1
  const newsScore = clamp01(inputs.articles / 100)
  const sourceScore = clamp01(independentSources / 5)
  const sentimentScore = clamp01(sentimentCoverage / 0.8)
  const macroOkCount = series.filter((s) => s.ok).length
  const freshness = staleDays === null ? 0 : clamp01(1 - Math.max(0, staleDays - 2) / 10)
  const macroScore = clamp01((macroOkCount / 4) * 0.6 + freshness * 0.4)

  const score = Math.round(100 * (0.3 * newsScore + 0.2 * sourceScore + 0.2 * sentimentScore + 0.3 * macroScore))
  const level: RiskQuality['level'] = score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low'

  const notes: string[] = []
  if (staleDays !== null && staleDays > 5) notes.push(`宏观数据已滞后 ${staleDays} 天，结论可能过时`)
  if (independentSources < 3) notes.push(`窗口内仅 ${independentSources} 个独立信源，叙事类指标易受单源影响`)
  if (sentimentCoverage < 0.5 && inputs.articles > 0) {
    notes.push(`情感覆盖率 ${(sentimentCoverage * 100).toFixed(0)}%，情绪分项代表性有限`)
  }
  if (level === 'low') notes.push('整体可信度偏低：请把结论当作"方向提示"，不要当作精确读数')

  return {
    score,
    level,
    news: {
      articles: inputs.articles,
      independentSources,
      sentimentCoverage: Number(sentimentCoverage.toFixed(3)),
      entityCoverage: Number(entityCoverage.toFixed(3)),
      minSamples: MIN_SAMPLES,
      ok: inputs.articles >= MIN_SAMPLES,
    },
    macro: { series, staleDays, missing: macro.missing, ok: macroOkCount >= 3 && (staleDays ?? 99) <= 7 },
    unavailable,
    notes,
  }
}
