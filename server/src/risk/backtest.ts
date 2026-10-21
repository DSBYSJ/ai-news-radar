import type { DatabaseSync } from 'node:sqlite'
import { computeCrs, type RiskParams } from './calculation.ts'
import { buildMacroInput, indexAt, inversionAt, loadSeries, valueAt } from './macroHistory.ts'
import { loadParams } from './params.ts'

/**
 * 风险模型历史回测（v0.29.0 按外部评审意见重写）
 *
 * 相比 v0.28.0 的六处改动（每处都对应一条评审意见）：
 *   1. **2008 进事件表**：数据其实覆盖 2008（纳指 2007-10 峰值 2859 → 2009-03 低点 1268，−55.6%），
 *      旧表只登记 2020/2023，导致 2008 的样本被错标成"未来 12 个月无系统性危机"。
 *   2. **固定主/辅切分**：主实验 2006–2014 训练（含 2008）/ 2015–2026 测试；
 *      辅助实验 2013–2019 / 2020–2026。**不因哪个切分 AUC 好看就选它。**
 *   3. **purging（时间边界清理）**：12 个月标签会跨进测试期，训练集末尾 12 个月必须剔除，
 *      否则阈值选择阶段就"看过"测试期结果。
 *   4. **事件级评估**：告警合并 + 冷却期 → 按独立事件算召回，而不是把同一场危机的 12 个
 *      正样本当成 12 次成功预警。FPR / FDR / 每年误报次数分开报告。
 *   5. **阈值规则换成"误报预算约束下最大化事件召回"**：Youden's J 对漏报误报对称，
 *      不适合预警场景（实测 J 会选到 CRS≥30，误报 93%）。
 *   6. **移动区块 bootstrap**（12/24/36 个月）+ **逐因子消融** + **自动泄漏检查**。
 *
 * 仍然不做的事：不调参寻优、不引入机器学习。样本只有 3 个独立危机事件，
 * 任何"最优参数"都是过拟合。
 */

export type EventKey = 'drawdown20' | 'credit_widen_1pp' | 'systemic'

export const EVENT_LABELS: Record<EventKey, string> = {
  drawdown20: '未来 12 个月纳指最大回撤 ≥ 20%',
  credit_widen_1pp: '未来 12 个月信用利差走阔 ≥ 1pp',
  systemic: '未来 12 个月发生系统性危机（人工事件表）',
}

/**
 * 系统性危机事件表 —— 只收"系统性"级别，且必须发生在数据覆盖期内。
 * 数据从 2006-10 起，因此 **2008 在样本内，必须登记**（这是 v0.28.0 的错）。
 *
 * 刻意不收 2015 贬值冲击 / 2018 Q4 急跌 / 2022 加息杀估值：
 * 它们是显著的市场调整，但不是系统性银行/市场危机；混进来会把基础发生率灌水，
 * 让"预警能力"看起来虚高。目前只有 3 个事件，统计上依然很弱 —— 报告里必须写明。
 */
export const SYSTEMIC_EVENTS = [
  { date: '2008-09-15', label: '2008 雷曼破产' },
  { date: '2020-02-24', label: '2020 COVID 熔断潮' },
  { date: '2023-03-08', label: '2023 硅谷银行事件' },
]

export interface SplitSpec {
  name: string
  trainFrom: string
  trainTo: string
  testFrom: string
  testTo: string | null
}

/** 主实验：训练期包含 2008，测试期只含更晚的危机（2008 不同时用于训练和测试） */
export const MAIN_SPLIT: SplitSpec = {
  name: '主实验',
  trainFrom: '2006-01-01',
  trainTo: '2014-12-31',
  testFrom: '2015-01-01',
  testTo: null,
}

/** 辅助实验：只看较现代时期，用于检查结论是否依赖某一段历史 */
export const AUX_SPLIT: SplitSpec = {
  name: '辅助实验',
  trainFrom: '2013-01-01',
  trainTo: '2019-12-31',
  testFrom: '2020-01-01',
  testTo: null,
}

/** 预测窗口：12 个月 ≈ 252 个交易日 */
export const HORIZON_MONTHS = 12

/**
 * 回测用的信用利差序列与阈值。
 *
 * 生产口径是高收益 OAS（BAMLH0A0HYM2），但 FRED 的 fredgraph.csv 对它只返回约 3 年
 * （793 行，cosd 参数无效），无法跨周期回测。因此回测改用 BAA10Y（2006 年起完整），
 * 并把阶跃阈值从 HY OAS 的 4.5% 下调到 Baa 利差的 3.0%。
 *
 * ⚠️ 两者**不是同一个指标**（评级范围、指数构成、计算方法都不同），
 * 所以回测评估的是「长期 Baa 信用压力代理模型」，不能声称等同于生产 CRS。
 */
const BACKTEST_CREDIT_SERIES = 'creditSpreadLong'
const BACKTEST_CREDIT_STEP = 3.0

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

/* ============================ 纯函数工具 ============================ */

/** 前向最大回撤：从 t 起的 252 个观测内，相对区间内峰值的最大跌幅（0.2 = 20%） */
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

/**
 * AUC（Mann-Whitney，处理并列）。用秩和实现，O(n log n) ——
 * bootstrap 要跑几千次，逐对比较太慢。
 */
export function aucOf(pos: number[], neg: number[]): number {
  if (pos.length === 0 || neg.length === 0) return 0.5
  const all = [...pos.map((v) => ({ v, g: 1 })), ...neg.map((v) => ({ v, g: 0 }))].sort((a, b) => a.v - b.v)
  const ranks = new Array<number>(all.length)
  let i = 0
  while (i < all.length) {
    let j = i
    while (j + 1 < all.length && all[j + 1].v === all[i].v) j += 1
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[k] = avg
    i = j + 1
  }
  let rankSumPos = 0
  for (let k = 0; k < all.length; k++) if (all[k].g === 1) rankSumPos += ranks[k]
  const n1 = pos.length
  const n2 = neg.length
  return (rankSumPos - (n1 * (n1 + 1)) / 2) / (n1 * n2)
}

function shiftMonths(date: string, months: number): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCMonth(d.getUTCMonth() + months)
  return d.toISOString().slice(0, 10)
}

function monthsBetween(a: string, b: string): number {
  const da = new Date(`${a}T00:00:00Z`)
  const db = new Date(`${b}T00:00:00Z`)
  return (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth())
}

function hasSystemicEvent(date: string, horizonDays: number): boolean {
  const from = Date.parse(date)
  const to = from + horizonDays * 86_400_000
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

function percentileOf(value: number, history: number[]): number | null {
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

/* ============================ 构造样本 ============================ */

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

    // 只用宏观项（新闻历史不足 1 个月，NFI 无法跨年回测）—— nfi 传 null，权重自动归一
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
    const oasPct = oasValue === null || oasIdx < 0 ? null : percentileOf(oasValue, oas.values.slice(0, oasIdx + 1))
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

/* ============================ 切分与 purging ============================ */

/**
 * purging：12 个月标签会跨进测试期，所以训练集末尾 12 个月必须剔除。
 *
 * 不做这一步的后果：测试期从 2015-01 开始，而训练样本 2014-06 的标签覆盖到 2015-06，
 * 等于阈值选择阶段已经"看过"测试期的市场表现 —— 这是最隐蔽的一种泄漏。
 */
export function purgeTrain<T extends { date: string }>(train: T[], testFrom: string, months = HORIZON_MONTHS): T[] {
  const cutoff = shiftMonths(testFrom, -months)
  return train.filter((s) => s.date <= cutoff)
}

/* ============================ 告警事件 ============================ */

export interface AlertEpisode {
  start: string
  end: string
  peak: number
  months: number
}

/**
 * 把连续（含冷却期）的告警月份合并成「一次告警」。
 * 不合并的后果：一场持续 10 个月的市场波动会被算成 10 次告警，每年误报次数虚高。
 */
export function episodesOf(
  rows: { date: string; score: number }[],
  threshold: number,
  cooldownMonths = 6,
): AlertEpisode[] {
  const alerts = rows.filter((r) => r.score >= threshold)
  const out: AlertEpisode[] = []
  for (const r of alerts) {
    const last = out[out.length - 1]
    if (last && shiftMonths(last.end, cooldownMonths) >= r.date) {
      last.end = r.date
      last.peak = Math.max(last.peak, r.score)
      last.months += 1
    } else {
      out.push({ start: r.date, end: r.date, peak: r.score, months: 1 })
    }
  }
  return out
}

export interface EventDetail {
  label: string
  date: string
  hit: boolean
  leadDays: number | null
  /** 该事件窗口内最高分，便于判断"差一点就抓到" */
  maxScoreInWindow: number | null
}

export interface EventMetrics {
  event: EventKey
  label: string
  samples: number
  positives: number
  baseRate: number
  /** 样本级 AUC（分数越高越危险的方向） */
  auc: number
  /** 方向核查：若 auc < 0.5，说明分数方向可能反了，这里给出反向值供判断 */
  aucInverted: number
  direction: 'correct' | 'inverted' | 'flat'
  /** 非事件月份中被误判为正类的比例（FPR） */
  fpr: number
  /** 所有告警中最终没有对应事件的比例（FDR） */
  fdr: number
  /** 每年误报次数（已按冷却期合并） */
  alertsPerYear: number
  /** 独立事件召回 */
  eventRecall: number
  eventsTotal: number
  eventsHit: number
  eventDetail: EventDetail[]
  medianLeadDays: number | null
  effectiveSamples: number
}

/** 单个切分 × 单个事件的完整评估（样本级 + 事件级） */
export function evaluateEvent(
  testRows: Sample[],
  event: EventKey,
  threshold: number,
  opts: { cooldownMonths?: number; years?: number } = {},
): EventMetrics {
  const rows = testRows
    .map((s) => ({ date: s.date, score: s.features.crs, y: s.labels[event] }))
    .filter((r): r is { date: string; score: number; y: 0 | 1 } => r.y !== null)

  const pos = rows.filter((r) => r.y === 1).map((r) => r.score)
  const neg = rows.filter((r) => r.y === 0).map((r) => r.score)
  const auc = aucOf(pos, neg)
  const direction: EventMetrics['direction'] = auc > 0.55 ? 'correct' : auc < 0.45 ? 'inverted' : 'flat'

  const alertRows = rows.filter((r) => r.score >= threshold)
  const fp = alertRows.filter((r) => r.y === 0).length
  const fpr = neg.length > 0 ? fp / neg.length : 0
  const fdr = alertRows.length > 0 ? fp / alertRows.length : 0

  const cooldown = opts.cooldownMonths ?? 6
  const episodes = episodesOf(rows, threshold, cooldown)
  const years = opts.years ?? Math.max(1, rows.length / 12)

  // 事件级：只统计落在测试期内的独立事件
  const testFrom = rows[0]?.date ?? '0000-01-01'
  const testTo = rows[rows.length - 1]?.date ?? '9999-12-31'
  const inScope = SYSTEMIC_EVENTS.filter((e) => e.date >= testFrom && e.date <= shiftMonths(testTo, HORIZON_MONTHS))
  const eventDetail: EventDetail[] = inScope.map((e) => {
    const windowStart = shiftMonths(e.date, -HORIZON_MONTHS)
    const hitEpisode = episodes.find((ep) => ep.start >= windowStart && ep.start <= e.date) ?? null
    const inWindow = rows.filter((r) => r.date >= windowStart && r.date <= e.date)
    return {
      label: e.label,
      date: e.date,
      hit: hitEpisode !== null,
      leadDays: hitEpisode ? Math.round((Date.parse(e.date) - Date.parse(hitEpisode.start)) / 86_400_000) : null,
      maxScoreInWindow: inWindow.length > 0 ? Math.max(...inWindow.map((r) => r.score)) : null,
    }
  })
  const eventsHit = eventDetail.filter((d) => d.hit).length

  // 误报事件：不在任何事件前 12 个月窗口内的告警
  const falseEpisodes = episodes.filter(
    (ep) => !SYSTEMIC_EVENTS.some((e) => ep.start >= shiftMonths(e.date, -HORIZON_MONTHS) && ep.start <= e.date),
  )

  const leads = eventDetail.map((d) => d.leadDays).filter((d): d is number => d !== null).sort((a, b) => a - b)

  return {
    event,
    label: EVENT_LABELS[event],
    samples: rows.length,
    positives: pos.length,
    baseRate: rows.length > 0 ? Number((pos.length / rows.length).toFixed(3)) : 0,
    auc: Number(auc.toFixed(3)),
    aucInverted: Number((1 - auc).toFixed(3)),
    direction,
    fpr: Number(fpr.toFixed(3)),
    fdr: Number(fdr.toFixed(3)),
    alertsPerYear: Number((falseEpisodes.length / years).toFixed(2)),
    eventRecall: inScope.length > 0 ? Number((eventsHit / inScope.length).toFixed(3)) : 0,
    eventsTotal: inScope.length,
    eventsHit,
    eventDetail,
    medianLeadDays: leads.length > 0 ? leads[Math.floor(leads.length / 2)] : null,
    effectiveSamples: Math.round(rows.length / 12),
  }
}

/**
 * 阈值选择：**误报预算约束下最大化独立事件召回**（外部评审建议的规则）。
 *
 * 为什么不用 Youden's J：J = 召回 + 特异度 − 1 对漏报与误报对称加权，
 * 但预警场景不对称 —— 实测 J 会选到 CRS≥30，误报率 93%，等于天天报警。
 */
export function chooseThreshold(
  trainRows: Sample[],
  event: EventKey = 'drawdown20',
  opts: { maxAlertsPerYear?: number; cooldownMonths?: number; years?: number } = {},
): { value: number; rule: string; maxAlertsPerYear: number } {
  const budget = opts.maxAlertsPerYear ?? 1
  const years = opts.years ?? Math.max(1, trainRows.length / 12)
  let best: { value: number; recall: number; alerts: number } | null = null
  let fallback: { value: number; recall: number; alerts: number } | null = null

  for (let t = 20; t <= 95; t += 5) {
    const m = evaluateEvent(trainRows, event, t, { cooldownMonths: opts.cooldownMonths, years })
    const cand = { value: t, recall: m.eventRecall, alerts: m.alertsPerYear }
    // 记录"最省告警"的方案作为无可行解时的兜底
    if (!fallback || cand.alerts < fallback.alerts || (cand.alerts === fallback.alerts && cand.recall > fallback.recall)) {
      fallback = cand
    }
    if (cand.alerts > budget) continue
    if (!best || cand.recall > best.recall || (cand.recall === best.recall && cand.alerts < best.alerts)) {
      best = cand
    }
  }

  const chosen = best ?? fallback ?? { value: 50, recall: 0, alerts: 0 }
  return {
    value: chosen.value,
    rule: `每年误报 ≤ ${budget} 次的约束下最大化独立事件召回（训练段选定，测试段锁定）`,
    maxAlertsPerYear: budget,
  }
}

/* ============================ 区块 bootstrap ============================ */

export interface BootstrapRow {
  blockLength: number
  lo: number | null
  hi: number | null
  valid: number
  requested: number
}

/**
 * 移动区块 bootstrap：按连续月份重采样，保留时间结构。
 * 逐行 bootstrap 会把相邻月份当独立样本 —— 12 个月预测窗口高度重叠，区间会假性变窄。
 */
export function movingBlockBootstrap(
  rows: Sample[],
  event: EventKey,
  blockLength: number,
  reps = 2000,
): BootstrapRow {
  const data = rows
    .map((s) => ({ score: s.features.crs, y: s.labels[event] }))
    .filter((r): r is { score: number; y: 0 | 1 } => r.y !== null)
  const n = data.length
  if (n < blockLength * 2) return { blockLength, lo: null, hi: null, valid: 0, requested: reps }

  const aucs: number[] = []
  for (let r = 0; r < reps; r++) {
    const sample: { score: number; y: 0 | 1 }[] = []
    while (sample.length < n) {
      const start = Math.floor(Math.random() * Math.max(1, n - blockLength + 1))
      for (let k = 0; k < blockLength && sample.length < n; k++) sample.push(data[start + k])
    }
    const pos = sample.filter((x) => x.y === 1).map((x) => x.score)
    const neg = sample.filter((x) => x.y === 0).map((x) => x.score)
    if (pos.length === 0 || neg.length === 0) continue
    aucs.push(aucOf(pos, neg))
  }
  if (aucs.length === 0) return { blockLength, lo: null, hi: null, valid: 0, requested: reps }
  aucs.sort((a, b) => a - b)
  const q = (p: number): number => aucs[Math.min(aucs.length - 1, Math.max(0, Math.floor(p * (aucs.length - 1))))]
  return {
    blockLength,
    lo: Number(q(0.025).toFixed(3)),
    hi: Number(q(0.975).toFixed(3)),
    valid: aucs.length,
    requested: reps,
  }
}

/* ============================ 逐因子消融 ============================ */

export interface AblationRow {
  name: string
  change: string
  testAuc: number
  eventRecall: number
  alertsPerYear: number
  /** 相对完整模型的 AUC 变化（正 = 去掉后更好） */
  deltaAuc: number
}

const ABLATIONS: { name: string; change: string; patch: (p: RiskParams) => RiskParams }[] = [
  { name: '完整模型', change: '—', patch: (p) => p },
  {
    name: '去掉利率历史分位',
    change: 'ratesMix.level = 0',
    patch: (p) => ({ ...p, ratesMix: { ...p.ratesMix, level: 0 } }),
  },
  {
    name: '去掉利率阶跃',
    change: 'ratesMix.step = 0',
    patch: (p) => ({ ...p, ratesMix: { ...p.ratesMix, step: 0 } }),
  },
  {
    name: '去掉信用自满项',
    change: 'creditUse.complacency = false',
    patch: (p) => ({ ...p, creditUse: { ...p.creditUse, complacency: false } }),
  },
  {
    name: '去掉整个信用项',
    change: 'crs.credit = 0',
    patch: (p) => ({ ...p, crs: { ...p.crs, credit: 0 } }),
  },
  {
    name: '去掉整个指数项',
    change: 'crs.index = 0',
    patch: (p) => ({ ...p, crs: { ...p.crs, index: 0 } }),
  },
]

/* ============================ 泄漏检查 ============================ */

export interface LeakCheck {
  name: string
  ok: boolean
  detail: string
}

/** 特征不得使用未来数据：同一天的输入，用全量序列算 vs 截断到当天算，必须完全一致 */
function checkNoFutureLeak(db: DatabaseSync, dates: string[]): LeakCheck {
  const nasdaq = loadSeries(db, 'nasdaq')
  const bad: string[] = []
  for (const date of dates) {
    const i = indexAt(nasdaq, date)
    if (i < 0) continue
    const full = buildMacroInput(nasdaq, date, 'index', 'NASDAQ')
    const truncated = buildMacroInput(
      { dates: nasdaq.dates.slice(0, i + 1), values: nasdaq.values.slice(0, i + 1) },
      date,
      'index',
      'NASDAQ',
    )
    if (JSON.stringify(full) !== JSON.stringify(truncated)) bad.push(date)
  }
  return {
    name: '特征不使用未来数据（全量 vs 截断重算）',
    ok: bad.length === 0,
    detail: bad.length === 0 ? `抽查 ${dates.length} 个日期，结果完全一致` : `以下日期不一致：${bad.join(', ')}`,
  }
}

/** 训练/测试标签窗口不得重叠 */
function checkPurge(split: SplitResult): LeakCheck {
  const gap = monthsBetween(split.purgeCutoff, split.testFrom)
  return {
    name: `${split.name}：训练/测试标签窗口不重叠（purging）`,
    ok: gap >= HORIZON_MONTHS,
    detail: `训练集实际截止 ${split.purgeCutoff}，测试期起 ${split.testFrom}，间隔 ${gap} 个月（需 ≥ ${HORIZON_MONTHS}）`,
  }
}

/** 分位数样本量应随日期单调增长（说明只用了过去的观测） */
function checkPercentileGrowth(db: DatabaseSync, dates: string[]): LeakCheck {
  const nasdaq = loadSeries(db, 'nasdaq')
  const lens = dates.map((d) => buildMacroInput(nasdaq, d, 'index', 'NASDAQ')?.history.length ?? 0)
  const ok = lens.every((v, i) => i === 0 || v >= lens[i - 1])
  return {
    name: '历史分位样本量随日期单调增长',
    ok,
    detail: `抽查 ${dates.length} 个日期，样本量 ${lens.join(' → ')}`,
  }
}

/* ============================ 主流程 ============================ */

export interface SplitResult {
  name: string
  trainFrom: string
  trainTo: string
  testFrom: string
  testTo: string
  /** purging 之后的训练集实际截止日 */
  purgeCutoff: string
  trainSamples: number
  testSamples: number
  threshold: { value: number; rule: string; maxAlertsPerYear: number }
  events: Record<EventKey, EventMetrics>
  bootstrap: Record<EventKey, BootstrapRow[]>
  ablation: AblationRow[]
}

export interface BacktestReport {
  generatedAt: string
  params: RiskParams
  /** 一句话定位：这份回测到底评的是什么 */
  positioning: string
  dataRange: { from: string; to: string }
  sampling: string
  splits: { main: SplitResult; aux: SplitResult }
  leakChecks: LeakCheck[]
  caveats: string[]
  seriesCoverage: { series: string; rows: number; from: string; to: string }[]
}

function runSplit(db: DatabaseSync, samples: Sample[], spec: SplitSpec, baseParams: RiskParams): SplitResult {
  const rawTrain = samples.filter((s) => s.date >= spec.trainFrom && s.date <= spec.trainTo)
  const train = purgeTrain(rawTrain, spec.testFrom)
  const test = samples.filter((s) => s.date >= spec.testFrom && (spec.testTo === null || s.date <= spec.testTo))
  const purgeCutoff = shiftMonths(spec.testFrom, -HORIZON_MONTHS)

  const threshold = chooseThreshold(train, 'drawdown20', { maxAlertsPerYear: 1 })
  const years = Math.max(1, test.length / 12)

  const events = {} as Record<EventKey, EventMetrics>
  for (const key of Object.keys(EVENT_LABELS) as EventKey[]) {
    events[key] = evaluateEvent(test, key, threshold.value, { years })
  }

  const bootstrap = {} as Record<EventKey, BootstrapRow[]>
  for (const key of Object.keys(EVENT_LABELS) as EventKey[]) {
    bootstrap[key] = [12, 24, 36].map((b) => movingBlockBootstrap(test, key, b))
  }

  // 消融：每个变体重算一遍样本（分数会变），再在测试期评估
  const ablation: AblationRow[] = []
  const baseline = events.drawdown20
  for (const variant of ABLATIONS) {
    const params = variant.patch(baseParams)
    const variantSamples = buildSamples(db, { params })
    const variantTest = variantSamples.filter(
      (s) => s.date >= spec.testFrom && (spec.testTo === null || s.date <= spec.testTo),
    )
    const m = evaluateEvent(variantTest, 'drawdown20', threshold.value, { years })
    ablation.push({
      name: variant.name,
      change: variant.change,
      testAuc: m.auc,
      eventRecall: m.eventRecall,
      alertsPerYear: m.alertsPerYear,
      deltaAuc: Number((m.auc - baseline.auc).toFixed(3)),
    })
  }

  return {
    name: spec.name,
    trainFrom: spec.trainFrom,
    trainTo: spec.trainTo,
    testFrom: spec.testFrom,
    testTo: test.length > 0 ? test[test.length - 1].date : spec.testTo ?? '—',
    purgeCutoff,
    trainSamples: train.length,
    testSamples: test.length,
    threshold,
    events,
    bootstrap,
    ablation,
  }
}

export function runBacktest(db: DatabaseSync, opts: { params?: RiskParams } = {}): BacktestReport {
  const params = opts.params ?? loadParams(db)
  const samples = buildSamples(db, { params })

  const main = runSplit(db, samples, MAIN_SPLIT, params)
  const aux = runSplit(db, samples, AUX_SPLIT, params)

  // 泄漏检查用样本序列上的 4 个日期抽查
  const probeDates = [0.25, 0.5, 0.75, 0.95]
    .map((p) => samples[Math.floor(p * (samples.length - 1))]?.date)
    .filter((d): d is string => Boolean(d))

  const leakChecks = [
    checkNoFutureLeak(db, probeDates),
    checkPurge(main),
    checkPurge(aux),
    checkPercentileGrowth(db, probeDates),
  ]

  const coverage = db
    .prepare(`SELECT series, COUNT(*) AS rows, MIN(date) AS "from", MAX(date) AS "to" FROM macro_history GROUP BY series`)
    .all() as unknown as { series: string; rows: number; from: string; to: string }[]

  return {
    generatedAt: new Date().toISOString(),
    params,
    positioning:
      '宏观压力评分的历史回测（不含 NFI）—— 因新闻历史不足 1 个月，NFI 无法跨年回测；' +
      '本报告结论只能用于宏观部分，不能代表生产 CRS 的整体表现。',
    dataRange: {
      from: samples[0]?.date ?? '—',
      to: samples[samples.length - 1]?.date ?? '—',
    },
    sampling: `月末采样；预测窗口 ${HORIZON_MONTHS} 个月（252 交易日）；训练集末尾 ${HORIZON_MONTHS} 个月已剔除（purging）`,
    splits: { main, aux },
    leakChecks,
    seriesCoverage: coverage,
    caveats: [
      '只有 3 个独立系统性危机事件（2008 / 2020 / 2023），事件召回率极其粗糙：识别出 2 个是 66.7%，多漏一个就变成 33.3%',
      '月度样本仍有 12 个月重叠，有效独立样本约为样本数/12；区块 bootstrap 区间仅供参考，不能当作稳定的性能证明',
      '回测只覆盖宏观项（NFI 权重 40% 无法跨年回测），因此结论不能外推到生产 CRS',
      '信用利差用 BAA10Y 替代高收益 OAS（后者 FRED 只给 3 年），两者评级范围与计算方法不同，不是同一个指标',
      '参数是人工设定的，本回测只检验区分能力，不做参数寻优 —— 3 个事件下任何"最优参数"都是过拟合',
    ],
  }
}
