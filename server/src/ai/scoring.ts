/**
 * 信源权重进打分（v0.12.0）
 *
 * 为什么要有：官方一手源（OpenAI News、官方博客）与聚合源（HN、MarkTechPost）
 * 的"可信度/信息量"不一样。之前 weight 只写进 score_parts 用于展示，
 * AI 打分的路径上完全没生效——于是聚合源靠"标题党"就能挤进版面。
 *
 * 设计取舍：
 * · 用**加减分**而不是乘法：乘法会让 90 分的官方消息冲到 100+ 被截断，失去区分度
 * · 幅度取 ±5：足够把权重 1 的高分条目从 62 压到 57（掉出深加工线），又不会让真正的重大消息翻不了身
 * · 只在**入库时**生效，不改历史数据（旧数据的 base 分没存，回溯会失真）
 */
export const WEIGHT_BONUS = { aggregate: -5, media: 0, official: 5 } as const

/** 1 = 聚合，2 = 媒体，3 = 官方一手 */
export function weightBonus(weight: number): number {
  if (weight >= 3) return WEIGHT_BONUS.official
  if (weight <= 1) return WEIGHT_BONUS.aggregate
  return WEIGHT_BONUS.media
}

export interface WeightedScore {
  /** 加权后的最终分（0~100 整数） */
  score: number
  /** 模型/规则给出的原始分 */
  baseScore: number
  /** 权重加减了多少（写进 score_parts，便于解释） */
  bonus: number
}

export function applySourceWeight(baseScore: number, weight: number): WeightedScore {
  const bonus = weightBonus(weight)
  const raw = Number.isFinite(baseScore) ? baseScore : 0
  return {
    score: Math.max(0, Math.min(100, Math.round(raw + bonus))),
    baseScore: Math.round(raw),
    bonus,
  }
}
