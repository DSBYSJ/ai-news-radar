import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { loadMacro, type MacroSnapshot } from './macro.ts'
import type { NarrativeReport } from './narrative.ts'
import { narrativeEvidence, type NarrativeEvidence } from './narrativeEvidence.ts'
import { marketPressure, type MarketPressure } from './pressure.ts'
import { loadParams } from './params.ts'
import { assessQuality, type RiskQuality } from './quality.ts'
import { eventRisk, type EventRisk } from './events.ts'
import {
  type CrsFactor,
  type CrsResult,
  type Divergence,
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
  /** V3 四项历史分位的平均值；不是危机概率 */
  score: number
  level: 'low' | 'guarded' | 'elevated' | 'high'
  /**
   * 未来 12 个月的**情景参考区间**（百分比）。
   * ⚠️ 不是预测概率：参数人工设定、未经回测校准，且只覆盖美国市场。
   */
  probability12m: CrsResult['probability12m']
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
  /** 融资类提及数，仅保留兼容，不参与实体加分 */
  funding: number
  /** 脆弱性得分 0~100 */
  score: number
  reason: string
}

export interface RiskReport {
  model: 'risk-evidence-v3'
  pressure: MarketPressure
  generatedAt: string
  windowDays: number
  /** 旧字段（保留）：叙事指数结构 */
  narrative: NarrativeReport
  /** 旧字段（保留）：宏观快照（新增 history/high52w/inversion） */
  macro: MacroSnapshot
  /** 旧字段兼容映射：V3 市场压力，probability12m 始终为空 */
  crisis: CrisisAssessment | null
  // ---- v0.26.0 新增 ----
  /** V3 资本措辞覆盖测量 */
  nfi: NarrativeEvidence | null
  /** 瀑布图归因（基础分 → 各项贡献 → 合计） */
  waterfall: CrsResult['waterfall'] | null
  /** 三条诊断子指数（过热 / 当前压力 / 潜在脆弱），不参与总分 */
  subIndices: CrsResult['subIndices'] | null
  /** 数据质量与可信度：区分「风险真的高」与「数据不足」 */
  quality: RiskQuality
  eventRisk: EventRisk
  assessment: { level: 'unknown' | 'observe' | 'watch' | 'elevated' | 'critical'; headline: string; detail: string }
  /** 背离预警 */
  divergences: Divergence[]
  /** 独立实体负面诊断，不依赖 CRS 门槛 */
  vulnerableEntities: VulnerableEntity[]
  /** V2 存档参数；不控制 V3 测量 */
  params: RiskParams
  /** 公式与口径说明（前端 tooltip 直接渲染） */
  formulas: { key: string; title: string; formula: string; detail: string }[]
  /** 旧字段（保留）：模块边界与免责说明 */
  disclaimer: string
}

const DISCLAIMER =
  'V3 分开测量事件、资本叙事和市场压力。NFI 是去重与出版源均衡后的资本叙事报道占比，不是估值模型、泡沫概率或市场情绪调查。' +
  'CRS 是信用利差水平/走阔、指数回撤/实现波动四项此前三年历史分位的平均值；利率水平、倒挂、低利差和股市上涨作为背景，不再增加当前压力。' +
  '50 不是安全线，读数不是合成分本身的百分位；持续高压时期，相对基准也会变化，应结合绝对水平。' +
  'V3 是描述性监测模型，未经独立预测验证，不输出危机概率；旧版回测不能证明新版有效。宏观历史按观测日期回放，缺少历史发布版本与修订记录，不冒充真实可交易的发布时点回测。' +
  '公司事件的规则强度独立呈现，不与宏观读数或新闻占比合成。'

/** 实体诊断：负面占比与近期负面升温；缺少融资报道不是财务危机证据。 */
function vulnerableEntities(db: DatabaseSync, days: number, now: number, limit = 10): VulnerableEntity[] {
  const rows = db
    .prepare(
      `SELECT m.entity AS entity,
              COUNT(*) AS mentions,
              SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS neg,
              SUM(CASE WHEN a.category = 'funding' THEN 1 ELSE 0 END) AS fund
         FROM mentions m JOIN articles a ON a.id = m.article_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ? AND a.published_at <= ?
        GROUP BY m.entity
       HAVING mentions >= 3`,
    )
    .all(new Date(now - days * 86_400_000).toISOString(), new Date(now).toISOString()) as unknown as {
    entity: string
    mentions: number
    neg: number
    fund: number
  }[]
  if (rows.length === 0) return []

  // 近 7 天 vs 前 7 天的提及变化
  const recentRows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n, SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS neg
         FROM mentions m JOIN articles a ON a.id = m.article_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ? AND a.published_at <= ?
        GROUP BY m.entity`,
    )
    .all(new Date(now - 7 * 86_400_000).toISOString(), new Date(now).toISOString()) as unknown as { entity: string; n: number; neg: number }[]
  const prevRows = db
    .prepare(
      `SELECT m.entity AS entity, COUNT(*) AS n, SUM(CASE WHEN a.sentiment = 'negative' THEN 1 ELSE 0 END) AS neg
         FROM mentions m JOIN articles a ON a.id = m.article_id
        WHERE a.ai_relevant = 1 AND a.published_at >= ? AND a.published_at < ?
        GROUP BY m.entity`,
    )
    .all(
      new Date(now - 14 * 86_400_000).toISOString(),
      new Date(now - 7 * 86_400_000).toISOString(),
    ) as unknown as { entity: string; n: number; neg: number }[]
  const recentMap = new Map(recentRows.map((r) => [r.entity, Number(r.n)]))
  const prevMap = new Map(prevRows.map((r) => [r.entity, Number(r.n)]))
  const recentNeg = new Map(recentRows.map(r => [r.entity, Number(r.neg)]))
  const prevNeg = new Map(prevRows.map(r => [r.entity, Number(r.neg)]))

  const scored = rows.map((r) => {
    const mentions = Number(r.mentions)
    const negative = Number(r.neg ?? 0)
    const funding = Number(r.fund ?? 0)
    const negativeShare = mentions > 0 ? negative / mentions : 0
    const recent = recentMap.get(r.entity) ?? 0
    const prev = prevMap.get(r.entity) ?? 0
    const heatChange = prev > 0 ? (recent - prev) / prev : null
    const negativeIncrease = recent >= 3 && prev >= 3
      ? Math.max(0, (recentNeg.get(r.entity) ?? 0) / recent - (prevNeg.get(r.entity) ?? 0) / prev) : 0
    const score = Math.round(Math.min(100, negativeShare * 70 + Math.min(1, negativeIncrease / 0.3) * 30))
    const reasons: string[] = []
    if (negativeShare >= 0.3) reasons.push(`负面占比 ${(negativeShare * 100).toFixed(0)}%`)
    if (negativeIncrease > 0) reasons.push(`近 7 日负面占比上升 ${(negativeIncrease * 100).toFixed(0)}pp`)
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

  return scored.filter(r => r.negative > 0).sort((a, b) => b.score - a.score || b.negative - a.negative).slice(0, limit)
}

export async function riskReport(
  db: DatabaseSync,
  opts: { days?: number; now?: number; macroKey?: string; macro?: MacroSnapshot } = {},
): Promise<RiskReport> {
  const now = opts.now ?? Date.now()
  const params = loadParams(db)
  const nfi = narrativeEvidence(db, { days: opts.days, now })
  const inputs = nfi.inputs
  const narrative: NarrativeReport = {windowDays:nfi.windowDays,articles:inputs.articles,classified:inputs.classified,
    nfi:nfi.score,band:'unknown',factors:nfi.factors,latestDate:inputs.latestDate,
    observations:[{key:'measurement',label:'统计口径',value:nfi.formula},{key:'sampling',label:'来源覆盖',value:`${nfi.sampling.eligiblePublishers} 个合格出版源，${nfi.sampling.eligibleArticles} 条去重报道`}]}
  const macro = opts.macro ?? (await loadMacro(opts.macroKey ?? config.fredApiKey))

  // ---------- V3：新闻占比与市场压力独立测量 ----------
  const pressure = marketPressure(macro,{now})
  const coreReady = pressure.status === 'ready'

  // V2 的新闻/市场阈值背离规则不跨版本沿用。
  const divergences: Divergence[] = []

  // 公司事件与宏观分脱钩：CRS 低时仍然显示公司层面的负面信号。
  const vulnerable = vulnerableEntities(db, narrative.windowDays, now, 10)
  const events = eventRisk(db, { now })

  const crisis: CrisisAssessment | null = pressure.score !== null
    ? { score: pressure.score, level: pressure.score>=90?'high':pressure.score>=75?'elevated':pressure.score>=50?'guarded':'low', probability12m: null, factors: pressure.factors }
    : null

  const quality = assessQuality(db, { days: narrative.windowDays, now, inputs, macro })
  quality.unavailable.push(...nfi.reasons,...pressure.reasons)
  quality.notes.push(nfi.note,pressure.note)
  quality.dimensions.push({key:'v3_narrative',label:'资本叙事计算条件',value:`${nfi.sampling.eligibleArticles} 条 / ${nfi.sampling.eligiblePublishers} 源`,status:nfi.status==='ready'?'sufficient':'insufficient',rule:'去重后至少 30 条、3 个出版源，每源至少 5 条；每源等权'})
  quality.dimensions.push({key:'v3_pressure',label:'V3 压力计算条件',value:`${pressure.factors.length}/4 项有效`,status:coreReady?'sufficient':'insufficient',rule:'共同观测不超过 7 天；每项此前三年至少 252 个有效观测，缺项不归一成完整读数'})
  if(!coreReady||nfi.status!=='ready'){
    quality.status='insufficient'
    quality.headline='部分 V3 计算条件未满足；未计算项显示原因，不作低风险判断'
  }
  const eventLevel = events.stale ? 0 : (events.score ?? 0)
  const level = eventLevel >= 75 ? 'critical' : eventLevel >= 55 ? 'elevated' : eventLevel >= 30 || (pressure.score??0)>=75 ? 'watch' : events.stale || !coreReady ? 'unknown' : 'observe'
  const lead = events.events[0]
  const assessment: RiskReport['assessment'] = {
    level,
    headline: lead && eventLevel >= 30 ? `${lead.entity}出现${lead.category}信号` : (pressure.score??0)>=75 ? '市场压力位于近期历史较高位置' : level === 'unknown' ? '数据覆盖有限，暂不作低风险判断' : '已覆盖事件暂无较强触发，市场读数单独解读',
    detail: lead && eventLevel >= 30
      ? `近 7 天事件强度 ${events.score}；市场压力读数 ${pressure.score ?? '未计算'}。两者量纲不同，不合成概率；公司事件单独触发关注。`
      : '事件冲击、叙事泡沫与宏观压力分别衡量不同问题；任何一条线的低分都不代表整体安全。',
  }

  return {
    model:'risk-evidence-v3',pressure,
    generatedAt: new Date(now).toISOString(),
    windowDays: narrative.windowDays,
    narrative: { ...narrative, nfi: nfi.score, band: nfi.band },
    macro,
    crisis,
    nfi,
    disclaimer: DISCLAIMER,
    waterfall: pressure.score===null?null:[...pressure.factors.map(f=>({label:f.label,value:f.contribution,kind:'item' as const})),{label:'合计',value:pressure.score,kind:'total' as const}],
    subIndices: null,
    quality,
    eventRisk: events,
    assessment,
    divergences,
    vulnerableEntities: vulnerable,
    params,
    formulas: [
      {key:'nfi',title:'资本叙事占比 V3',formula:nfi.formula,detail:nfi.note},
      {key:'pressure',title:'市场压力 V3',formula:pressure.formula,detail:pressure.note},
      {key:'structure',title:'观察项不强行合成',formula:'融资、追逐措辞、正面比例、实体 HHI 和共同来源报道变化分别显示原始单位。',
        detail:'集中度与正面报道不等于风险；不同量纲不放进统一风险雷达。融资与追逐措辞的并集按互斥部分解释，不重复计数。'},
      {key:'validation',title:'验证边界',formula:'描述性统计与预测能力分别验证；V2 回测属于旧模型存档。',
        detail:'新公式未经独立样本预测验证，不输出概率、目标价或常态安全保证。历史宏观重放缺少发布版本和修订档案，不能声称无发布时点泄漏。'},
    ],
  }
}
