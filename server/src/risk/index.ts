import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { loadMacro, type MacroSnapshot, type MacroPoint } from './macro.ts'
import { narrativeFroth, narrativeInputs, type NarrativeReport } from './narrative.ts'
import { loadParams } from './params.ts'
import { assessQuality, type RiskQuality } from './quality.ts'
import { eventRisk, type EventRisk } from './events.ts'
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
  /** 三条诊断子指数（过热 / 当前压力 / 潜在脆弱），不参与总分 */
  subIndices: CrsResult['subIndices'] | null
  /** 数据质量与可信度：区分「风险真的高」与「数据不足」 */
  quality: RiskQuality
  eventRisk: EventRisk
  assessment: { level: 'unknown' | 'observe' | 'watch' | 'elevated' | 'critical'; headline: string; detail: string }
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
  '本模块分三条独立观察线：事件冲击直接检查已采集 RSS/API 标题，关注公司重大变动；叙事泡沫指数（NFI）只用站内新闻，衡量「讨论有多热」；' +
  '危机风险分（CRS）必须接入利率、信用利差、指数三类宏观数据才计算。' +
  'NFI 不是估值模型（新闻里没有估值倍数）。' +
  'CRS 的历史回测（不含 NFI）显示两个时间切分结论不一致（回撤 AUC 0.60 vs 0.42），' +
  '且独立危机事件只有 3 个 —— 因此 CRS 目前定位为「可解释的宏观压力描述」，' +
  '不是已验证的危机预警模型，也不输出预测概率。事件冲击为规则预警强度，低分或未检出不等于安全；传闻单独展示，不与已发生事件混算。'

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
  const narrative = narrativeFroth(db, { days: opts.days, now: opts.now })
  const inputs = narrativeInputs(db, { days: opts.days, now: opts.now })
  const macro = opts.macro ?? (await loadMacro(opts.macroKey ?? config.fredApiKey))

  // ---------- NFI v2 ----------
  const nfi = computeNfi(
    {
      articles: inputs.articles,
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
  const coreReady = ['rates10y', 'creditSpread', 'nasdaq'].every(key => {
    const p = macro.series[key]
    const age = p ? now - Date.parse(p.asOf) : NaN
    return p && Number.isFinite(p.value) && Number.isFinite(age) && age >= 0 && age <= 7 * 86_400_000
  })
  const crs: CrsResult | null =
    macro.available && coreReady
      ? computeCrs(
          { nfi: nfi.score, rates, credit, index, inversion: macro.inversion, concentration: inputs.concentration },
          params,
        )
      : null

  // ---------- 背离检测 ----------
  const indexHistory = macro.series.nasdaq?.history ?? []
  const indexDownDays = consecutiveDownDays(indexHistory)
  const indexChange =
    indexHistory.length >= 6 && indexHistory[indexHistory.length - 6] > 0
      ? indexHistory[indexHistory.length - 1] / indexHistory[indexHistory.length - 6] - 1
      : null

  const dayMs = 86_400_000
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

  // 公司事件与宏观分脱钩：CRS 低时仍然显示公司层面的负面信号。
  const vulnerable = vulnerableEntities(db, narrative.windowDays, now, 10)
  const events = eventRisk(db, { now })

  const crisis: CrisisAssessment | null = crs
    ? { score: crs.score, level: crs.level, probability12m: crs.probability12m, factors: crs.factors }
    : null

  const quality = assessQuality(db, { days: narrative.windowDays, now, inputs, macro })
  if (!coreReady) quality.unavailable.push('CRS 核心序列（利率/信用/指数）缺失、超前或超过 7 天未更新，暂停计算')
  const eventLevel = events.stale ? 0 : (events.score ?? 0)
  const pressure = Math.max(eventLevel, crs?.score ?? 0)
  const level = pressure >= 75 ? 'critical' : pressure >= 55 ? 'elevated' : pressure >= 30 ? 'watch' : events.stale || !crs ? 'unknown' : 'observe'
  const lead = events.events[0]
  const assessment: RiskReport['assessment'] = {
    level,
    headline: lead && eventLevel >= 30 ? `${lead.entity}出现${lead.category}信号` : pressure >= 30 ? '宏观市场压力值得关注' : level === 'unknown' ? '数据覆盖有限，暂不作低风险判断' : '已覆盖信号暂未达到较高预警档',
    detail: lead && eventLevel >= 30
      ? `近 7 天事件强度 ${events.score}；宏观压力 ${crs?.score ?? '未计算'}。公司事件单独触发关注，不会被全站新闻均值稀释。`
      : '事件冲击、叙事泡沫与宏观压力分别衡量不同问题；任何一条线的低分都不代表整体安全。',
  }

  return {
    generatedAt: new Date(now).toISOString(),
    windowDays: narrative.windowDays,
    narrative: { ...narrative, nfi: nfi.score, band: nfi.band },
    macro,
    crisis,
    nfi,
    disclaimer: DISCLAIMER,
    waterfall: crs?.waterfall ?? null,
    subIndices: crs?.subIndices ?? null,
    quality,
    eventRisk: events,
    assessment,
    divergences,
    vulnerableEntities: vulnerable,
    params,
    formulas: [
      {
        key: 'nfi',
        title: 'NFI 叙事泡沫指数（v2）',
        formula: `Σ(分项得分 × 权重) / Σ权重，权重：融资 ${params.nfi.money}% / 情绪 ${params.nfi.sentiment}% / 集中度 ${params.nfi.concentration}% / 加速度 ${params.nfi.acceleration}% / FOMO ${params.nfi.fomo}%`,
        detail:
          `加速度：1.00 以下 0 分，1.00~${(1 + params.acceleration.threshold).toFixed(2)} 线性升至 50，之后按阶跃渐近 100；` +
          `超过 ${params.acceleration.cap ?? 3} 倍视为采集面变化，不参与加权。` +
          'FOMO：逐篇打分后按「覆盖率 × 强度」聚合，不再把整窗拼成一段文本。',
      },
      {
        key: 'crs',
        title: 'CRS 危机风险分（v2）',
        formula: `基础权重 NFI ${params.crs.nfi}% / 利率 ${params.crs.rates}% / 信用 ${params.crs.credit}% / 指数 ${params.crs.index}%，再加交叉项（利率×信用）最多 +8 分`,
        detail:
          `宏观指标用历史分位数化（point-in-time，只用当天及以前的观测）；OAS > ${params.steps.oas}% 阶跃跳升；` +
          `纳指回撤跨过 ${(params.dynamic.drawdown * 100).toFixed(0)}% 时宏观权重平滑升至 ×${params.dynamic.boost}（±${((params.dynamic.band ?? 0.02) * 100).toFixed(0)}pp 过渡带）。` +
          (params.crs.rates === 0
            ? '　ⓘ 当前为**简化模式**：利率连续打分权重为 0，倒挂改在「潜在脆弱」子指数里体现。'
            : ''),
      },
      {
        key: 'simplify',
        title: '为什么简化（v0.34.0）',
        formula: 'CRS 由 4 项（NFI 40 / 利率 20 / 信用 20 / 指数 20）改为 3 项（NFI 30 / 信用 35 / 指数 35）',
        detail:
          '依据是回测消融：去掉利率连续打分后，两个时间切分、两个预测目标同时变好' +
          '（回撤 AUC 0.599→0.627 与 0.417→0.482）；而只留指数会明显变差（0.533/0.419），说明信用项必需。' +
          '⚠️ 代价：倒挂不再进总分，只在子指数里体现。⚠️ 局限：回测不含 NFI，30% 的叙事权重无法被验证。',
      },
      {
        key: 'subIndices',
        title: '三条诊断子指数（不参与总分）',
        formula: '过热 = NFI×50% + 指数偏离 200 日均值×30% + 一年涨幅×20%；当前压力 = 利差水平×30% + 利差走阔×20% + 利率压力×25% + 指数回撤×25%；潜在脆弱 = 利差过窄×50% + 叙事集中度×30% + 曲线倒挂×20%',
        detail: '同样是 60 分，可能是"涨得太快要回调"，也可能是"已经出事了"——子指数负责说清是哪一种。',
      },
      {
        key: 'fomo',
        title: 'FOMO 系数',
        formula: 'score = 100 × 覆盖率 × (0.4 + 0.6 × 强度/100)；单篇最多计 4 个追高词（88 分）+ 感叹号密度（上限 30）',
        detail: `本次：覆盖率 ${((inputs.fomo.breadth ?? 0) * 100).toFixed(1)}%、强度 ${inputs.fomo.depth ?? 0}、` +
          `命中 ${inputs.fomo.hits.join('、') || '无'}；感叹号密度 ${inputs.fomo.exclaimDensity}/百字`,
      },
      {
        key: 'probability',
        title: '12 个月情景参考值（已从主看板移除）',
        formula: `p = clamp(${params.probability.base} × e^((CRS−50)/${params.probability.scale}), 3%, 60%)，上下各 ±${(params.probability.band * 100).toFixed(0)}pp`,
        detail:
          '⚠️ 该公式未经任何校准：即使标注"非预测"，一个 8%–18% 的区间仍会被当成概率读，' +
          '因此 v0.29.0 起不再在主看板展示。等具备独立样本与概率校准证据后再放回。',
      },
    ],
  }
}
