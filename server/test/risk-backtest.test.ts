import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  aucOf,
  buildSamples,
  evaluateEvent,
  forwardMaxDrawdown,
  forwardMaxRise,
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

test('evaluateEvent：命中率/误报率/精确率按定义计算', () => {
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
  const m = evaluateEvent(samples, 'drawdown20', { threshold: 60 })
  assert.equal(m.samples, 6)
  assert.equal(m.positives, 3)
  assert.equal(m.baseRate, 0.5)
  assert.equal(m.atThreshold.hitRate, 1, '3 个正样本全部告警')
  assert.equal(m.atThreshold.falseAlarmRate, 0, '3 个负样本都没告警')
  assert.equal(m.atThreshold.precision, 1)
  assert.equal(m.auc, 1, '正样本分数都高于负样本')
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
