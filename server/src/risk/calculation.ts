/**
 * 风险计算引擎（v0.26.0 重构）
 *
 * 独立模块：不依赖路由、不依赖前端，所有数学都收在这里，方便单测与调参。
 *
 * 三块能力：
 *   1. 统计工具：分位数（Percentile）、Z-Score、阶跃响应（Step Response）、Logistic
 *   2. NFI v2：FOMO 系数（情绪提取）+ 恢复热度加速度的非线性权重 + 赛道锚点（预留）
 *   3. CRS v2：指标分位数化 + 阈值阶跃 + 宏观交叉项（利率×信用）+ 动态权重 + 瀑布图归因
 *   4. 背离检测：情绪×价格、热度×融资、叙事×宏观
 *
 * 设计原则：
 *   - **所有阈值/权重都从 params 来**（可调、可存库），不在代码里写死
 *   - **每个分项都要能解释**：返回 score / weight / contribution / note
 *   - **绝对水平与变化都要看**：高利差（已出事）与利差走阔（正在出事）都得算风险
 */

export type Direction = 'higher-is-riskier' | 'lower-is-riskier'

// ============================ 统计工具 ============================

/**
 * 百分位（0~1）：value 在 history 中排在什么位置。
 * 用「小于等于的样本占比」，并列取中值，避免极端值把曲线拉平。
 */
export function percentileRank(value: number, history: number[]): number | null {
  const clean = history.filter((h) => Number.isFinite(h))
  if (clean.length < 30) return null
  let below = 0
  let equal = 0
  for (const h of clean) {
    if (h < value) below += 1
    else if (h === value) equal += 1
  }
  return (below + equal / 2) / clean.length
}

/** Z-Score：相对历史均值与标准差的位置（样本下限 10，比分位数宽松） */
export function zScore(value: number, history: number[]): number | null {
  const clean = history.filter((h) => Number.isFinite(h))
  if (clean.length < 10) return null
  const mean = clean.reduce((a, b) => a + b, 0) / clean.length
  const variance = clean.reduce((a, b) => a + (b - mean) ** 2, 0) / clean.length
  const sd = Math.sqrt(variance)
  if (sd <= 0) return null
  return (value - mean) / sd
}

/**
 * 阶跃响应：超过阈值后风险**指数级跳升**，而不是线性增加。
 * @param threshold 临界值
 * @param sharpness 越大越陡（e^((v-t)*k)）
 */
export function stepResponse(value: number, threshold: number, sharpness: number): number {
  if (!Number.isFinite(value)) return 0
  const over = (value - threshold) * sharpness
  if (over <= 0) return 0
  // 上限 100：超过 2.3 个自然对数单位即封顶
  return Math.min(100, (1 - Math.exp(-over)) * 100)
}

/**
 * Logistic 0~100：把 z 分数平滑映射到风险分。
 * ⚠️ 方向：z 越大（越异常）→ 分数越高，所以这里是 **+steepness × (z − midpoint)**。
 */
export function logisticScore(z: number, midpoint: number, steepness: number): number {
  const x = steepness * (z - midpoint)
  return Math.round((1 / (1 + Math.exp(-x))) * 100)
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x))
}

// ============================ FOMO 系数 ============================

/** FOMO 词表：出现即代表"追高情绪"。中英双语 —— 语料里英文源占比过半，
 *  只做中文词表会让英文 FOMO 完全漏检。 */
const FOMO_WORDS = [
  // 中文
  '暴涨', '翻倍', '踏空', '狂飙', '疯抢', '售罄', '秒杀', '史诗级', '炸裂', '碾压',
  '错过就没了', '最后上车', '一票难求', '涨停', '涨停潮', '抢筹', '爆买', '上车',
  // 英文
  'skyrocket', 'moonshot', 'to the moon', 'sold out', 'sell-out', 'frenzy',
  'euphoria', 'must-buy', "can't miss", 'cannot miss', 'last chance',
  'parabolic', 'melt up', 'all in', 'all-in', 'fomo', '10x', 'sold-out',
]
/** 感叹号是 FOMO 的经典信号（营销腔） */
const EXCLAIM_RE = /[!！]/g

/** 单篇最多计 4 个词（88 分），避免一篇文章堆词直接把整窗拉满 */
const MAX_WORDS_PER_ARTICLE = 4
/** 感叹号密度封顶分 */
const MAX_EXCLAIM_SCORE = 30

/**
 * FOMO 的宽松输入形态：`breadth/depth/articles` 是 v0.28.0 新增的，
 * 老调用方（测试、外部构造）只给 score/hits/exclaimDensity 也必须能用。
 */
export type FomoLike = {
  score: number
  hits: string[]
  exclaimDensity: number
  breadth?: number
  depth?: number
  articles?: number
}

export interface FomoResult extends FomoLike {
  /** 覆盖率：含至少一个追高词的文章占比 0~1 */
  breadth: number
  /** 强度：命中文章的平均单篇分 0~100 */
  depth: number
  /** 参与统计的文章数 */
  articles: number
}

/**
 * FOMO 系数 v2：**逐篇打分再聚合**，而不是把全窗口拼成一段文本。
 *
 * 为什么改（v0.28.0）：
 *   旧实现把窗口内所有标题+摘要 join 成一大段，然后**每个词只计一次**。
 *   结果只要 5 个不同的追高词在任意两篇文章里出现过，就拿到 5×22=110 → 封顶 100，
 *   与「多少比例的报道在喊单」完全脱钩 —— 采集量一变，分数就失真。
 *
 * 新口径 = 覆盖率 × 强度：
 *   score = 100 × breadth × (0.4 + 0.6 × depth/100)
 *   - breadth = 含追高词的文章占比（"有多少人在喊"）
 *   - depth   = 命中文章的平均单篇分（"喊得多用力"）
 *   → 只有"全站都在喊 + 喊得凶"才接近 100；零星几篇再夸张也压不到满分。
 */
export function fomoCoefficient(texts: string[]): FomoResult {
  const total = texts.length
  if (total === 0) {
    return { score: 0, hits: [], exclaimDensity: 0, breadth: 0, depth: 0, articles: 0 }
  }

  const hitWords = new Set<string>()
  let hitArticles = 0
  let depthSum = 0
  let totalExclaims = 0
  let totalChars = 0

  for (const text of texts) {
    const lower = text.toLowerCase()
    totalChars += text.length
    const exclaims = (text.match(EXCLAIM_RE) ?? []).length
    totalExclaims += exclaims

    const words: string[] = []
    for (const w of FOMO_WORDS) {
      if (lower.includes(w)) {
        words.push(w)
        hitWords.add(w)
      }
    }
    if (words.length === 0) continue

    hitArticles += 1
    const wordScore = Math.min(MAX_WORDS_PER_ARTICLE, words.length) * 22
    const density = text.length > 0 ? (exclaims / text.length) * 100 : 0
    const exclaimScore = Math.min(MAX_EXCLAIM_SCORE, density * 6)
    depthSum += clamp(wordScore + exclaimScore, 0, 100)
  }

  const breadth = hitArticles / total
  const depth = hitArticles > 0 ? depthSum / hitArticles : 0
  const score = Math.round(clamp(100 * breadth * (0.4 + (0.6 * depth) / 100), 0, 100))
  const exclaimDensity = totalChars > 0 ? (totalExclaims / totalChars) * 100 : 0

  return {
    score,
    hits: [...hitWords].slice(0, 8),
    exclaimDensity: Number(exclaimDensity.toFixed(2)),
    breadth: Number(breadth.toFixed(3)),
    depth: Math.round(depth),
    articles: total,
  }
}

// ============================ 参数 ============================

export interface RiskParams {
  /** NFI 各分项权重（合计 100） */
  nfi: {
    money: number
    sentiment: number
    concentration: number
    acceleration: number
    fomo: number
  }
  /** 热度加速度的阶跃阈值与陡度（7 日均线的斜率突变） */
  acceleration: {
    threshold: number
    sharpness: number
    /** 超过此倍数视为「采集面变了」（加源/回填），不参与加权（默认 3） */
    cap: number
  }
  /** CRS 基础权重（合计 100） */
  crs: {
    nfi: number
    rates: number
    credit: number
    index: number
  }
  /** 阶跃阈值 */
  steps: {
    /** OAS 突破此值后风险指数跳升 */
    oas: number
    /** 10Y 利率突破此值后风险跳升 */
    rates: number
    /** 尖峰锐度 */
    sharpness: number
  }
  /**
   * 利率分项内部配比（v0.29.0 新增，默认 0.5 / 0.25 / 0.25，和为 1）。
   * 只为了让「逐因子消融实验」能单独关掉某一项，默认值与旧行为完全一致。
   */
  ratesMix: { level: number; change: number; step: number }
  /**
   * 信用分项三个来源的开关（v0.29.0 新增，默认全开）。
   * 关掉后该项不参与 max()，用于检验「自满项」是否真的带来增量信息。
   */
  creditUse: { stress: boolean; widening: boolean; complacency: boolean }
  /** 动态权重：触发后宏观项权重放大倍数 */
  dynamic: {
    /** 纳指回撤超过此值触发 */
    drawdown: number
    /** 动态放大倍数 */
    boost: number
    /**
     * 平滑带宽（默认 ±2pp）：在 [drawdown-band, drawdown+band] 内用 smoothstep 渐变，
     * 避免 9.9% → 10.1% 的机械跳变（实测该处总分曾一次跳 4~6 分）。
     */
    band: number
  }
  /** 背离检测阈值 */
  divergence: {
    /** 情绪极度乐观阈值 */
    optimisticSentiment: number
    /** 指数连续下跌天数 */
    downDays: number
    /** 热度激增倍数 */
    surgeRatio: number
    /** 融资骤降比例 */
    fundingDropRatio: number
  }
  /** 概率映射 */
  probability: { base: number; scale: number; band: number }
}

export const DEFAULT_PARAMS: RiskParams = {
  nfi: { money: 22, sentiment: 22, concentration: 18, acceleration: 18, fomo: 20 },
  acceleration: { threshold: 0.35, sharpness: 6, cap: 3 },
  crs: { nfi: 40, rates: 20, credit: 20, index: 20 },
  steps: { oas: 4.5, rates: 5.0, sharpness: 2.2 },
  ratesMix: { level: 0.5, change: 0.25, step: 0.25 },
  creditUse: { stress: true, widening: true, complacency: true },
  dynamic: { drawdown: 0.1, boost: 1.4, band: 0.02 },
  divergence: { optimisticSentiment: 80, downDays: 3, surgeRatio: 2.5, fundingDropRatio: 0.5 },
  probability: { base: 0.12, scale: 28, band: 0.05 },
}

// ============================ NFI v2 ============================

export interface NfiFactor {
  key: string
  label: string
  value: number | null
  score: number | null
  weight: number
  note: string
}

export interface NfiResult {
  score: number | null
  band: 'calm' | 'warm' | 'hot' | 'unknown'
  factors: NfiFactor[]
  fomo: FomoLike
}

export interface NfiInput {
  /** 窗口内条目总数（<20 视为样本不足，NFI 返回 null 而不是 0） */
  articles?: number
  /** 融资/上市类占比 0~1 */
  moneyShare: number
  /** 情绪偏正 -1~1 */
  sentimentSkew: number | null
  /** 前 5 实体占比 0~1 */
  concentration: number | null
  /** 7 日均线斜率突变（7日均线的环比变化率） */
  acceleration: number | null
  fomo: FomoLike
  /** 赛道锚点（预留：估值倍数/资金净流入，目前没有真实数据 → null） */
  anchors?: { label: string; value: number | null; score: number | null }[]
}

function scaleLinear(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi <= lo) return 0
  return Math.round(clamp((value - lo) / (hi - lo), 0, 1) * 100)
}

/**
 * 热度加速度评分（v0.28.0 修复）
 *
 * 旧实现（v0.26.0）：
 *   accel <= 1 ? scaleLinear(accel, 1, 1.35) : stepResponse(accel, 1.35, 6)
 *   两个缺陷：
 *   1. accel <= 1 分支里，scaleLinear 的上界就是 1.35 —— 该分支永远只能算出 0，是死代码
 *   2. 1 < accel < 1.35 走 stepResponse，低于阈值直接返回 0
 *   实际效果：1.35 倍以下恒为 0，到 1.35 处硬跳，与文档描述的"线性过渡到阶跃"不符。
 *   线上实测过加速度 13.2 倍（加源导致）直接给 100 分，把 NFI 整体抬高。
 *
 * 新实现：三段连续
 *   accel <= 1          → 0（没加速）
 *   1 < accel <= 1+thr  → 线性 0 → 50
 *   accel > 1+thr       → 50 + 阶跃响应/2 → 渐近 100
 * 两侧在 1+thr 处都等于 50，不会断层。
 * accel > cap（默认 3 倍）→ null（不参与加权）：那是"采集面变了"，不是热度变化。
 */
export function accelerationScore(accel: number | null, params: RiskParams): number | null {
  if (accel === null || !Number.isFinite(accel)) return null
  const cap = params.acceleration.cap ?? 3
  if (accel > cap) return null
  if (accel <= 1) return 0
  const knee = 1 + params.acceleration.threshold
  if (accel <= knee) return Math.round(((accel - 1) / (knee - 1)) * 50)
  return Math.round(50 + stepResponse(accel, knee, params.acceleration.sharpness) / 2)
}

/**
 * NFI v2：分项非线性映射 + FOMO + 加速度阶跃 + 归一化权重。
 * 分项为 null（样本不足）→ 不参与加权，权重按剩余项重新归一（并在 note 里说明）。
 */
export function computeNfi(input: NfiInput, params: RiskParams): NfiResult {
  const w = params.nfi
  const factors: NfiFactor[] = [
    {
      key: 'money',
      label: '融资/上市密度',
      value: round(input.moneyShare * 100, 1),
      score: scaleLinear(input.moneyShare, 0.02, 0.12),
      weight: w.money,
      note: `含融资/估值/IPO 的条目占比；2%→0 分，12%→100 分（权重 ${w.money}%）`,
    },
    {
      key: 'sentiment',
      label: '情绪偏正度',
      value: input.sentimentSkew === null ? null : round(input.sentimentSkew, 2),
      score: input.sentimentSkew === null ? null : scaleLinear(input.sentimentSkew, 0, 0.6),
      weight: w.sentiment,
      note:
        input.sentimentSkew === null
          ? '情感判定样本不足，本项不参与加权'
          : `(正面−负面)/已判定 = ${input.sentimentSkew.toFixed(2)}；0→0 分，0.6→100 分（权重 ${w.sentiment}%）`,
    },
    {
      key: 'concentration',
      label: '叙事集中度',
      value: input.concentration === null ? null : round(input.concentration * 100, 1),
      score: input.concentration === null ? null : scaleLinear(input.concentration, 0.08, 0.4),
      weight: w.concentration,
      note:
        input.concentration === null
          ? '实体抽取为空，本项不参与加权'
          : `前 5 实体占总提及 ${(input.concentration * 100).toFixed(1)}%；8%→0 分，40%→100 分（权重 ${w.concentration}%）`,
    },
    {
      key: 'acceleration',
      label: '热度加速度',
      value: input.acceleration === null ? null : round(input.acceleration, 2),
      // 三段连续：0 → 线性爬坡 → 阶跃渐近（详见 accelerationScore 注释）
      score: accelerationScore(input.acceleration, params),
      weight: w.acceleration,
      note:
        input.acceleration === null
          ? '基期样本不足（<5 条/天），本项不参与加权'
          : input.acceleration > (params.acceleration.cap ?? 3)
            ? `7 日均线环比 ${input.acceleration.toFixed(2)} 倍，超过 ${params.acceleration.cap ?? 3} 倍上限，` +
              '通常意味着「采集面变了」（加源/回填）而非热度变化 —— 本项不参与加权'
            : `7 日均线环比 ${input.acceleration.toFixed(2)} 倍；1.00 以下 0 分，` +
              `1.00~${(1 + params.acceleration.threshold).toFixed(2)} 线性升至 50 分，` +
              `超过后按阶跃渐近 100（权重 ${w.acceleration}%）`,
    },
    {
      key: 'fomo',
      label: 'FOMO 系数',
      value: input.fomo.score,
      score: input.fomo.score,
      weight: w.fomo,
      note:
        (input.fomo.breadth !== undefined && input.fomo.articles
          ? `覆盖率 ${(input.fomo.breadth * 100).toFixed(1)}%（${Math.round(input.fomo.breadth * input.fomo.articles)}/${input.fomo.articles} 篇含追高词）` +
            ` × 强度 ${input.fomo.depth ?? 0}`
          : '仅传入综合分，无覆盖率明细') +
        ` → ${input.fomo.score} 分` +
        (input.fomo.hits.length > 0 ? `；命中：${input.fomo.hits.join('、')}` : '') +
        `（权重 ${w.fomo}%）`,
    },
  ]

  // 赛道锚点（预留接口：数据源到位后自动参与加权）
  for (const a of input.anchors ?? []) {
    factors.push({
      key: `anchor_${a.label}`,
      label: a.label,
      value: a.value,
      score: a.score,
      weight: 0,
      note: '赛道锚点（估值倍数/资金流向）尚未接入数据源，暂不计分',
    })
  }

  const effective = factors.filter((f) => f.score !== null && f.weight > 0)
  const weightSum = effective.reduce((s, f) => s + f.weight, 0)
  /*
   * 样本门槛：窗口内条目太少时返回 null 而不是 0 ——
   * "没数据" ≠ "测量为冷静"，填 0 会把回溯曲线画成一条假的低线。
   */
  const MIN_SAMPLES = 20
  const sampleTooSmall = input.articles !== undefined && input.articles < MIN_SAMPLES
  const score =
    sampleTooSmall || weightSum === 0
      ? null
      : Math.round(effective.reduce((s, f) => s + (f.score as number) * f.weight, 0) / weightSum)

  return {
    score,
    band: sampleTooSmall ? 'unknown' : score === null ? 'unknown' : score >= 65 ? 'hot' : score >= 38 ? 'warm' : 'calm',
    factors,
    fomo: input.fomo,
  }
}

// ============================ CRS v2 ============================

export interface CrsFactor {
  key: string
  label: string
  value: number | null
  /** 分位数 0~1（宏观项才有） */
  percentile: number | null
  z: number | null
  score: number
  /** 最终权重（已按动态调整与归一） */
  weight: number
  /** 对总分的贡献（score × weight%，四舍五入） */
  contribution: number
  note: string
}

export interface CrsResult {
  score: number
  level: 'low' | 'guarded' | 'elevated' | 'high'
  factors: CrsFactor[]
  /** 瀑布图数据：基础分 + 各项贡献 + 合计 */
  waterfall: { label: string; value: number; kind: 'base' | 'item' | 'total' }[]
  probability12m: { low: number; high: number; note: string; label: string; scope: string } | null
  /** 动态权重是否被触发（回撤 / 倒挂） */
  dynamicTriggered: { drawdown: boolean; inversion: boolean } | null
  /**
   * 三条诊断子指数（v0.28.0 新增，**不参与总分**）：
   * 同样是 60 分，"涨太快要回调"和"已经出事了"是完全不同的处境。
   */
  subIndices: {
    overheat: SubIndex
    stress: SubIndex
    fragility: SubIndex
  }
}

export interface SubIndex {
  /** 0~100 */
  score: number
  label: string
  /** 一句话说明这个子指数在回答什么问题 */
  question: string
  /** 组成它的信号（含各自原始分与内部权重） */
  parts: { label: string; score: number; weight: number }[]
  note: string
}

export interface MacroSeriesInput {
  key: string
  label: string
  value: number
  /** 历史序列（用于分位数/Z-Score） */
  history: number[]
  /** 一年前值 */
  yearAgo: number | null
  /** 200 日均值 */
  avg200: number | null
  /** 52 周最高 */
  high52w: number | null
}

export interface CrsInput {
  nfi: number | null
  rates: MacroSeriesInput | null
  credit: MacroSeriesInput | null
  index: MacroSeriesInput | null
  /** 收益率曲线是否倒挂（10Y < 2Y），没数据则 null */
  inversion: boolean | null
  /** 叙事集中度 0~1（前 5 实体占比），用于「潜在脆弱」子指数；无数据为 null */
  concentration?: number | null
}

/** 信用风险：绝对水平（高=已承压）与"过窄=自满"两头都算，取大者 */
function creditRisk(
  m: MacroSeriesInput,
  params: RiskParams,
): { score: number; note: string; stress: number; widening: number; complacency: number } {
  // 三种风险来源，都算：绝对水平已承压 / 利差走阔（正在出事） / 利差极窄（自满）
  const stress = stepResponse(m.value, params.steps.oas, params.steps.sharpness)
  const change = m.yearAgo === null ? 0 : m.value - m.yearAgo
  const widening = scaleLinear(change, 0, 2)
  const complacency = scaleLinear(3.0 - m.value, 0, 0.9)
  // 三个来源可单独关闭（消融实验用）；默认全开时与旧行为一致
  const use = params.creditUse ?? { stress: true, widening: true, complacency: true }
  const enabled = [use.stress ? stress : null, use.widening ? widening : null, use.complacency ? complacency : null]
    .filter((x): x is number => x !== null)
  const score = enabled.length > 0 ? Math.round(Math.max(...enabled)) : 0
  const off = [!use.stress && '承压', !use.widening && '走阔', !use.complacency && '自满'].filter(Boolean)
  return {
    score,
    stress: Math.round(stress),
    widening: Math.round(widening),
    complacency: Math.round(complacency),
    note:
      `OAS ${m.value.toFixed(2)}%` +
      (m.yearAgo === null ? '' : `（一年 ${change >= 0 ? '+' : ''}${change.toFixed(2)}pp）`) +
      `；>${params.steps.oas}% 阶跃跳升、一年走阔 >2pp、自满档 OAS<3%，三者取大` +
      `（承压 ${Math.round(stress)} / 走阔 ${Math.round(widening)} / 自满 ${Math.round(complacency)}）` +
      (off.length > 0 ? `；本次已关闭：${off.join('、')}` : ''),
  }
}

/** 指数风险：超涨 + 回撤 两头都算 */
function indexRisk(
  m: MacroSeriesInput,
): { score: number; note: string; drawdown: number | null; overext: number; runup: number; ddScore: number } {
  const overext = m.avg200 ? scaleLinear(m.value / m.avg200 - 1, 0.02, 0.25) : 0
  const runup = m.yearAgo ? scaleLinear(m.value / m.yearAgo - 1, 0.1, 0.6) : 0
  const drawdown = m.high52w ? m.value / m.high52w - 1 : null
  const ddScore = drawdown === null ? 0 : scaleLinear(-drawdown, 0.05, 0.3)
  const score = Math.round(Math.max(Math.max(overext, runup), ddScore))
  return {
    score,
    drawdown,
    overext,
    runup,
    ddScore,
    note:
      `指数 ${m.value.toFixed(0)}` +
      (m.avg200 ? `，较 200 日均值 ${((m.value / m.avg200 - 1) * 100).toFixed(1)}%` : '') +
      (drawdown === null ? '' : `，较 52 周高点 ${(drawdown * 100).toFixed(1)}%`) +
      `；超涨/回撤取大者（${score}）`,
  }
}

/** 利率风险：水平分位数 + 一年上行 + 倒挂惩罚 */
function ratesRisk(
  m: MacroSeriesInput,
  inversion: boolean | null,
  params: RiskParams,
): {
  score: number
  note: string
  percentile: number | null
  z: number | null
  levelScore: number
  changeScore: number
  step: number
  inversionPenalty: number
} {
  const p = percentileRank(m.value, m.history)
  const z = zScore(m.value, m.history)
  const change = m.yearAgo === null ? 0 : m.value - m.yearAgo
  const levelScore = p === null ? scaleLinear(m.value, 3.5, 5.5) : Math.round(p * 100)
  const changeScore = scaleLinear(change, 0, 1.5)
  const step = Math.round(stepResponse(m.value, params.steps.rates, params.steps.sharpness))
  const inversionPenalty = inversion === true ? 18 : 0
  // 内部配比可调（消融实验用）；默认 0.5/0.25/0.25、和为 1，与旧行为一致
  const mix = params.ratesMix ?? { level: 0.5, change: 0.25, step: 0.25 }
  const mixSum = mix.level + mix.change + mix.step
  const weighted =
    mixSum > 0 ? (mix.level * levelScore + mix.change * changeScore + mix.step * step) / mixSum : 0
  const score = Math.round(clamp(weighted + inversionPenalty, 0, 100))
  return {
    score,
    percentile: p,
    z,
    levelScore,
    changeScore,
    step,
    inversionPenalty,
    note:
      `10Y ${m.value.toFixed(2)}%` +
      (p === null ? '（历史样本不足，改用绝对水平刻度）' : `（历史分位 ${(p * 100).toFixed(0)}%，z=${z?.toFixed(2) ?? '—'}）`) +
      `；>${params.steps.rates}% 阶跃跳升` +
      (inversion === true ? '，**收益率曲线倒挂** +18' : ''),
  }
}

/**
 * CRS v2：分位数化 + 阶跃 + 交叉项 + 动态权重 + 瀑布归因。
 *
 * 交叉项：利率压力 × 信用环境 —— 「高利率 + 宽利差」= 系统性危机（放大），
 *        「高利率 + 紧利差」= 虚假繁荣（也放大，但路径不同，note 里说明）。
 */
export function computeCrs(input: CrsInput, params: RiskParams): CrsResult {
  const raw: { key: string; label: string; value: number | null; score: number; weight: number; percentile: number | null; z: number | null; note: string }[] = []

  if (input.nfi !== null) {
    raw.push({
      key: 'narrative',
      label: '叙事过热（NFI）',
      value: input.nfi,
      score: input.nfi,
      weight: params.crs.nfi,
      percentile: null,
      z: null,
      note: '来自站内新闻的叙事温度（非估值指标）',
    })
  }

  let ratesCalc: ReturnType<typeof ratesRisk> | null = null
  let creditCalc: ReturnType<typeof creditRisk> | null = null
  let indexCalc: ReturnType<typeof indexRisk> | null = null

  if (input.rates) {
    const r = ratesRisk(input.rates, input.inversion, params)
    ratesCalc = r
    raw.push({
      key: 'rates',
      label: '利率压力',
      value: input.rates.value,
      score: r.score,
      weight: params.crs.rates,
      percentile: r.percentile,
      z: r.z,
      note: r.note,
    })
  }
  if (input.credit) {
    const c = creditRisk(input.credit, params)
    creditCalc = c
    raw.push({
      key: 'credit',
      label: '信用环境',
      value: input.credit.value,
      score: c.score,
      weight: params.crs.credit,
      percentile: percentileRank(input.credit.value, input.credit.history),
      z: zScore(input.credit.value, input.credit.history),
      note: c.note,
    })
  }
  let drawdown: number | null = null
  if (input.index) {
    const i = indexRisk(input.index)
    indexCalc = i
    drawdown = i.drawdown
    raw.push({
      key: 'index',
      label: '指数过热 / 回撤',
      value: input.index.value,
      score: i.score,
      weight: params.crs.index,
      percentile: percentileRank(input.index.value, input.index.history),
      z: zScore(input.index.value, input.index.history),
      note: i.note,
    })
  }

  /*
   * 动态权重（v0.28.0 改平滑）：回撤 > 阈值 或 收益率倒挂 → 宏观项权重放大。
   *
   * 旧实现是硬开关：回撤 9.9% → ×1，10.1% → ×1.4，总分一次跳 4~6 分，
   * 而真实市场环境并没有在 0.2pp 里发生同等变化。现在在阈值两侧 ±band 内
   * 用 smoothstep 渐变：跨过阈值那一刻只加一半权重，越深越接近满额。
   * 倒挂是二值信号（曲线不会"部分倒挂"），保持硬触发。
   */
  const ddDepth = drawdown === null ? 0 : -drawdown
  const band = Math.max(0, params.dynamic.band ?? 0.02)
  const ddT = band <= 0
    ? (ddDepth > params.dynamic.drawdown ? 1 : 0)
    : clamp((ddDepth - (params.dynamic.drawdown - band)) / (2 * band), 0, 1)
  const smooth = ddT * ddT * (3 - 2 * ddT)
  const ddTriggered = drawdown !== null && ddDepth > params.dynamic.drawdown
  const invTriggered = input.inversion === true
  const dynamicTriggered = { drawdown: ddTriggered, inversion: invTriggered }
  const ddBoost = 1 + (params.dynamic.boost - 1) * smooth
  const boost = invTriggered ? Math.max(ddBoost, params.dynamic.boost) : ddBoost

  const weights = raw.map((f) => {
    if (f.key === 'narrative') return f.weight
    return f.weight * boost
  })
  const weightSum = weights.reduce((a, b) => a + b, 0)
  const factors: CrsFactor[] = raw.map((f, i) => {
    const w = weights[i]
    const normWeight = weightSum > 0 ? (w / weightSum) * 100 : 0
    return {
      key: f.key,
      label: f.label,
      value: f.value,
      percentile: f.percentile,
      z: f.z,
      score: f.score,
      weight: Number(normWeight.toFixed(1)),
      contribution: Number(((f.score * normWeight) / 100).toFixed(1)),
      note: f.note + (boost > 1.001 && f.key !== 'narrative' ? `（动态权重 ×${boost.toFixed(2)}）` : ''),
    }
  })

  const baseScore = Math.round(factors.reduce((s, f) => s + f.contribution, 0))

  // 交叉项：利率 × 信用 的乘积放大（作为额外加分，说明风险路径）
  const ratesFactor = factors.find((f) => f.key === 'rates')
  const creditFactor = factors.find((f) => f.key === 'credit')
  let crossNote = ''
  let crossAdd = 0
  if (ratesFactor && creditFactor) {
    const cross = (ratesFactor.score / 100) * (creditFactor.score / 100)
    crossAdd = Math.round(cross * 8) // 最多 +8 分
    if (crossAdd > 0) {
      crossNote = ` 交叉项 利率×信用 = ${cross.toFixed(2)}，+${crossAdd} 分`
    }
  }
  const finalScore = Math.min(100, baseScore + crossAdd)
  const finalLevel: CrsResult['level'] =
    finalScore >= 70 ? 'high' : finalScore >= 50 ? 'elevated' : finalScore >= 30 ? 'guarded' : 'low'

  // 瀑布图：基础分（各分项基础分之和的起点）+ 各项贡献 + 合计
  const waterfall: CrsResult['waterfall'] = [
    { label: '基础分（0）', value: 0, kind: 'base' },
    ...factors.map((f) => ({ label: f.label, value: f.contribution, kind: 'item' as const })),
    ...(crossNote
      ? [{ label: '交叉项 利率×信用', value: crossAdd, kind: 'item' as const }]
      : []),
    { label: '合计', value: finalScore, kind: 'total' as const },
  ]

  /*
   * 三条诊断子指数（v0.28.0）：把「同样是 60 分」拆成不同处境。
   * 只用于解释，**不参与总分**，所以不会让历史曲线漂移。
   */
  const concentrationScore =
    input.concentration === undefined || input.concentration === null
      ? null
      : scaleLinear(input.concentration, 0.08, 0.4)

  const subIndices = {
    overheat: buildSubIndex(
      '市场过热',
      '涨得太快了吗？',
      [
        { label: '叙事热度（NFI）', score: input.nfi, weight: 50 },
        { label: '指数偏离 200 日均值', score: indexCalc?.overext ?? null, weight: 30 },
        { label: '指数一年涨幅', score: indexCalc?.runup ?? null, weight: 20 },
      ],
      '价格上涨 + 叙事升温同步出现时最高；它描述的是"回调风险在积累"，不代表已经出事。',
    ),
    stress: buildSubIndex(
      '当前压力',
      '已经出事了么？',
      [
        { label: '信用利差绝对水平', score: creditCalc?.stress ?? null, weight: 30 },
        { label: '信用利差走阔', score: creditCalc?.widening ?? null, weight: 20 },
        { label: '利率压力', score: ratesCalc?.score ?? null, weight: 25 },
        { label: '指数回撤', score: indexCalc?.ddScore ?? null, weight: 25 },
      ],
      '只看"已经发生的压力"：利差高位、利率冲击、实际回撤。这条高，说明风险正在兑现。',
    ),
    fragility: buildSubIndex(
      '潜在脆弱',
      '看起来很好但很脆么？',
      [
        { label: '利差过窄（自满）', score: creditCalc?.complacency ?? null, weight: 50 },
        { label: '叙事集中度', score: concentrationScore, weight: 30 },
        { label: '收益率曲线倒挂', score: input.inversion === null ? null : input.inversion ? 100 : 0, weight: 20 },
      ],
      '低利差、高度集中的叙事、曲线倒挂 —— 都是"表面上没事"的脆弱性来源，是最容易被忽略的一类。',
    ),
  }

  const p = params.probability
  const center = clamp(p.base * Math.exp((finalScore - 50) / p.scale), 0.03, 0.6)
  // 上限：中心值封顶 60% + 带宽 5pp = 65%（旧代码写 0.75，与文档的 75% 一起是错的）
  const HIGH_CAP = 0.65

  return {
    score: finalScore,
    level: finalLevel,
    factors,
    waterfall,
    subIndices,
    probability12m: {
      low: Math.round(Math.max(0.02, center - p.band) * 100),
      high: Math.round(Math.min(HIGH_CAP, center + p.band) * 100),
      label: '12 个月情景参考值',
      scope: '美国市场（10Y/2Y 美债、高收益债 OAS、纳斯达克）',
      note:
        `以 ${(p.base * 100).toFixed(0)}%/年 基础率为锚、按风险分指数调整（scale=${p.scale}）±${(p.band * 100).toFixed(0)}pp。` +
        `**这是启发式情景映射，不是预测概率**：参数为人工设定、未经历史回测校准，` +
        `且只覆盖美国市场，不能外推为"全球金融危机概率"${crossNote}`,
    },
    dynamicTriggered,
  }
}

/** 子指数：内部信号加权平均；缺项的按剩余权重归一（与 NFI 同一套规矩） */
function buildSubIndex(
  label: string,
  question: string,
  defs: { label: string; score: number | null; weight: number }[],
  note: string,
): SubIndex {
  const effective = defs.filter((d) => d.score !== null && d.weight > 0)
  const weightSum = effective.reduce((s, d) => s + d.weight, 0)
  const score =
    weightSum === 0
      ? 0
      : Math.round(effective.reduce((s, d) => s + (d.score as number) * d.weight, 0) / weightSum)
  return {
    score,
    label,
    question,
    note,
    parts: effective.map((d) => ({
      label: d.label,
      score: Math.round(d.score as number),
      weight: Math.round((d.weight / weightSum) * 100),
    })),
  }
}

// ============================ 背离检测 ============================

export type DivergenceType = 'sentiment_price' | 'heat_funding' | 'narrative_macro'

export interface Divergence {
  type: DivergenceType
  typeLabel: string
  severity: 'warning' | 'critical'
  title: string
  detail: string
  /** 涉及的实体（可空） */
  entity: string | null
  metrics: { label: string; value: string }[]
}

export interface DivergenceInput {
  /** 情绪分 0~100（乐观度） */
  optimism: number | null
  /** 指数连续下跌天数 */
  indexDownDays: number
  /** 实体报道量激增倍数 */
  heatSurgeRatio: number | null
  /** 融资事件变化（负数=减少） */
  fundingChangeRatio: number | null
  entity: string | null
  /** 叙事热度（融资类占比） */
  moneyShare: number
  /** 指数近期变化 */
  indexChange: number | null
  params: RiskParams
}

/** 背离检测：三种背离 */
export function detectDivergences(input: DivergenceInput): Divergence[] {
  const p = input.params.divergence
  const out: Divergence[] = []

  // ① 情绪与价格背离：情绪极乐观但指数连跌
  if (
    input.optimism !== null &&
    input.optimism >= p.optimisticSentiment &&
    input.indexDownDays >= p.downDays
  ) {
    out.push({
      type: 'sentiment_price',
      typeLabel: '情绪 × 价格背离',
      severity: input.indexDownDays >= p.downDays + 2 ? 'critical' : 'warning',
      title: `情绪极乐观（${input.optimism}）但指数连续 ${input.indexDownDays} 天下跌`,
      detail:
        '叙事热度与价格走势相反：乐观情绪可能建立在尚未被价格确认的预期上，这类背离常出现在情绪顶部的特征。',
      entity: input.entity,
      metrics: [
        { label: '情绪分', value: String(input.optimism) },
        { label: '指数连跌', value: `${input.indexDownDays} 天` },
        { label: '指数近况', value: input.indexChange === null ? '—' : `${(input.indexChange * 100).toFixed(1)}%` },
      ],
    })
  }

  // ② 热度与融资背离：报道量激增但融资事件骤降
  if (
    input.heatSurgeRatio !== null &&
    input.fundingChangeRatio !== null &&
    input.heatSurgeRatio >= p.surgeRatio &&
    input.fundingChangeRatio <= -p.fundingDropRatio
  ) {
    out.push({
      type: 'heat_funding',
      typeLabel: '热度 × 融资背离',
      severity: 'warning',
      title: `报道量 ×${input.heatSurgeRatio.toFixed(1)}，但融资事件 ${(input.fundingChangeRatio * 100).toFixed(0)}%`,
      detail: '讨论热度和真实资金动作脱节：热度来自二手传播而非一级市场投入。',
      entity: input.entity,
      metrics: [
        { label: '热度倍数', value: `×${input.heatSurgeRatio.toFixed(1)}` },
        { label: '融资变化', value: `${(input.fundingChangeRatio * 100).toFixed(0)}%` },
      ],
    })
  }

  // ③ 叙事与宏观背离：AI 融资叙事很热，但指数被利率压制
  if (input.moneyShare >= 0.08 && input.indexChange !== null && input.indexChange < -0.03) {
    out.push({
      type: 'narrative_macro',
      typeLabel: '叙事 × 宏观背离',
      severity: input.indexChange < -0.08 ? 'critical' : 'warning',
      title: `融资叙事占比 ${(input.moneyShare * 100).toFixed(1)}%，但指数 ${(input.indexChange * 100).toFixed(1)}%`,
      detail: 'AI 叙事很热、宏观在压制估值（利率/流动性）——典型的"叙事与基本面错位"阶段。',
      entity: input.entity,
      metrics: [
        { label: '融资类占比', value: `${(input.moneyShare * 100).toFixed(1)}%` },
        { label: '指数近况', value: `${(input.indexChange * 100).toFixed(1)}%` },
      ],
    })
  }

  return out
}

// ============================ 工具 ============================

function round(x: number, digits: number): number {
  const f = 10 ** digits
  return Math.round(x * f) / f
}
