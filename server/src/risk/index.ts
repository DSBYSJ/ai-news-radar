import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { loadMacro, type MacroSnapshot, type MacroPoint } from './macro.ts'
import { narrativeFroth, narrativeInputs, type NarrativeReport } from './narrative.ts'
import { loadParams } from './params.ts'
import {
  computeCrs,
  computeNfi,
  detectDivergences,
  type CrsFactor,
  type CrsResult,
  type Divergence,
  type NfiResult,
  type RiskParams,
} from './calculation.ts'

/**
 * 风险聚合层（v0.26.0 重构）
 *
 * 兼容性：**旧字段一个都不删**（narrative / macro / crisis 的结构保持），
 * 新算法算出的结果放在新字段里并行返回（nfi / waterfall / divergences / vulnerableEntities / params）。
 * 旧字段里的 score 由新引擎计算，前端可以只切到新字段，不影响任何老逻辑。
 */

export interface CrisisAssessment {
  /** 0~100；越大越危险 */
  score: number
  level: 'low' | 'guarded' | 'elevated' | 'high'
  /** 未来 12 个月的危机概率区间（百分比）；无法可靠估计时为 null */
  probability12m: { low: number; high: number; note: string } | null
  factors: CrsFactor[]
}

export interface VulnerableEntity {
  entity: string
  /** 负面提及数 */
  negative: number
  /** 总提及数 */
  mentions: number
  /** 负面占比 0~1 */
  negativeShare: number
  /** 近 7 天 vs 前 7 天提及变化（正=升温） */
  heatChange: number | null
  /** 融资类提及数（缺乏实质融资 → 加分） */
  funding: number
  /** 脆弱性得分 0~100 */
  score: number
  reason: string
}

export interface RiskReport {
  generatedAt: string
  windowDays: number
  /** 旧字段（保留）：叙事指数结构 */
  narrative: NarrativeReport
  /** 旧字段（保留）：宏观快照（新增 history/high52w/inversion） */
  macro: MacroSnapshot
  /** 旧字段（保留）：危机风险分（现在由 v2 引擎算） */
  crisis: CrisisAssessment | null
  // ---- v0.26.0 新增 ----
  /** NFI v2（FOMO + 非线性加速度） */
  nfi: NfiResult | null
  /** 瀑布图归因（基础分 → 各项贡献 → 合计） */
  waterfall: CrsResult['waterfall'] | null
  /** 背离预警 */
  divergences: Divergence[]
  /** 宏观背景下最脆弱的实体（CRS ≥ 50 时才有意义） */
  vulnerableEntities: VulnerableEntity[]
  /** 当前生效的参数（前端 tooltip / 调参面板用） */
  params: RiskParams
  /** 公式与口径说明（前端 tooltip 直接渲染） */
  formulas: { key: string; title: string; formula: string; detail: string }[]
  /** 旧字段（保留）：模块边界与免责说明 */
  disclaimer: string
}

const DISCLAIMER =
  '本模块分两级：叙事泡沫指数（NFI）只用站内新闻，衡量「讨论有多热」；' +
  '危机风险分（CRS）必须接入利率、信用利差、指数三类宏观数据才计算。' +
  'NFI 不是估值模型（新闻里没有估值倍数），CRS 的概率区间是基于历史基础率的启发式，' +
  '既不是预测也不构成任何投资建议。'

/** 把宏观快照转成引擎需要的输入 */
function macroInput(point: MacroPoint | undefined, key: string, label: string) {
  if (!point) return null
  return {
    key,
    label,
    value: point.value,
    history: point.history,
    yearAgo: point.yearAgo,
    avg200: point.avg200,
    high52w: point.high52w,
  }
}

/** 指数连续下跌天数（从历史序列尾部往前数） */
function consecutiveDownDays(history: number[]): number {
  let n = 0
  for (let i = history.length - 1; i > 0; i--) {
    if (history[i] < history[i - 1]) n += 1
    else break
  }
  return n
}

/** 最脆弱实体：负面多 + 热度退潮 + 缺融资 */
function vulnerableEntities(db: DatabaseSync, days: number, limit = 10): VulnerableEntity[] {
  const rows = db
    .prepare(
      `SELECT m.entity AS entity,
              COUNT(*) AS mentions,
              SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS neg,
              SUM(CASE WHEN a.category = 'funding' THEN 1 ELSE 0 END) AS fund
         FROM mentions m JOIN articles a ON a.id = m.article_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ?
        GROUP BY m.entity
       HAVING mentions >= 3`,
    )
    .all(new Date(Date.now() - days * 86_400_000).toISOString()) as unknown as {
    entity: string
    mentions: number
    neg: number
    fund: number
  }[]
  if (rows.length === 0) return []

  // 近 7 天 vs 前 7 天的提及变化
  const recentRows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n
         FROM mentions m JOIN articles a ON a.id = m.article_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ?
        GROUP BY m.entity`,
    )
    .all(new Date(Date.now() - 7 * 86_400_000).toISOString()) as unknown as { entity: string; n: number }[]
  const prevRows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n
         FROM mentions m JOIN articles a ON a.id = m.article_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ? AND a.published_at < ?
        GROUP BY m.entity`,
    )
    .all(
      new Date(Date.now() - 14 * 86_400_000).toISOString(),
      new Date(Date.now() - 7 * 86_400_000).toISOString(),
    ) as unknown as { entity: string; n: number }[]
  const recentMap = new Map(recentRows.map((r) => [r.entity, Number(r.n)]))
  const prevMap = new Map(prevRows.map((r) => [r.entity, Number(r.n)]))

  const scored = rows.map((r) => {
    const mentions = Number(r.mentions)
    const negative = Number(r.neg ?? 0)
    const funding = Number(r.fund ?? 0)
    const negativeShare = mentions > 0 ? negative / mentions : 0
    const recent = recentMap.get(r.entity) ?? 0
    const prev = prevMap.get(r.entity) ?? 0
    const heatChange = prev > 0 ? (recent - prev) / prev : null
    // 脆弱性 = 负面占比×50 + 热度退潮×30 + 缺融资×20
    const heatPenalty = heatChange === null ? 0 : Math.max(0, -heatChange)
    const score = Math.round(
      Math.min(100, negativeShare * 50 + heatPenalty * 30 + (funding === 0 ? 20 : 0)),
    )
    const reasons: string[] = []
    if (negativeShare >= 0.3) reasons.push(`负面占比 ${(negativeShare * 100).toFixed(0)}%`)
    if (heatPenalty > 0.2) reasons.push(`热度退潮 ${(heatPenalty * 100).toFixed(0)}%`)
    if (funding === 0) reasons.push('无融资类报道')
    return {
      entity: r.entity,
      negative,
      mentions,
      negativeShare: Number(negativeShare.toFixed(3)),
      heatChange: heatChange === null ? null : Number(heatChange.toFixed(2)),
      funding,
      score,
      reason: reasons.length > 0 ? reasons.join('、') : '负面偏多',
    }
  })

  return scored.sort((a, b) => b.score - a.score || b.negative - a.negative).slice(0, limit)
}

export async function riskReport(
  db: DatabaseSync,
  opts: { days?: number; now?: number; macroKey?: string; macro?: MacroSnapshot } = {},
): Promise<RiskReport> {
  const params = loadParams(db)
  const narrative = narrativeFroth(db, { days: opts.days, now: opts.now })
  const inputs = narrativeInputs(db, { days: opts.days, now: opts.now })
  const macro = opts.macro ?? (await loadMacro(opts.macroKey ?? config.fredApiKey))

  // ---------- NFI v2 ----------
  const nfi = computeNfi(
    {
      moneyShare: inputs.moneyShare,
      sentimentSkew: inputs.sentimentSkew,
      concentration: inputs.concentration,
      acceleration: inputs.acceleration,
      fomo: inputs.fomo,
      // 赛道锚点：预留（估值倍数 / 资金净流入暂无数据源）
      anchors: [],
    },
    params,
  )

  // ---------- CRS v2 ----------
  const rates = macroInput(macro.series.rates10y, 'rates', '10 年期美债收益率')
  const credit = macroInput(macro.series.creditSpread, 'credit', '高收益债信用利差（OAS）')
  const index = macroInput(macro.series.nasdaq, 'index', '纳斯达克综合指数')
  const crs: CrsResult | null =
    macro.available && (rates || credit || index)
      ? computeCrs({ nfi: nfi.score, rates, credit, index, inversion: macro.inversion }, params)
      : null

  // ---------- 背离检测 ----------
  const indexHistory = macro.series.nasdaq?.history ?? []
  const indexDownDays = consecutiveDownDays(indexHistory)
  const indexChange =
    indexHistory.length >= 6 && indexHistory[indexHistory.length - 6] > 0
      ? indexHistory[indexHistory.length - 1] / indexHistory[indexHistory.length - 6] - 1
      : null

  const dayMs = 86_400_000
  const now = opts.now ?? Date.now()
  const countBetween = (from: number, to: number, extra = ''): number =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM articles
            WHERE ai_relevant = 1 AND published_at >= ? AND published_at < ?${extra}`,
        )
        .get(new Date(now - from * dayMs).toISOString(), new Date(now - to * dayMs).toISOString()) as { n: number }
    ).n
  const recentCount = countBetween(7, 0)
  const prevCount = countBetween(14, 7)
  const heatSurgeRatio = prevCount > 0 ? recentCount / prevCount : null
  const fundingRecent = countBetween(7, 0, " AND category = 'funding'")
  const fundingPrev = countBetween(14, 7, " AND category = 'funding'")
  const fundingChangeRatio = fundingPrev > 0 ? (fundingRecent - fundingPrev) / fundingPrev : null

  const divergences = detectDivergences({
    optimism: inputs.optimism,
    indexDownDays,
    heatSurgeRatio,
    fundingChangeRatio,
    entity: null,
    moneyShare: inputs.moneyShare,
    indexChange,
    params,
  })

  // ---------- 脆弱实体（CRS 高时才值得看） ----------
  const vulnerable = crs && crs.score >= 50 ? vulnerableEntities(db, narrative.windowDays, 10) : []

  const crisis: CrisisAssessment | null = crs
    ? { score: crs.score, level: crs.level, probability12m: crs.probability12m, factors: crs.factors }
    : null

  return {
    generatedAt: new Date().toISOString(),
    windowDays: narrative.windowDays,
    narrative: { ...narrative, nfi: nfi.score, band: nfi.band },
    macro,
    crisis,
    nfi,
    disclaimer: DISCLAIMER,
    waterfall: crs?.waterfall ?? null,
    divergences,
    vulnerableEntities: vulnerable,
    params,
    formulas: [
      {
        key: 'nfi',
        title: 'NFI 叙事泡沫指数（v2）',
        formula: `Σ(分项得分 × 权重) / Σ权重，权重：融资 ${params.nfi.money}% / 情绪 ${params.nfi.sentiment}% / 集中度 ${params.nfi.concentration}% / 加速度 ${params.nfi.acceleration}% / FOMO ${params.nfi.fomo}%`,
        detail: `加速度超过 ${(1 + params.acceleration.threshold).toFixed(2)} 倍后按阶跃跳升（sharpness=${params.acceleration.sharpness}）；FOMO = 追高词命中 + 感叹号密度`,
      },
      {
        key: 'crs',
        title: 'CRS 危机风险分（v2）',
        formula: `基础权重 NFI ${params.crs.nfi}% / 利率 ${params.crs.rates}% / 信用 ${params.crs.credit}% / 指数 ${params.crs.index}%，再加交叉项（利率×信用）最多 +8 分`,
        detail: `宏观指标用 20 年历史分位数化；OAS > ${params.steps.oas}% 阶跃跳升；纳指回撤 > ${(params.dynamic.drawdown * 100).toFixed(0)}% 或收益率倒挂时宏观权重 ×${params.dynamic.boost}`,
      },
      {
        key: 'fomo',
        title: 'FOMO 系数',
        formula: '命中追高词（暴涨/翻倍/踏空/狂飙/疯抢/涨停…）每个 22 分 + 感叹号密度每百字 6 分（上限 30），封顶 100',
        detail: `本次命中：${inputs.fomo.hits.join('、') || '无'}；感叹号密度 ${inputs.fomo.exclaimDensity}/百字`,
      },
    ],
  }
}
