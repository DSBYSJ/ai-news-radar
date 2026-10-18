import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localDate, msUntilNextLocal } from '../src/scheduler.ts'

const HOUR = 3_600_000
const BEIJING = 8 * HOUR

test('msUntilNextLocal：北京时间 23:00 之前 → 当天 23:00', () => {
  // 北京时间 2026-10-18 19:00 = UTC 11:00
  const now = Date.parse('2026-10-18T11:00:00Z')
  const delay = msUntilNextLocal(now, 23, 0)
  assert.equal(delay, 4 * HOUR, '19:00 → 23:00 应是 4 小时')
  assert.equal(localDate(now + delay), '2026-10-18', '落在当天')
})

test('msUntilNextLocal：过了 23:00 → 次日 23:00', () => {
  // 北京时间 2026-10-18 23:30 = UTC 15:30
  const now = Date.parse('2026-10-18T15:30:00Z')
  const delay = msUntilNextLocal(now, 23, 0)
  assert.equal(delay, 23.5 * HOUR, '23:30 → 次日 23:00 应是 23.5 小时')
  assert.equal(localDate(now + delay), '2026-10-19', '落在次日')
})

test('msUntilNextLocal：正好 23:00 → 顺延到次日（不会立刻触发）', () => {
  const now = Date.parse('2026-10-18T15:00:00Z') // 北京 23:00 整
  assert.equal(msUntilNextLocal(now, 23, 0), 24 * HOUR)
})

test('localDate：23:00 时北京日期与 UTC 日期一致（写入分桶不会错位）', () => {
  const now = Date.parse('2026-10-18T15:00:00Z') // 北京 23:00 / UTC 15:00
  assert.equal(localDate(now), '2026-10-18')
  assert.equal(new Date(now).toISOString().slice(0, 10), '2026-10-18')
})

test('localDate：凌晨会跨日（说明为什么用北京日期而不是 UTC 日期）', () => {
  const now = Date.parse('2026-10-18T17:30:00Z') // 北京 10-19 01:30 / UTC 10-18
  assert.equal(localDate(now), '2026-10-19')
  assert.equal(localDate(now, 0), '2026-10-18')
  // 偏移常量只是为了让 BEIJING 在测试里可读
  assert.equal(localDate(now, BEIJING), '2026-10-19')
})
