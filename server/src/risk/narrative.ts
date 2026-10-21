import type { DatabaseSync } from 'node:sqlite'
import { fomoCoefficient } from './calculation.ts'

/**
 * 叙事泡沫指数（Narrative Froth Index, NFI）
 *
 * ⚠️ 先说清它**不是**什么：
 *   它不是估值模型，也不预测崩盘。本项目的数据只有新闻（标题/摘要/分类/实体/情感），
 *   没有股价、估值倍数、利率、信用利差 —— 用新闻反推"估值高不高"是不成立的。
 *
 * 它**是**什么：
 *   一个可复现的「AI 叙事温度计」—— 衡量市场**讨论**有多热、多集中、多加速。
 *   历史经验里，叙事过热是泡沫的必要条件（不是充分条件），所以它只做**风险提示**，
 *   不做买卖建议，也不单独输出"危机概率"。
 *
 * 五个分项（权重合计 100）：
 *   1. 融资/上市密度  25  —— 「AI 圈的注意力有多少落在钱上」
 *   2. 情绪偏正度     25  —— 正面 - 负面 的净偏向
 *   3. 叙事集中度     20  —— 前 5 实体占比（HHI 思路：越集中越脆弱）
 *   4. 热度加速度     20  —— 近 7 天日均 / 前 7 天日均
 *   5. 亢奋词密度     10  —— 暴涨/翻倍/抢购/售罄 这类词的每百条出现数
 *
 * 注意：**「泡沫」这个词本身不计入分数**。它更多代表"市场开始担心"，方向上是反的，
 *      所以单独作为「风险意识」指标展示，不参与加权。
 */

export interface RiskFactor {
  key: string
  label: string
  /** 原始测量值（已按 note 里说明的单位） */
  value: number | null
  /** 归一化到 0~100 的分项得分；null = 样本不足，不参与加权 */
  score: number | null
  weight: number
  note: string
}

export type RiskBand = 'calm' | 'warm' | 'hot'

export interface NarrativeReport {
  windowDays: number
  articles: number
  classified: number
  /** 0~100；无法计算时为 null（样本太少） */
  nfi: number | null
  band: RiskBand | 'unknown'
  factors: RiskFactor[]
  /** 不计分的观察项 */
  observations: { key: string; label: string; value: string }[]
  latestDate: string | null
}

/** 融资/上市类信号词（与 categories 的 funding 互补：分类可能落到 other） */
const MONEY_WORDS = ['融资', '估值', 'ipo', '上市', '轮融资', '独角兽', '超额认购', '市值', '募资', 'series']
/** 亢奋词：只描述"热"，不描述"对错" */
const FROTH_WORDS = ['暴涨', '翻倍', '新高', '创纪录', '抢购', '售罄', '疯抢', '秒空', '颠覆', '千亿', '万亿', '狂飙']
/** 风险意识词（不计分，只展示方向） */
const AWARE_WORDS = ['泡沫', '过热', '回调', '崩盘', '风险', '泡沫化', '见顶']

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

/** 线性映射到 0~100：value 从 lo 到 hi 对应 0 到 100 */
function scale(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi <= lo) return 0
  return Math.round(clamp01((value - lo) / (hi - lo)) * 100)
}

function hitAny(text: string, words: string[]): boolean {
  const t = text.toLowerCase()
  return words.some((w) => t.includes(w))
}

interface Row {
  title: string
  summary: string | null
  category: string
  entities: string | null
  sentiment: string | null
  published_at: string
}

export function narrativeFroth(db: DatabaseSync, opts: { days?: number; now?: number } = {}): NarrativeReport {
  const days = Math.max(7, Math.min(180, opts.days ?? 30))
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10)

  const rows = db
    .prepare(
      `SELECT a.title, a.summary, a.category, a.entities, a.sentiment, a.published_at
         FROM articles a
        WHERE a.ai_relevant = 1 AND date(a.published_at) >= ?
        ORDER BY a.published_at DESC`,
    )
    .all(cutoff) as unknown as Row[]

  const total = rows.length
  const latestDate = total > 0 ? rows[0].published_at.slice(0, 10) : null

  if (total < 20) {
    return {
      windowDays: days,
      articles: total,
      classified: 0,
      nfi: null,
      band: 'unknown',
      factors: [],
      observations: [{ key: 'sample', label: '样本', value: `近 ${days} 天只有 ${total} 条，不足以计算` }],
      latestDate,
    }
  }

  // ---- 1) 融资/上市密度 ----
  const moneyCount = rows.filter(
    (r) => r.category === 'funding' || hitAny(`${r.title} ${r.summary ?? ''}`, MONEY_WORDS),
  ).length
  const moneyShare = moneyCount / total

  // ---- 2) 情绪偏正度 ----
  const classifiedRows = rows.filter((r) => r.sentiment === 'positive' || r.sentiment === 'negative' || r.sentiment === 'neutral')
  const classified = classifiedRows.length
  const pos = classifiedRows.filter((r) => r.sentiment === 'positive').length
  const neg = classifiedRows.filter((r) => r.sentiment === 'negative').length
  const skew = classified > 0 ? (pos - neg) / classified : null

  // ---- 3) 叙事集中度：前 5 实体占比 ----
  const entityCount = new Map<string, number>()
  for (const r of rows) {
    if (!r.entities) continue
    try {
      const list = JSON.parse(r.entities) as unknown
      if (!Array.isArray(list)) continue
      for (const name of list) {
        if (typeof name !== 'string' || !name.trim()) continue
        entityCount.set(name, (entityCount.get(name) ?? 0) + 1)
      }
    } catch {
      // 脏数据跳过
    }
  }
  const entityTotal = [...entityCount.values()].reduce((a, b) => a + b, 0)
  const top5 = [...entityCount.values()]
    .sort((a, b) => b - a)
    .slice(0, 5)
    .reduce((a, b) => a + b, 0)
  const top5Share = entityTotal > 0 ? top5 / entityTotal : null

  // ---- 4) 热度加速度：近 7 天日均 vs 前 7 天日均 ----
  const dayMs = 86_400_000
  const inRange = (r: Row, from: number, to: number): boolean => {
    const t = Date.parse(r.published_at)
    return t >= now - from * dayMs && t < now - to * dayMs
  }
  const recent = rows.filter((r) => inRange(r, 7, 0)).length / 7
  const prev = rows.filter((r) => inRange(r, 14, 7)).length / 7
  const accel = prev > 0 ? recent / prev : recent > 0 ? 2 : 0
  // 超过 3 倍基本是「采集面变了」（加源/回填），不是热度变化 —— 封顶并注明
  const ACCEL_MAX = 3
  const accelCapped = Math.min(accel, ACCEL_MAX)

  // ---- 5) 亢奋词密度（每百条） ----
  const frothCount = rows.filter((r) => hitAny(`${r.title} ${r.summary ?? ''}`, FROTH_WORDS)).length
  const frothPer100 = (frothCount / total) * 100

  const factors: RiskFactor[] = [
    {
      key: 'money',
      label: '融资/上市密度',
      value: Number((moneyShare * 100).toFixed(1)),
      score: scale(moneyShare, 0.02, 0.12),
      weight: 25,
      note: `近 ${days} 天 ${moneyCount}/${total} 条涉及融资/估值/IPO（%）；2%→0 分，12%→100 分`,
    },
    {
      key: 'sentiment',
      label: '情绪偏正度',
      value: skew === null ? null : Number(skew.toFixed(2)),
      score: skew === null ? null : scale(skew, 0, 0.6),
      weight: 25,
      note:
        skew === null
          ? '情感判定样本不足，暂不参与加权'
          : `(正面−负面)/已判定 = ${skew.toFixed(2)}；0→0 分，0.6→100 分`,
    },
    {
      key: 'concentration',
      label: '叙事集中度',
      value: top5Share === null ? null : Number((top5Share * 100).toFixed(1)),
      score: top5Share === null ? null : scale(top5Share, 0.08, 0.4),
      weight: 20,
      note:
        top5Share === null
          ? '实体抽取为空，暂不参与加权'
          : `前 5 实体占总提及 ${(top5Share * 100).toFixed(1)}%；8%→0 分，40%→100 分`,
    },
    {
      key: 'acceleration',
      label: '热度加速度',
      value: prev >= 5 && accel <= ACCEL_MAX ? Number(accel.toFixed(2)) : null,
      /*
       * ⚠️ 基期门槛：前 7 天日均 < 1 条时，「加速度」会算出 10 倍、20 倍这种假信号
       * （本期刚上线、上一周几乎没数据时实测出现过 19.99）。这时不参与加权，只如实说明。
       */
      score: prev >= 5 && accel <= ACCEL_MAX ? scale(accel, 1, 2.5) : null,
      weight: 20,
      note:
        prev < 5
          ? `前 7 天日均仅 ${prev.toFixed(1)} 条（<5），加速度不可比，本项不参与加权`
          : accel > ACCEL_MAX
            ? `近 7 天 ${recent.toFixed(1)} 条/天 vs 前 7 天 ${prev.toFixed(1)} 条/天 = ${accel.toFixed(1)} 倍，` +
              '超过 3 倍通常意味着「采集面变了」（加源/回填），不是热度变化 —— 本项不参与加权'
            : `近 7 天日均 ${recent.toFixed(1)} / 前 7 天日均 ${prev.toFixed(1)} = ${accel.toFixed(2)}；1.0→0 分，2.5→100 分`,
    },
    {
      key: 'froth',
      label: '亢奋词密度',
      value: Number(frothPer100.toFixed(1)),
      score: scale(frothPer100, 2, 25),
      weight: 10,
      note: `含「暴涨/翻倍/抢购/售罄」等词的条目每百条 ${frothPer100.toFixed(1)} 条；2→0 分，25→100 分`,
    },
  ]

  // 加权平均（未参与的分项按剩余权重重新归一）
  let sum = 0
  let weightSum = 0
  for (const f of factors) {
    if (f.score === null) continue
    sum += f.score * f.weight
    weightSum += f.weight
  }
  const nfi = weightSum > 0 ? Math.round(sum / weightSum) : null
  const band: RiskBand | 'unknown' = nfi === null ? 'unknown' : nfi >= 65 ? 'hot' : nfi >= 38 ? 'warm' : 'calm'

  // 风险意识：不计分，只给方向
  const awareCount = rows.filter((r) => hitAny(`${r.title} ${r.summary ?? ''}`, AWARE_WORDS)).length
  const observations = [
    {
      key: 'awareness',
      label: '风险意识',
      value: `提到「泡沫/过热/回调」的条目 ${awareCount} 条（${((awareCount / total) * 100).toFixed(1)}%）—— 不计分：这类词变多通常说明市场自己开始担心，方向是反的`,
    },
    { key: 'classified', label: '情感样本', value: `${classified}/${total} 条已判定情感` },
    { key: 'entities', label: '实体样本', value: `${entityCount.size} 个不同实体，共 ${entityTotal} 次提及` },
  ]

  return { windowDays: days, articles: total, classified, nfi, band, factors, observations, latestDate }
}

/**
 * 叙事原始输入（v0.26.0）：把 NFI 需要的原始量一次性算出来，
 * v1（narrativeFroth）与 v2（computeNfi）共用，避免两套口径。
 */
export interface NarrativeInputs {
  windowDays: number
  articles: number
  classified: number
  positive: number
  negative: number
  /** 融资/上市类占比 0~1 */
  moneyShare: number
  /** 情绪偏正 -1~1 */
  sentimentSkew: number | null
  /** 乐观度 0~100（正面占比） */
  optimism: number | null
  /** 前 5 实体占比 0~1 */
  concentration: number | null
  /** 热度加速度：7 日均线的环比变化率（1 = 不变） */
  acceleration: number | null
  /** FOMO 系数（感叹号 + 追高词） */
  fomo: { score: number; hits: string[]; exclaimDensity: number }
  latestDate: string | null
}

export function narrativeInputs(db: DatabaseSync, opts: { days?: number; now?: number } = {}): NarrativeInputs {
  const days = Math.max(7, Math.min(180, opts.days ?? 30))
  const now = opts.now ?? Date.now()
  const cutoff = new Date(now - days * 86_400_000).toISOString().slice(0, 10)

  const rows = db
    .prepare(
      `SELECT a.title, a.summary, a.category, a.entities, a.sentiment, a.published_at
         FROM articles a
        WHERE a.ai_relevant = 1 AND date(a.published_at) >= ?`,
    )
    .all(cutoff) as unknown as {
    title: string
    summary: string | null
    category: string
    entities: string | null
    sentiment: string | null
    published_at: string
  }[]

  const total = rows.length
  const moneyCount = rows.filter((r) => r.category === 'funding' || hitAny(`${r.title} ${r.summary ?? ''}`, MONEY_WORDS)).length
  const classifiedRows = rows.filter((r) => r.sentiment !== null)
  const positive = classifiedRows.filter((r) => r.sentiment === 'positive').length
  const negative = classifiedRows.filter((r) => r.sentiment === 'negative').length
  const classified = classifiedRows.length
  const sentimentSkew = classified > 0 ? (positive - negative) / classified : null
  const optimism = classified > 0 ? Math.round((positive / classified) * 100) : null

  // 实体集中度
  const entityCount = new Map<string, number>()
  for (const r of rows) {
    if (!r.entities) continue
    try {
      const list = JSON.parse(r.entities) as unknown
      if (!Array.isArray(list)) continue
      for (const name of list) {
        if (typeof name !== 'string' || !name.trim()) continue
        entityCount.set(name, (entityCount.get(name) ?? 0) + 1)
      }
    } catch {
      /* 脏数据跳过 */
    }
  }
  const entityTotal = [...entityCount.values()].reduce((a, b) => a + b, 0)
  const top5 = [...entityCount.values()].sort((a, b) => b - a).slice(0, 5).reduce((a, b) => a + b, 0)
  const concentration = entityTotal > 0 ? top5 / entityTotal : null

  // 热度加速度：7 日均线的环比变化率
  const dayMs = 86_400_000
  const inRange = (r: { published_at: string }, from: number, to: number): boolean => {
    const t = Date.parse(r.published_at)
    return t >= now - from * dayMs && t < now - to * dayMs
  }
  const recent = rows.filter((r) => inRange(r, 7, 0)).length / 7
  const prev = rows.filter((r) => inRange(r, 14, 7)).length / 7
  const acceleration = prev >= 1 ? recent / prev : null

  // FOMO：标题+摘要里的追高词与感叹号
  const fomo = fomoCoefficient(rows.map((r) => `${r.title} ${r.summary ?? ''}`))

  return {
    windowDays: days,
    articles: total,
    classified,
    positive,
    negative,
    moneyShare: total > 0 ? moneyCount / total : 0,
    sentimentSkew,
    optimism,
    concentration,
    acceleration,
    fomo,
    latestDate: total > 0 ? rows[0].published_at.slice(0, 10) : null,
  }
}
