import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applySourceWeight, weightBonus } from '../src/ai/scoring.ts'

test('weightBonus：一手 +5 / 媒体 0 / 聚合 -5', () => {
  assert.equal(weightBonus(3), 5)
  assert.equal(weightBonus(2), 0)
  assert.equal(weightBonus(1), -5)
  assert.equal(weightBonus(0), -5, '异常值按聚合处理，不至于让脏数据占便宜')
  assert.equal(weightBonus(9), 5, '超过 3 按一手处理')
})

test('applySourceWeight：同一条内容，一手源把分数抬起来、聚合源压下去', () => {
  const base = 62
  assert.deepEqual(applySourceWeight(base, 3), { score: 67, baseScore: 62, bonus: 5 })
  assert.deepEqual(applySourceWeight(base, 2), { score: 62, baseScore: 62, bonus: 0 })
  assert.deepEqual(applySourceWeight(base, 1), { score: 57, baseScore: 62, bonus: -5 })
})

test('applySourceWeight：加权后仍被夹在 0~100，且取整', () => {
  assert.equal(applySourceWeight(98, 3).score, 100)
  assert.equal(applySourceWeight(2, 1).score, 0)
  assert.equal(applySourceWeight(64.6, 2).score, 65, '取整，避免出现小数分')
})

test('applySourceWeight：原始分异常时按 0 处理，不产生 NaN', () => {
  const r = applySourceWeight(Number.NaN, 2)
  assert.equal(r.score, 0)
  assert.ok(Number.isInteger(r.score))
})
