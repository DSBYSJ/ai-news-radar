import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  aucOf,
  buildSamples,
  chooseThreshold,
  episodesOf,
  evaluateEvent,
  forwardMaxDrawdown,
  forwardMaxRise,
  movingBlockBootstrap,
  purgeTrain,
  runBacktest,
  type Sample,
} from '../src/risk/backtest.ts'
import { DEFAULT_PARAMS } from '../src/risk/calculation.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

/* ------------------------------ 前向窗口 ------------------------------ */

test('forwardMaxDrawdown：区间内峰值到谷底的最大跌幅', () => {
  const v = [100, 90, 80, 120, 60]
  // 峰值会随新高抬升：先 100→80（20%），再 120→60（50%），取最大
  assert.equal(forwardMaxDrawdown(v, 0, 4), 0.5)
  assert.ok(Math.abs((forwardMaxDrawdown(v, 0, 2) as number) - 0.2) < 1e-9, '窗口截到 80 时只有 20%')
})

test('forwardMaxDrawdown：数据不够时返回 null，不拿现有数据凑', () => {
  assert.equal(forwardMaxDrawdown([100, 90, 80], 0, 5), null)
})

test('forwardMaxRise：前向最大走阔幅度', () => {
  assert.ok(Math.abs((forwardMaxRise([3.0, 3.5, 4.2, 3.1], 0, 3) as number) - 1.2) < 1e-9)
})

/* ------------------------------ 评估指标 ------------------------------ */

test('aucOf：完全分开 = 1，完全反向 = 0，全并列 = 0.5', () => {
  assert.equal(aucOf([9, 8], [2, 1]), 1)
  assert.equal(aucOf([1, 2], [8, 9]), 0)
  assert.equal(aucOf([5, 5], [5, 5]), 0.5)
  assert.equal(aucOf([], [1]), 0.5, '空样本退回 0.5，不报错')
})

test('evaluateEvent：FPR/FDR 按定义计算，且分母不同', () => {
  const mk = (date: string, crs: number, y: 0 | 1 | null): Sample => ({
    date,
    features: { crs, overheat: 0, stress: 0, fragility: 0, oas: null, oasPct: null, drawdown: null, rates: null },
    labels: { drawdown20: y, credit_widen_1pp: null, systemic: null },
  })
  const samples = [
    mk('2020-01-01', 70, 1),
    mk('2020-02-01', 65, 1),
    mk('2020-03-01', 20, 0),
    mk('2020-04-01', 30, 0),
    mk('2020-05-01', 80, 1),
    mk('2020-06-01', 40, 0),
  ]
  const m = evaluateEvent(samples, 'drawdown20', 60)
  assert.equal(m.samples, 6)
  assert.equal(m.positives, 3)
  assert.equal(m.baseRate, 0.5)
  assert.equal(m.fpr, 0, '3 个负样本都没告警')
  assert.equal(m.fdr, 0, '告警全部命中')
  assert.equal(m.auc, 1, '正样本分数都高于负样本')
  assert.equal(m.direction, 'correct')
})

/* ------------------------------ point-in-time ------------------------------ */

/** 造一条 700 天的日序列：前 400 天缓慢上行到 120，之后暴跌到 60，最后暴涨到 500 */
function seedSeries(db: DatabaseSync): void {
  const ins = db.prepare('INSERT INTO macro_history (date, series, value) VALUES (?, ?, ?)')
  const start = Date.parse('2018-01-01')
  for (let i = 0; i < 700; i++) {
    const date = new Date(start + i * 86_400_000).toISOString().slice(0, 10)
    let nasdaq: number
    if (i < 400) nasdaq = 100 + i * 0.05 // 100 → 120
    else if (i < 500) nasdaq = 120 - (i - 400) * 0.6 // 120 → 60
    else nasdaq = 60 + (i - 500) * 4.4 // 60 → 500
    ins.run(date, 'nasdaq', nasdaq)
    ins.run(date, 'rates10y', 2 + (i % 40) * 0.05)
    ins.run(date, 'rates2y', 1.5 + (i % 30) * 0.04)
    ins.run(date, 'creditSpreadLong', 2 + (i % 50) * 0.02)
  }
}

test('buildSamples：只能用当日及以前的数据（未来暴涨不得污染历史回撤）', () => {
  const db = setup()
  seedSeries(db)
  const samples = buildSamples(db, { params: DEFAULT_PARAMS })
  assert.ok(samples.length > 0, '应产出样本')

  // 取第 400 天（峰值 120、之后暴跌）附近的样本：回撤应约为 0，而不是被后面的 500 拉成 -300%
  const atPeak = samples.find((s) => s.date === '2019-02-04')
  if (atPeak) {
    const dd = atPeak.features.drawdown
    assert.ok(dd !== null && dd > -0.05, `峰值当天回撤应接近 0，实际 ${dd}`)
  }
  db.close()
})

test('buildSamples：标签看未来，特征不看未来（窗口外无标签）', () => {
  const db = setup()
  seedSeries(db)
  const samples = buildSamples(db, { params: DEFAULT_PARAMS })
  const last = samples[samples.length - 1]
  // 最后一个采样点没有足够的前向窗口 → drawdown20 标签必须是 null 而不是 0
  assert.equal(last.labels.drawdown20, null, '未来数据不足时标签为 null，不能当成"没出事"')
  db.close()
})

test('runBacktest：数据不足时给出空报告而不是崩溃', () => {
  const db = setup()
  const r = runBacktest(db)
  assert.equal(r.dataRange.from, '—')
  assert.ok(r.caveats.length > 0, '必须附带局限说明')
  db.close()
})

/* ================================================================== */
/* v0.29.0 回测协议：purging / 告警合并 / 阈值规则 / 方向核查            */
/* ================================================================== */

test('purgeTrain：训练集末尾 12 个月必须剔除（否则阈值会看到测试期结果）', () => {
  const rows = ['2013-06-01', '2013-12-01', '2014-06-01', '2014-12-01'].map((d) => ({ date: d }))
  const kept = purgeTrain(rows, '2015-01-01')
  assert.deepEqual(kept.map((r) => r.date), ['2013-06-01', '2013-12-01'], '2014 年的样本标签会跨进测试期，必须剔除')
})

test('episodesOf：连续告警合并为一次，冷却期内的新告警也算同一次', () => {
  const rows = [
    { date: '2020-01-01', score: 80 },
    { date: '2020-02-01', score: 90 },
    { date: '2020-03-01', score: 20 }, // 断一个月
    { date: '2020-04-01', score: 85 }, // 距上次告警 2 个月 < 冷却 6 个月 → 仍算同一次
    { date: '2020-12-01', score: 70 }, // 隔了 8 个月 → 新的一次
  ]
  const eps = episodesOf(rows, 60, 6)
  assert.equal(eps.length, 2, `应合并成 2 次，实际 ${eps.length}`)
  assert.equal(eps[0].start, '2020-01-01')
  assert.equal(eps[0].end, '2020-04-01')
  assert.equal(eps[1].start, '2020-12-01')
})

test('chooseThreshold：在误报预算内选阈值，预算越紧阈值越高', () => {
  const mk = (date: string, crs: number, y: 0 | 1): Sample => ({
    date,
    features: { crs, overheat: 0, stress: 0, fragility: 0, oas: null, oasPct: null, drawdown: null, rates: null },
    labels: { drawdown20: y, credit_widen_1pp: null, systemic: null },
  })
  // 低分区全是负样本，高分区正负混杂
  const rows = [
    mk('2020-01-01', 20, 0),
    mk('2020-02-01', 30, 0),
    mk('2020-03-01', 40, 0),
    mk('2020-04-01', 50, 0),
    mk('2020-05-01', 60, 1),
    mk('2020-06-01', 70, 1),
    mk('2020-07-01', 80, 1),
  ]
  const tight = chooseThreshold(rows, 'drawdown20', { maxAlertsPerYear: 0, years: 1 })
  const loose = chooseThreshold(rows, 'drawdown20', { maxAlertsPerYear: 5, years: 1 })
  assert.ok(tight.value >= loose.value, `预算越紧阈值不应更低：tight=${tight.value} loose=${loose.value}`)
  assert.match(tight.rule, /误报/)
})

test('aucOf：秩和实现与逐对比较结果一致（含并列）', () => {
  const pos = [3, 5, 5, 9]
  const neg = [1, 5, 7]
  let wins = 0
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0
  assert.ok(Math.abs(aucOf(pos, neg) - wins / (pos.length * neg.length)) < 1e-12)
})

test('movingBlockBootstrap：区块过长时如实返回无区间，不硬凑', () => {
  const mk = (i: number): Sample => ({
    date: `2020-${String((i % 12) + 1).padStart(2, '0')}-01`,
    features: { crs: 50 + i, overheat: 0, stress: 0, fragility: 0, oas: null, oasPct: null, drawdown: null, rates: null },
    labels: { drawdown20: i % 2 === 0 ? 1 : 0, credit_widen_1pp: null, systemic: null },
  })
  const rows = Array.from({ length: 10 }, (_, i) => mk(i))
  const r = movingBlockBootstrap(rows, 'drawdown20', 36, 50)
  assert.equal(r.lo, null, '样本 10 个、区块 36 时不该给出区间')
  assert.equal(r.valid, 0)
})

test('runBacktest：泄漏检查全部通过，且两个切分都输出', () => {
  const db = setup()
  seedSeries(db)
  const r = runBacktest(db)
  assert.ok(r.splits.main && r.splits.aux, '主实验与辅助实验都要有')
  for (const c of r.leakChecks) {
    assert.ok(c.ok, `泄漏检查未通过：${c.name} —— ${c.detail}`)
  }
  assert.match(r.positioning, /不含 NFI/, '必须标明回测不包含 NFI')
  db.close()
})
