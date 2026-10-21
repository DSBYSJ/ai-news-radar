import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildDailyValuation, type ValuationPoint } from '../src/market/valuation.ts'
import type { FundamentalsRow } from '../src/market/fundamentals.ts'

/**
 * 数据口径不变量（v0.41.0）
 *
 * 这份文件不是"测试某个函数返回什么"，而是**把口径规则写成可执行断言**。
 * 目的：防止同一类静默错误再次出现 —— 这类错误不会报错、不会崩，
 * 只会让数字看起来合理但系统性偏离，靠人工 review 极难发现。
 *
 * 每条测试对应一条规则，规则原文见 `docs/数据口径.md`。
 */

/** 一份财报版本 */
function v(
  fiscalEnd: string,
  filedAt: string | null,
  revenue: number,
  shares = 100,
  eps = 1,
): FundamentalsRow {
  return { fiscalEnd, filedAt, revenue, netIncome: revenue * 0.1, equity: revenue * 0.5, epsDiluted: eps, shares }
}

const px = (date: string, close: number): { date: string; close: number } => ({ date, close })

/* ============================================================
 * 规则 1：未到申报日期的财报，不得进入历史估值
 * ============================================================ */
test('规则1：申报日之前，不得使用该期财报', () => {
  const fundamentals = [
    v('2025-01-26', '2025-02-20', 1000), // 已于 2025-02-20 公开
    v('2026-01-25', '2026-02-25', 2000), // 财年已结束，但 2026-02-25 才公开
  ]
  const series = buildDailyValuation(
    [px('2026-02-01', 50), px('2026-02-24', 50), px('2026-02-25', 50), px('2026-03-01', 50)],
    fundamentals,
  )

  // 2026-02-01 与 2026-02-24：只能用 FY2025（营收 1000）→ 5000/1000 = 5.0
  for (const d of ['2026-02-01', '2026-02-24']) {
    const p = series.find((x) => x.date === d)!
    assert.equal(p.basis?.fiscalEnd, '2025-01-26', `${d} 应仍用上一财年`)
    assert.ok(Math.abs((p.ps as number) - 5) < 1e-9, `${d} P/S 应为 5.0，实际 ${p.ps}`)
  }

  // 2026-02-25 当天申报 → 当天即可用（申报日含当日）
  const onFiled = series.find((x) => x.date === '2026-02-25')!
  assert.equal(onFiled.basis?.fiscalEnd, '2026-01-25', '申报当日应切换到新财年')
  assert.ok(Math.abs((onFiled.ps as number) - 2.5) < 1e-9, `申报当日 P/S 应为 2.5，实际 ${onFiled.ps}`)
})

/* ============================================================
 * 规则 2：后续重述不得回溯改写历史；只在它公开之后生效
 * ============================================================ */
test('规则2：重述从公开日起生效，不回溯改写更早的历史', () => {
  const fundamentals = [
    v('2025-01-26', '2025-02-20', 1000), // 首次披露：营收 1000
    v('2025-01-26', '2026-02-25', 1200), // 一年后被重述为 1200
  ]
  const series = buildDailyValuation(
    [px('2025-06-01', 50), px('2026-02-24', 50), px('2026-02-25', 50)],
    fundamentals,
  )

  const before = series.find((x) => x.date === '2025-06-01')!
  assert.equal(before.basis?.filedAt, '2025-02-20', '2025-06-01 只能看到首次披露版本')
  assert.ok(Math.abs((before.ps as number) - 5) < 1e-9, `应为 5000/1000=5，实际 ${before.ps}`)

  const justBefore = series.find((x) => x.date === '2026-02-24')!
  assert.ok(Math.abs((justBefore.ps as number) - 5) < 1e-9, '重述公开前一天仍是旧值')

  const afterRestate = series.find((x) => x.date === '2026-02-25')!
  assert.equal(afterRestate.basis?.filedAt, '2026-02-25', '重述公开当天起用新版本')
  assert.ok(Math.abs((afterRestate.ps as number) - 5000 / 1200) < 1e-9, `重述后 P/S 应为 5000/1200`)
})

/* ============================================================
 * 规则 3：缺申报日必须显式标记，不能冒充严格时点数据
 * ============================================================ */
test('规则3：缺 filedAt 的记录标 pitReliable=false，并退回 fiscalEnd', () => {
  const series = buildDailyValuation(
    [px('2026-02-01', 10)],
    [v('2026-01-25', null, 100, 10)], // 没有申报日
  )
  assert.equal(series.length, 1, '缺申报日仍可展示（退回财年末）')
  assert.equal(series[0].basis?.pitReliable, false, '必须标记为不可靠，供严格回测排除')
  assert.equal(series[0].basis?.filedAt, '2026-01-25', 'filedAt 退回 fiscalEnd 要如实反映')
})

test('规则3b：有申报日的记录必须标 pitReliable=true', () => {
  const series = buildDailyValuation([px('2026-03-01', 10)], [v('2026-01-25', '2026-02-25', 100, 10)])
  assert.equal(series[0].basis?.pitReliable, true)
})

/* ============================================================
 * 规则 4：历史分位只能基于"当时可用"的数据
 *    → 全序列不变量：任何点的 basis.filedAt 必须 ≤ 该点日期
 * ============================================================ */
test('规则4：全序列不变量——每个估值点用到的财报，申报日不得晚于该点日期', () => {
  const fundamentals = [
    v('2024-01-28', '2024-02-21', 800),
    v('2025-01-26', '2025-02-20', 1000),
    v('2025-01-26', '2026-02-25', 1100), // 重述
    v('2026-01-25', '2026-02-25', 2000),
  ]
  const prices = [
    px('2024-03-01', 30),
    px('2024-12-31', 40),
    px('2025-02-19', 45),
    px('2025-02-20', 46),
    px('2026-02-24', 50),
    px('2026-02-25', 51),
    px('2026-06-01', 60),
  ]
  const series = buildDailyValuation(prices, fundamentals)
  assert.equal(series.length, prices.length, '每个价格点都应能配到财报')

  for (const p of series) {
    const filed = p.basis?.filedAt
    assert.ok(filed, `${p.date} 缺少 basis.filedAt，不可追溯`)
    assert.ok(
      filed! <= p.date,
      `时点泄漏：${p.date} 用了 ${filed} 才申报的财报（晚于当日）`,
    )
  }
})

/* ============================================================
 * 规则 5：每次计算都能说明用了哪份财报、哪个申报日
 * ============================================================ */
test('规则5：每个估值点都带 basis（财年末 + 申报日 + 可靠性）', () => {
  const series = buildDailyValuation([px('2026-03-01', 10)], [v('2026-01-25', '2026-02-25', 100, 10)])
  const p: ValuationPoint = series[0]
  assert.ok(p.basis, '缺少 basis 就无法解释这个数是怎么来的')
  assert.deepEqual(Object.keys(p.basis!).sort(), ['filedAt', 'fiscalEnd', 'pitReliable'])
  assert.equal(p.basis!.fiscalEnd, '2026-01-25')
  assert.equal(p.basis!.filedAt, '2026-02-25')
})

/* ============================================================
 * 规则 6：同一财年多版本时，取"截至当日最新的那个"
 * ============================================================ */
test('规则6：同财年三版本，按日期分别命中第一/第二/第三版', () => {
  const fundamentals = [
    v('2025-01-26', '2025-02-20', 1000), // 首版
    v('2025-01-26', '2025-08-01', 1050), // 半年后（10-Q 里重报）
    v('2025-01-26', '2026-02-25', 1200), // 正式重述
  ]
  const series = buildDailyValuation(
    [px('2025-03-01', 50), px('2025-09-01', 50), px('2026-03-01', 50)],
    fundamentals,
  )
  assert.equal(series[0].basis?.filedAt, '2025-02-20')
  assert.equal(series[1].basis?.filedAt, '2025-08-01')
  assert.equal(series[2].basis?.filedAt, '2026-02-25')

  assert.ok(Math.abs((series[0].ps as number) - 5000 / 1000) < 1e-9)
  assert.ok(Math.abs((series[1].ps as number) - 5000 / 1050) < 1e-9)
  assert.ok(Math.abs((series[2].ps as number) - 5000 / 1200) < 1e-9)
})
