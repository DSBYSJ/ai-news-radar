import type { DatabaseSync } from 'node:sqlite'
import { config } from '../config.ts'
import { loadMacro, type MacroSnapshot } from './macro.ts'
import { narrativeFroth, type NarrativeReport, type RiskFactor } from './narrative.ts'

/**
 * AI 估值与金融危机风险模块（独立模块，不依赖其它业务代码）
 *
 * 输出分两级，**刻意不一致**：
 *   A. 叙事泡沫指数 NFI（0~100）—— 只用库里的新闻，随时可算
 *   B. 危机风险分 CRS（0~100）+ 12 个月概率区间 —— **必须有宏观数据**，
 *      否则返回 null 并说明缺什么
 *
 * 为什么不给"新闻版危机概率"：新闻只反映"大家在聊什么"，不反映"资产多贵、钱多贵"。
 * 缺利率与信用利差时，任何概率数字都是虚构的。这条写进 disclaimer，前端也照此展示。
 */

export interface CrisisAssessment {
  /** 0~100；越大越危险 */
  score: number
  level: 'low' | 'guarded' | 'elevated' | 'high'
  /** 未来 12 个月的危机概率区间（百分比）；无法可靠估计时为 null */
  probability12m: { low: number; high: number; note: string } | null
  factors: RiskFactor[]
}

export interface RiskReport {
  generatedAt: string
  /** 新闻窗口（天） */
  windowDays: number
  narrative: NarrativeReport
  macro: MacroSnapshot
  /** 需要宏观数据；宏观不可用时为 null */
  crisis: CrisisAssessment | null
  /** 模块边界与免责说明，前端原样展示 */
  disclaimer: string
}

const DISCLAIMER =
  '本模块分两级：叙事泡沫指数（NFI）只用站内新闻，衡量「讨论有多热」；' +
  '危机风险分（CRS）必须接入利率、信用利差、指数三类宏观数据才计算。' +
  'NFI 不是估值模型（新闻里没有估值倍数），CRS 的概率区间是基于历史基础率的启发式，' +
  '既不是预测也不构成任何投资建议。'

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x))
}

function scale(value: number, lo: number, hi: number): number {
  if (!Number.isFinite(value) || hi <= lo) return 0
  return Math.round(clamp01((value - lo) / (hi - lo)) * 100)
}

/** 宏观三项 → 0~100 的风险分 */
function macroFactors(macro: MacroSnapshot): RiskFactor[] {
  const factors: RiskFactor[] = []
  const rates = macro.series.rates10y
  const credit = macro.series.creditSpread
  const nasdaq = macro.series.nasdaq

  if (rates) {
    const levelScore = scale(rates.value, 3.5, 5.5)
    const change = rates.yearAgo === null ? 0 : rates.value - rates.yearAgo
    const changeScore = scale(change, 0, 1.5)
    factors.push({
      key: 'rates',
      label: '利率压力',
      value: Number(rates.value.toFixed(2)),
      score: Math.round(0.6 * levelScore + 0.4 * changeScore),
      weight: 20,
      note: `10Y ${rates.value.toFixed(2)}%（一年前 ${rates.yearAgo?.toFixed(2) ?? '—'}）；利率越高、上行越快，长久期资产越脆`,
    })
  }

  if (credit) {
    // 两头都是风险：极窄=自满，快速走阔=已经开始出事，取两者较大值
    const tightness = scale(3.5 - credit.value, -0.5, 1.2)
    const widening = credit.yearAgo === null ? 0 : scale(credit.value - credit.yearAgo, 0, 2)
    factors.push({
      key: 'credit',
      label: '信用环境',
      value: Number(credit.value.toFixed(2)),
      score: Math.max(tightness, widening),
      weight: 20,
      note: `高收益债 OAS ${credit.value.toFixed(2)}%；利差极窄=自满，快速走阔=已承压，取两者较大`,
    })
  }

  if (nasdaq) {
    const overext = nasdaq.avg200 ? scale(nasdaq.value / nasdaq.avg200 - 1, 0.02, 0.25) : 0
    const runup = nasdaq.yearAgo ? scale(nasdaq.value / nasdaq.yearAgo - 1, 0.1, 0.6) : 0
    factors.push({
      key: 'index',
      label: '指数过热',
      value: Number(nasdaq.value.toFixed(0)),
      score: Math.round(0.5 * overext + 0.5 * runup),
      weight: 20,
      note: nasdaq.avg200
        ? `纳指 ${nasdaq.value.toFixed(0)}，较 200 日均值 ${((nasdaq.value / nasdaq.avg200 - 1) * 100).toFixed(1)}%，一年涨 ${((nasdaq.value / (nasdaq.yearAgo ?? nasdaq.value) - 1) * 100).toFixed(1)}%`
        : `纳指 ${nasdaq.value.toFixed(0)}（200 日均值样本不足）`,
    })
  }

  return factors
}

export async function riskReport(
  db: DatabaseSync,
  opts: { days?: number; now?: number; macroKey?: string; macro?: MacroSnapshot } = {},
): Promise<RiskReport> {
  const narrative = narrativeFroth(db, { days: opts.days, now: opts.now })
  const macro = opts.macro ?? (await loadMacro(opts.macroKey ?? config.fredApiKey))

  let crisis: CrisisAssessment | null = null
  const macroFactorList = macroFactors(macro)

  if (macro.available && macroFactorList.length > 0) {
    const factors: RiskFactor[] = [...macroFactorList]
    // 叙事指数作为一个分项并入（40% 权重），宏观三项各 20%
    if (narrative.nfi !== null) {
      factors.unshift({
        key: 'narrative',
        label: '叙事过热（NFI）',
        value: narrative.nfi,
        score: narrative.nfi,
        weight: 40,
        note: '来自站内新闻的叙事温度，非估值指标',
      })
    }
    const weightSum = factors.reduce((s, f) => s + f.weight, 0)
    const score = Math.round(factors.reduce((s, f) => s + (f.score ?? 0) * f.weight, 0) / weightSum)
    const level: CrisisAssessment['level'] = score >= 70 ? 'high' : score >= 50 ? 'elevated' : score >= 30 ? 'guarded' : 'low'

    /*
     * 概率区间：以 12%/年 的"危机基础率"为锚，按风险分做指数调整，再给 ±5pp 区间。
     * 参数是**人为设定并写在这里的**，不是回测拟合结果 —— 所以只给区间与量级，不给小数点。
     */
    const center = Math.max(0.03, Math.min(0.6, 0.12 * Math.exp((score - 50) / 28)))
    crisis = {
      score,
      level,
      probability12m: {
        low: Math.round(Math.max(0.02, center - 0.05) * 100),
        high: Math.round(Math.min(0.75, center + 0.05) * 100),
        note: '以 12%/年 的危机基础率为锚、按风险分指数调整；参数人为设定，非回测拟合，仅供量级参考',
      },
      factors,
    }
  }

  return {
    generatedAt: new Date().toISOString(),
    windowDays: narrative.windowDays,
    narrative,
    macro,
    crisis,
    disclaimer: DISCLAIMER,
  }
}
