import type { DatabaseSync } from 'node:sqlite'
import type { MacroSnapshot } from './macro.ts'
import { seriesCoverage } from './macroHistory.ts'
import type { NarrativeInputs } from './narrative.ts'

/**
 * 风险数据质量（v0.29.0 按外部评审意见重写）
 *
 * 旧版做法：把样本量/信源数/覆盖率/滞后加权成一个「可信度 72/100」。
 * 评审指出这是伪精确 —— 一个 0~100 的数字看起来像统计验证过的结论，
 * 实际上权重是拍脑袋定的，而且掩盖了"到底哪一项不够"。
 *
 * 新版做法：**状态标签 + 明确的计算门槛**，不再输出综合分。
 *   sufficient 数据充分 / partial 部分数据 / insufficient 样本不足 / stale 数据过期
 * 每个维度各自给状态与阈值，用户能直接看到是哪一环不满足。
 *
 * 另外：独立信源数 ≠ 文章数。同一事件被 10 家转载不是 10 个独立信号，
 * 所以信源维度单独计算。
 */

export type QualityStatus = 'sufficient' | 'partial' | 'insufficient' | 'stale'

export interface QualityDimension {
  key: string
  label: string
  /** 展示值（已格式化） */
  value: string
  status: QualityStatus
  /** 判定门槛，写在界面上便于核对 */
  rule: string
}

export interface QualitySeries {
  key: string
  label: string
  asOf: string | null
  rows: number
  from: string | null
  to: string | null
  ok: boolean
  /** 是否为代理序列（如用 BAA10Y 代表信用利差），界面必须标出来 */
  proxy?: string
}

export interface RiskQuality {
  /** 最差的那个维度决定整体状态 */
  status: QualityStatus
  headline: string
  dimensions: QualityDimension[]
  macro: {
    series: QualitySeries[]
    staleDays: number | null
    missing: string[]
  }
  /** 因为缺数据而没参与计算的项（"没算" ≠ "0 分"） */
  unavailable: string[]
  notes: string[]
}

const STATUS_LABEL: Record<QualityStatus, string> = {
  sufficient: '数据充分',
  partial: '部分数据',
  insufficient: '样本不足',
  stale: '数据过期',
}

const STATUS_RANK: Record<QualityStatus, number> = {
  sufficient: 0,
  partial: 1,
  stale: 2,
  insufficient: 3,
}

function worst(list: QualityStatus[]): QualityStatus {
  return list.reduce<QualityStatus>((acc, s) => (STATUS_RANK[s] > STATUS_RANK[acc] ? s : acc), 'sufficient')
}

function grade(value: number, okAt: number, partialAt: number): QualityStatus {
  if (value >= okAt) return 'sufficient'
  if (value >= partialAt) return 'partial'
  return 'insufficient'
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
  const PROXY_LABEL: Record<string, string> = {
    creditSpreadLong: '代理序列：Baa 级企业债利差，仅用于长周期回测，不等同于高收益 OAS',
  }
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
      proxy: PROXY_LABEL[key],
    }
  })
  for (const key of ['rates10y', 'rates2y', 'creditSpread', 'nasdaq']) {
    if (series.some((s) => s.key === key)) continue
    const c = coverage.get(key)
    series.push({ key, label: key, asOf: null, rows: c?.rows ?? 0, from: c?.from ?? null, to: c?.to ?? null, ok: false })
  }

  const asOfDates = series.map((s) => s.asOf).filter((d): d is string => Boolean(d)).sort()
  const latestMacro = asOfDates.length > 0 ? asOfDates[asOfDates.length - 1] : null
  const staleDays = latestMacro ? Math.round((now - Date.parse(latestMacro)) / 86_400_000) : null

  const unavailable: string[] = []
  if (inputs.articles < 20) unavailable.push(`新闻样本不足（${inputs.articles} < 20 条），NFI 不计算`)
  if (inputs.classified === 0) unavailable.push('情感判定尚未回填，情绪偏正度不参与加权')
  if (inputs.concentration === null) unavailable.push('实体抽取为空，叙事集中度不参与加权')
  if (inputs.acceleration === null) unavailable.push('基期样本不足，热度加速度不参与加权')
  if (!macro.available) unavailable.push('宏观数据全部缺失，CRS 不计算')
  for (const m of macro.missing) unavailable.push(`宏观序列缺失：${m}`)

  const macroOk = series.filter((s) => s.ok).length
  const creditRows = series.find((s) => s.key === 'creditSpread')?.rows ?? 0
  if (creditRows > 0 && creditRows < 1250) {
    unavailable.push(`高收益债 OAS 历史仅 ${creditRows} 行（约 3 年），其"长期分位"实际只有 3 年参考意义`)
  }

  const dimensions: QualityDimension[] = [
    {
      key: 'news',
      label: '新闻样本',
      value: `${inputs.articles} 条 / ${days} 天`,
      status: grade(inputs.articles, 100, 20),
      rule: '≥100 充分，20–99 部分，<20 不足（不足则不计算 NFI）',
    },
    {
      key: 'sources',
      label: '独立信源',
      value: `${independentSources} 个`,
      status: grade(independentSources, 5, 3),
      rule: '≥5 充分，3–4 部分，<3 不足（转载不等于独立信号）',
    },
    {
      key: 'sentiment',
      label: '情感覆盖',
      value: `${(sentimentCoverage * 100).toFixed(0)}%`,
      status: grade(sentimentCoverage, 0.8, 0.5),
      rule: '≥80% 充分，50–79% 部分，<50% 不足（不足时情绪分项代表性有限）',
    },
    {
      key: 'entities',
      label: '实体覆盖',
      value: `${(entityCoverage * 100).toFixed(0)}%`,
      status: grade(entityCoverage, 0.7, 0.4),
      rule: '≥70% 充分，40–69% 部分，<40% 不足（影响叙事集中度）',
    },
    {
      key: 'macro',
      label: '宏观完整度',
      value: `${macroOk}/4 序列`,
      status: macroOk >= 4 ? 'sufficient' : macroOk >= 3 ? 'partial' : 'insufficient',
      rule: '4 项齐全才输出完整 CRS；缺 2 项以上视为不可用',
    },
    {
      key: 'freshness',
      label: '数据新鲜度',
      value: staleDays === null ? '无数据' : `滞后 ${staleDays} 天`,
      status: staleDays === null ? 'insufficient' : staleDays <= 2 ? 'sufficient' : staleDays <= 7 ? 'partial' : 'stale',
      rule: '≤2 天充分，3–7 天部分，>7 天标记过期',
    },
  ]

  const status = worst(dimensions.map((d) => d.status))
  const bad = dimensions.filter((d) => d.status !== 'sufficient').map((d) => d.label)

  const notes: string[] = []
  if (status === 'stale') notes.push('宏观数据已过期，页面上的分数可能不代表当前状态')
  if (independentSources < 3) notes.push('独立信源过少，叙事类指标容易受单一来源影响')
  if (unavailable.length > 0) notes.push(`有 ${unavailable.length} 项未参与计算，详见下方清单`)

  return {
    status,
    headline:
      status === 'sufficient'
        ? '数据充分：各维度均达标，分数可正常解读'
        : `${STATUS_LABEL[status]}：${bad.join('、')} 未达门槛，解读时请降低确定性`,
    dimensions,
    macro: { series, staleDays, missing: macro.missing },
    unavailable,
    notes,
  }
}

export { STATUS_LABEL }
