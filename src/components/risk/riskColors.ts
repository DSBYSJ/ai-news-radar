/**
 * 风险色映射（全局统一，v0.27.0）
 *
 * 0–30  冷灰（常态）    → 30–50 荧光蓝（关注）
 * 50–70 橙黄（警告）    → 70+   猩红（高危 + 呼吸灯）
 *
 * 所有风险组件（仪表盘/瀑布/雷达/散点/跑马灯）都从这里取色，
 * 避免各组件自己发明一套颜色。
 */

export type RiskBand = 'calm' | 'attention' | 'warn' | 'critical'

export function bandOf(score: number | null | undefined): RiskBand {
  if (score === null || score === undefined || !Number.isFinite(score)) return 'calm'
  if (score >= 70) return 'critical'
  if (score >= 50) return 'warn'
  if (score >= 30) return 'attention'
  return 'calm'
}

export const RISK_COLOR: Record<RiskBand, string> = {
  calm: '#7c8797',
  attention: '#3da9fc',
  warn: '#f5a623',
  critical: '#e5484d',
}

export const RISK_LABEL: Record<RiskBand, string> = {
  calm: '常态',
  attention: '关注',
  warn: '警告',
  critical: '高危',
}

/** 常态绿（宏观指标"正常"用绿色，异常才用红） */
export const HEALTHY = '#22c55e'

/**
 * 分位数 → 颜色（宏观卡片用）
 *
 * 原则：**正常用绿、异常才用红**，避免满屏告警色。
 *   < 75% 分位 → 绿（常态）
 *   75–95%    → 橙（关注）
 *   ≥ 95%     → 红（异常，才配红）
 */
export function percentileColor(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return HEALTHY
  if (p >= 0.95) return RISK_COLOR.critical
  if (p >= 0.75) return RISK_COLOR.warn
  return HEALTHY
}

/** 语义型指标（如收益率曲线）：正常=绿、倒挂=红 */
export function semanticColor(ok: boolean): string {
  return ok ? HEALTHY : RISK_COLOR.critical
}

export function colorOf(score: number | null | undefined): string {
  return RISK_COLOR[bandOf(score)]
}

/** 仪表盘的分段（外圈色带） */
export const GAUGE_STOPS: { from: number; to: number; color: string }[] = [
  { from: 0, to: 30, color: RISK_COLOR.calm },
  { from: 30, to: 50, color: RISK_COLOR.attention },
  { from: 50, to: 70, color: RISK_COLOR.warn },
  { from: 70, to: 100, color: RISK_COLOR.critical },
]

/** 历史灾难刻度（CRS 半环外圈的参考标记；分值为示意值，用于对照量级） */
export const DISASTER_MARKS: { score: number; label: string; year: string }[] = [
  { score: 88, label: '次贷危机', year: '2008' },
  { score: 76, label: '熔断潮', year: '2020' },
  { score: 58, label: '硅谷银行', year: '2023' },
]
