import type { DatabaseSync } from 'node:sqlite'
import { computeCrs, percentileRank, type RiskParams } from './calculation.ts'
import { buildMacroInput, indexAt, inversionAt, loadSeries, valueAt } from './macroHistory.ts'
import { loadParams } from './params.ts'

/**
 * 风险模型历史回测（v0.28.0）
 *
 * 目的：回答一个之前没法回答的问题 —— **这个分数到底有没有识别能力？**
 *
 * 三条铁律（写在这里是为了防止以后改坏）：
 *   1. **point-in-time**：t 日的特征只能用 t 日及以前的观测。历史分位、均线、52 周高点
 *      全部用 `macroHistory.buildMacroInput` 现算，绝不拿全量序列直接算完再对齐日期。
 *   2. **按时间顺序**：训练段（默认 2013–2019）选阈值，测试段（2020 起）只用来评估。
 *      绝不对相邻日期随机划分 —— 12 个月预测窗口高度重叠，随机划分必然泄漏。
 *   3. **分开评估事件**：回撤 / 利差走阔 / 系统性危机各算各的，不混成一个"金融危机"标签。
 *
 * 已知局限（会打印在报告里）：
 *   - 月度采样仍有 12 个月重叠 → 有效独立样本 ≈ 样本数/12，AUC 的置信区间远比点数看起来宽
 *   - 危机是稀有事件，正样本只有个位数到十几个，任何结论都只能算"初步"
 *   - 信用利差（BAMLH0A0HYM2）历史长度取决于采集时的 cosd，可能不足 20 年
 */

export type EventKey = 'drawdown20' | 'credit_widen_1pp' | 'systemic'

export const EVENT_LABELS: Record<EventKey, string> = {
  drawdown20: '未来 12 个月纳指最大回撤 ≥ 20%',
  credit_widen_1pp: '未来 12 个月信用利差走阔 ≥ 1pp',
  systemic: '未来 12 个月发生系统性银行/市场危机（人工事件表）',
}

/**
 * 回测用的信用利差序列与阈值。
 *
 * 为什么不用生产口径的高收益 OAS：FRED 的 fredgraph.csv 对 BAMLH0A0HYM2 只给约 3 年，
 * 3 年样本不足以做跨周期验证。改用 BAA10Y（2013 年起完整），并把阶跃阈值从
 * 高收益 OAS 的 4.5% 下调到 Baa 利差的 3.0%（Baa 利差长期在 1.4~3.5% 区间）。
 * ⚠️ 因此本回测评估的是「CRS 的宏观骨架」，不是生产分数的逐点复现。
 */
const BACKTEST_CREDIT_SERIES = 'creditSpreadLong'
const BACKTEST_CREDIT_STEP = 3.0

/**
 * 系统性危机事件表（只放**已经发生**的公开事件，且只收"系统性"级别的）。
 *
 * 刻意**不**收录 2015 贬值冲击 / 2018 Q4 急跌 / 2022 加息杀估值：
 * 它们是显著的市场调整，但不属于"系统性银行/市场危机"。
 * 混进来的后果是正样本被稀释成 30%+ 的基础发生率，"预警能力"看起来虚高。
 *
 * 代价是：数据从 2013 起，只剩 2 个事件 —— 统计上几乎没有检验力。
 * 这个限制必须写进报告，而不是靠加事件把样本凑大。
 */
export const SYSTEMIC_EVENTS = [
  { date: '2020-02-24', label: '2020 COVID 熔断潮' },
  { date: '2023-03-08', label: '2023 硅谷银行事件' },
]

export interface Features {
  crs: number
  overheat: number
  stress: number
  fragility: number
  oas: number | null
  oasPct: number | null
  drawdown: number | null
  rates: number | null
}

export interface Sample {
  date: string
  features: Features
  labels: Record<EventKey, 0 | 1 | null>
}

export interface Metrics {
  event: EventKey
  label: string
  samples: number
  positives: number
  baseRate: number
  /** 模型分数的 AUC（0.5 = 随机） */
  auc: number
  /** 单指标基线 AUC（同一样本集） */
  baselines: { name: string; auc: number }[]
  /** 阈值告警的命中率 / 误报率 / 精确率 */
  atThreshold: { threshold: number; hitRate: number; falseAlarmRate: number; precision: number; alertsPerYear: number }
  /** 真实事件发生前，模型首次越过阈值的提前天数中位数 */
  medianLeadDays: number | null
  /** 有效独立样本估计（重叠窗口校正） */
  effectiveSamples: number
}

export interface BacktestReport {
  generatedAt: string
  params: RiskParams
  dataRange: { from: string; to: string }
  trainWindow: { from: string; to: string }
  testWindow: { from: string; to: string }
  sampling: string
  events: Record<EventKey, { train: Metrics; test: Metrics }>
  caveats: string[]
  seriesCoverage: { series: string; rows: number; from: string; to: string }[]
}

const DAY = 86_400_000

/** 前向最大回撤：从 t 起的 252 个观测内，相对区间内峰值的最大跌幅（正数，0.2 = 20%） */
export function forwardMaxDrawdown(values: number[], start: number, horizon: number): number | null {
  if (start + horizon >= values.length) return null
  let peak = values[start]
  let maxDd = 0
  for (let i = start; i <= start + horizon; i++) {
    if (values[i] > peak) peak = values[i]
    const dd = 1 - values[i] / peak
    if (dd > maxDd) maxDd = dd
  }
  return maxDd
}

/** 前向最大涨幅（用于利差走阔，单位与原序列一致） */
export function forwardMaxRise(values: number[], start: number, horizon: number): number | null {
  if (start + horizon >= values.length) return null
  let maxV = -Infinity
  for (let i = start; i <= start + horizon; i++) maxV = Math.max(maxV, values[i])
  return maxV - values[start]
}

function hasSystemicEvent(date: string, horizonDays: number): boolean {
  const from = Date.parse(date)
  const to = from + horizonDays * DAY
  return SYSTEMIC_EVENTS.some((e) => {
    const t = Date.parse(e.date)
    return t > from && t <= to
  })
}

/** 月末采样（每月第一个交易日），减少重叠又保留足够样本 */
function monthStarts(dates: string[]): number[] {
  const out: number[] = []
  let last = ''
  for (let i = 0; i < dates.length; i++) {
    const ym = dates[i].slice(0, 7)
    if (ym !== last) {
      out.push(i)
      last = ym
    }
  }
  return out
}

export interface BuildOptions {
  params?: RiskParams
  from?: string
  to?: string
  /** 预测窗口（交易日数），默认 252 */
  horizon?: number
}

/** 构造样本：每个采样点只有当日可见的特征 + 未来 12 个月的结果标签 */
export function buildSamples(db: DatabaseSync, opts: BuildOptions = {}): Sample[] {
  const baseParams = opts.params ?? loadParams(db)
  // 回测用长历史信用序列，阶跃阈值相应下调（见 BACKTEST_CREDIT_STEP 注释）
  const params: RiskParams = { ...baseParams, steps: { ...baseParams.steps, oas: BACKTEST_CREDIT_STEP } }
  const horizon = opts.horizon ?? 252
  const nasdaq = loadSeries(db, 'nasdaq')
  const oas = loadSeries(db, BACKTEST_CREDIT_SERIES)
  const rates10y = loadSeries(db, 'rates10y')
  const rates2y = loadSeries(db, 'rates2y')
  if (nasdaq.dates.length < horizon + 30) return []

  const from = opts.from ?? nasdaq.dates[0]
  const to = opts.to ?? nasdaq.dates[nasdaq.dates.length - 1]
  const samples: Sample[] = []

  for (const i of monthStarts(nasdaq.dates)) {
    const date = nasdaq.dates[i]
    if (date < from || date > to) continue

    const ratesIn = buildMacroInput(rates10y, date, 'rates', '10Y')
    const creditIn = buildMacroInput(oas, date, 'credit', 'OAS')
    const indexIn = buildMacroInput(nasdaq, date, 'index', 'NASDAQ')
    if (!indexIn) continue

    // 只用宏观项（新闻历史太短，跨年回测不可用）—— nfi 传 null，权重自动归一
    const crs = computeCrs(
      {
        nfi: null,
        rates: ratesIn,
        credit: creditIn,
        index: indexIn,
        inversion: inversionAt(rates2y, rates10y, date),
      },
      params,
    )

    const oasValue = valueAt(oas, date)
    const oasIdx = indexAt(oas, date)
    const oasPct = oasValue === null || oasIdx < 0 ? null : percentileRank(oasValue, oas.values.slice(0, oasIdx + 1))
    const dd = forwardMaxDrawdown(nasdaq.values, i, horizon)
    const widen = oasIdx < 0 ? null : forwardMaxRise(oas.values, oasIdx, horizon)

    samples.push({
      date,
      features: {
        crs: crs.score,
        overheat: crs.subIndices.overheat.score,
        stress: crs.subIndices.stress.score,
        fragility: crs.subIndices.fragility.score,
        oas: oasValue,
        oasPct,
        drawdown: indexIn.high52w ? indexIn.value / indexIn.high52w - 1 : null,
        rates: ratesIn?.value ?? null,
      },
      labels: {
        drawdown20: dd === null ? null : dd >= 0.2 ? 1 : 0,
        credit_widen_1pp: widen === null ? null : widen >= 1 ? 1 : 0,
        systemic: hasSystemicEvent(date, 365) ? 1 : 0,
      },
    })
  }
  return samples
}

/** AUC（Mann-Whitney U，处理并列） */
export function aucOf(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return 0.5
  let wins = 0
  for (const p of pos) {
    for (const n of neg) {
      if (p > n) wins += 1
      else if (p === n) wins += 0.5
    }
  }
  return wins / (pos.length * neg.length)
}

export interface EvalOptions {
  threshold: number
  scoreOf?: (s: Sample) => number | null
}

export function evaluateEvent(
  samples: Sample[],
  event: EventKey,
  opts: EvalOptions,
): Metrics {
  const scoreOf = opts.scoreOf ?? ((s: Sample) => s.features.crs)
  const rows = samples
    .map((s) => ({ s, y: s.labels[event], x: scoreOf(s) }))
    .filter((r): r is { s: Sample; y: 0 | 1; x: number } => r.y !== null && r.x !== null)

  const pos = rows.filter((r) => r.y === 1).map((r) => r.x)
  const neg = rows.filter((r) => r.y === 0).map((r) => r.x)
  const baseRate = rows.length > 0 ? pos.length / rows.length : 0

  const alertRows = rows.filter((r) => r.x >= opts.threshold)
  const truePos = alertRows.filter((r) => r.y === 1).length
  const falsePos = alertRows.length - truePos
  const hitRate = pos.length > 0 ? truePos / pos.length : 0
  const falseAlarmRate = neg.length > 0 ? falsePos / neg.length : 0
  const precision = alertRows.length > 0 ? truePos / alertRows.length : 0

  // 提前量：每个真实事件，取"事件前 12 个月内第一次越阈值"到事件日的天数
  const leadDays: number[] = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].y !== 1) continue
    // 向前找第一个不再告警的点，再取它的后一个
    let j = i
    while (j > 0 && rows[j - 1].y === 1 && rows[j - 1].x >= opts.threshold) j -= 1
    if (rows[j].x >= opts.threshold) {
      leadDays.push((Date.parse(rows[i].s.date) - Date.parse(rows[j].s.date)) / DAY)
    }
  }
  leadDays.sort((a, b) => a - b)

  const months = rows.length > 0 ? rows.length : 1
  const baselines = [
    { name: '信用利差分位', auc: aucOf(
      rows.filter((r) => r.s.features.oasPct !== null && r.y === 1).map((r) => r.s.features.oasPct as number),
      rows.filter((r) => r.s.features.oasPct !== null && r.y === 0).map((r) => r.s.features.oasPct as number),
    ) },
    { name: '当前回撤', auc: aucOf(
      rows.filter((r) => r.s.features.drawdown !== null && r.y === 1).map((r) => -(r.s.features.drawdown as number)),
      rows.filter((r) => r.s.features.drawdown !== null && r.y === 0).map((r) => -(r.s.features.drawdown as number)),
    ) },
    { name: '10Y 利率水平', auc: aucOf(
      rows.filter((r) => r.s.features.rates !== null && r.y === 1).map((r) => r.s.features.rates as number),
      rows.filter((r) => r.s.features.rates !== null && r.y === 0).map((r) => r.s.features.rates as number),
    ) },
  ]

  return {
    event,
    label: EVENT_LABELS[event],
    samples: rows.length,
    positives: pos.length,
    baseRate: Number(baseRate.toFixed(3)),
    auc: Number(aucOf(pos, neg).toFixed(3)),
    baselines: baselines.map((b) => ({ ...b, auc: Number(b.auc.toFixed(3)) })),
    atThreshold: {
      threshold: opts.threshold,
      hitRate: Number(hitRate.toFixed(3)),
      falseAlarmRate: Number(falseAlarmRate.toFixed(3)),
      precision: Number(precision.toFixed(3)),
      alertsPerYear: Number(((alertRows.length / months) * 12).toFixed(2)),
    },
    medianLeadDays: leadDays.length > 0 ? Math.round(leadDays[Math.floor(leadDays.length / 2)]) : null,
    effectiveSamples: Math.round(rows.length / 12),
  }
}

export interface RunOptions extends BuildOptions {
  trainFrom?: string
  trainTo?: string
  testFrom?: string
  threshold?: number
}

/** 完整回测：训练段选阈值 → 测试段评估 */
export function runBacktest(db: DatabaseSync, opts: RunOptions = {}): BacktestReport {
  const params = opts.params ?? loadParams(db)
  const samples = buildSamples(db, opts)
  const trainFrom = opts.trainFrom ?? '2013-01-01'
  const trainTo = opts.trainTo ?? '2019-12-31'
  const testFrom = opts.testFrom ?? '2020-01-01'

  const train = samples.filter((s) => s.date >= trainFrom && s.date <= trainTo)
  const test = samples.filter((s) => s.date >= testFrom)

  /*
   * 阈值：在训练段上最大化 Youden's J（命中率 − 误报率）。
   * 早先的写法是"取命中率 ≥0.6 的最低阈值"—— 那个准则会把阈值一路压到 30，
   * 命中率 97% 但误报率 93%，等于天天报警，没有实际意义。
   */
  let threshold = opts.threshold ?? 0
  if (!opts.threshold) {
    let bestT = 50
    let bestJ = -Infinity
    for (let t = 20; t <= 90; t += 5) {
      const m = evaluateEvent(train, 'drawdown20', { threshold: t })
      if (m.positives === 0) continue
      const j = m.atThreshold.hitRate - m.atThreshold.falseAlarmRate
      if (j > bestJ) {
        bestJ = j
        bestT = t
      }
    }
    threshold = bestT
  }

  const events = {} as BacktestReport['events']
  for (const key of Object.keys(EVENT_LABELS) as EventKey[]) {
    events[key] = {
      train: evaluateEvent(train, key, { threshold }),
      test: evaluateEvent(test, key, { threshold }),
    }
  }

  const coverage = db
    .prepare(`SELECT series, COUNT(*) AS rows, MIN(date) AS "from", MAX(date) AS "to" FROM macro_history GROUP BY series`)
    .all() as unknown as { series: string; rows: number; from: string; to: string }[]

  return {
    generatedAt: new Date().toISOString(),
    params,
    dataRange: {
      from: samples[0]?.date ?? '—',
      to: samples[samples.length - 1]?.date ?? '—',
    },
    trainWindow: { from: trainFrom, to: trainTo },
    testWindow: { from: testFrom, to: samples[samples.length - 1]?.date ?? '—' },
    sampling: '月末采样；预测窗口 12 个月（252 交易日）',
    events,
    seriesCoverage: coverage,
    caveats: [
      '月度样本仍有 12 个月重叠 → 有效独立样本 ≈ 样本数/12，AUC 的不确定性远大于点数表面',
      '危机是稀有事件，正样本很少，结论只能算"初步证据"，不能当"已证明有效"',
      '回测只覆盖宏观项（新闻历史不足 1 年，NFI 无法跨年回测），因此评估的是"宏观 CRS"',
      '信用利差用 BAA10Y（长历史）替代生产口径的高收益 OAS，阶跃阈值下调到 3.0% —— 评估的是宏观骨架，不是生产分数逐点复现',
      '2020 年 COVID 与 2023 年 SVB 都在测试段内，样本量小、代表性有限',
      '参数（权重/阈值）本身是人工设定的，本回测只检验"有没有区分能力"，不做参数寻优',
    ],
  }
}
