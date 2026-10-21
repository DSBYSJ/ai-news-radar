import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { deriveMetrics, loadFundamentals, summarizeSegments, type FundamentalsRow } from '../src/market/fundamentals.ts'
import { SEGMENT_LABELS, UNIVERSE, companyOf } from '../src/market/universe.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function row(o: Partial<FundamentalsRow> & { fiscalEnd: string }): FundamentalsRow {
  return { revenue: null, netIncome: null, equity: null, epsDiluted: null, shares: null, ...o }
}

test('universe：清单无重复、每家有板块与角色说明', () => {
  const symbols = UNIVERSE.map((c) => c.symbol)
  assert.equal(new Set(symbols).size, symbols.length, 'ticker 不能重复')
  for (const c of UNIVERSE) {
    assert.ok(SEGMENT_LABELS[c.segment], `未知板块：${c.segment}`)
    assert.ok(c.role.length > 4, `${c.symbol} 缺少角色说明`)
  }
  assert.equal(companyOf('NVDA')?.segment, 'chip')
  assert.equal(companyOf('NOT_EXIST'), undefined)
})

test('deriveMetrics：增速/净利率/ROE 用相邻财年与同财年数据算', () => {
  const nvda = companyOf('NVDA')!
  const rows = [
    row({ fiscalEnd: '2024-01-28', revenue: 60_000, netIncome: 30_000, equity: 40_000 }),
    row({ fiscalEnd: '2025-01-26', revenue: 100_000, netIncome: 50_000, equity: 60_000 }),
  ]
  const m = deriveMetrics(nvda, rows)
  assert.equal(m.latest?.fiscalEnd, '2025-01-26')
  assert.equal(m.revenueGrowth, 66.66666666666666)
  assert.equal(m.netMargin, 50)
  assert.ok(m.roe !== null && Math.abs(m.roe - 83.33333333333334) < 1e-9)
  assert.equal(m.years, 2)
})

test('deriveMetrics：只有一年数据时增速为 null，不硬算成 0', () => {
  const m = deriveMetrics(companyOf('NVDA')!, [row({ fiscalEnd: '2025-01-26', revenue: 100, netIncome: 10 })])
  assert.equal(m.revenueGrowth, null, '缺上年应返回 null')
  assert.equal(m.netMargin, 10)
})

test('deriveMetrics：亏损公司净利率为负，不返回 null（那是"没有数据"）', () => {
  const m = deriveMetrics(companyOf('SNOW')!, [
    row({ fiscalEnd: '2025-01-31', revenue: 1000, netIncome: -200, equity: 500 }),
  ])
  assert.equal(m.netMargin, -20)
  assert.equal(m.roe, -40)
})

test('summarizeSegments：只统计有数据的公司，并如实给出覆盖数', () => {
  const rows = [
    deriveMetrics(companyOf('NVDA')!, [row({ fiscalEnd: '2025-01-26', revenue: 1000, netIncome: 500 })]),
    deriveMetrics(companyOf('AMD')!, []), // 无数据
    deriveMetrics(companyOf('SMCI')!, [row({ fiscalEnd: '2025-06-30', revenue: 500, netIncome: 50 })]),
  ]
  const segs = summarizeSegments(rows, SEGMENT_LABELS)
  const chip = segs.find((s) => s.segment === 'chip')!
  assert.equal(chip.companies, 2, '板块内公司数')
  assert.equal(chip.covered, 1, '只有 1 家有数据')
  assert.equal(chip.revenue, 1000)
  assert.equal(chip.netMargin, 50)
})

test('company_fundamentals：主键去重，同日重跑覆盖而不是新增', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  const ins = db.prepare(
    `INSERT INTO company_fundamentals (symbol, fiscal_end, revenue, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol, fiscal_end) DO UPDATE SET revenue = excluded.revenue, updated_at = excluded.updated_at`,
  )
  ins.run('NVDA', '2025-01-26', 100, 't1')
  ins.run('NVDA', '2025-01-26', 120, 't2')
  const rows = loadFundamentals(db, 'NVDA')
  assert.equal(rows.length, 1, '同一天只能有一行')
  assert.equal(rows[0].revenue, 120, '应被覆盖为最新值')
  db.close()
})

/* ------------------------------ 手工补录（v0.39.0） ------------------------------ */

test('loadPrices：补录价格覆盖同日接口价，并标记 manual', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { loadPrices, saveManualPrice } = await import('../src/market/prices.ts')
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)

  const ins = db.prepare('INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, ?)')
  ins.run('SMCI', '2026-10-19', 40, 100)
  ins.run('SMCI', '2026-10-20', 41, 100)

  // 没有补录时：全部是接口数据
  let rows = loadPrices(db, 'SMCI')
  assert.equal(rows.length, 2)
  assert.equal(rows[0].manual, false)

  // 补录同一天 + 一个接口没有的日期
  saveManualPrice(db, { symbol: 'smci', date: '2026-10-20', close: 45, note: '官网' })
  saveManualPrice(db, { symbol: 'SMCI', date: '2026-10-21', close: 46 })

  rows = loadPrices(db, 'SMCI')
  assert.equal(rows.length, 3, '新增一天，不是替换整条序列')
  const d20 = rows.find((r) => r.date === '2026-10-20')!
  assert.equal(d20.close, 45, '补录值应覆盖接口值')
  assert.equal(d20.manual, true, '补录行必须打标，否则会被当成接口数据')
  const d21 = rows.find((r) => r.date === '2026-10-21')!
  assert.equal(d21.manual, true)
  db.close()
})

test('saveManualPrice：拒绝非法价格与日期格式', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const { saveManualPrice } = await import('../src/market/prices.ts')
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  assert.throws(() => saveManualPrice(db, { symbol: 'X', date: '2026-10-20', close: 0 }), /正数/)
  assert.throws(() => saveManualPrice(db, { symbol: 'X', date: '2026/10/20', close: 10 }), /YYYY-MM-DD/)
  db.close()
})

/* ------------------------------ 估值时点正确性（v0.40.0） ------------------------------ */

test('buildDailyValuation：财报未申报前不得使用该期数据（look-ahead 防护）', async () => {
  const { buildDailyValuation } = await import('../src/market/valuation.ts')
  const fundamentals = [
    // FY2025 于 2025-02-20 申报
    { fiscalEnd: '2025-01-26', filedAt: '2025-02-20', revenue: 1000, netIncome: 100, equity: 500, epsDiluted: 1, shares: 100 },
    // FY2026 财年结束 2026-01-25，但 2026-02-25 才申报
    { fiscalEnd: '2026-01-25', filedAt: '2026-02-25', revenue: 2000, netIncome: 200, equity: 900, epsDiluted: 2, shares: 100 },
  ]
  const prices = [
    { date: '2026-02-01', close: 50 }, // 财报已结束但未申报
    { date: '2026-03-01', close: 60 }, // 已申报
  ]
  const series = buildDailyValuation(prices, fundamentals)
  const before = series.find((p) => p.date === '2026-02-01')!
  const after = series.find((p) => p.date === '2026-03-01')!

  // 2026-02-01：只能用 FY2025 的营收 1000 → 市值 50*100=5000 → P/S 5.0
  assert.ok(Math.abs((before.ps as number) - 5) < 1e-9, `未申报前应沿用上一年，实际 ${before.ps}`)
  // 2026-03-01：可用 FY2026 营收 2000 → 6000/2000 = 3.0
  assert.ok(Math.abs((after.ps as number) - 3) < 1e-9, `申报后应用新一期，实际 ${after.ps}`)
})

test('buildDailyValuation：缺 filedAt 的老数据退回 fiscalEnd，不整段失效', async () => {
  const { buildDailyValuation } = await import('../src/market/valuation.ts')
  const series = buildDailyValuation(
    [{ date: '2026-02-01', close: 10 }],
    [{ fiscalEnd: '2026-01-25', filedAt: null, revenue: 100, netIncome: 10, equity: 50, epsDiluted: 1, shares: 10 }],
  )
  assert.equal(series.length, 1, '有 fiscalEnd 就应能算')
  assert.ok(Math.abs((series[0].ps as number) - 1) < 1e-9)
})

test('assertAuthConfig：生产环境缺密钥必须抛错（fail-closed）', async () => {
  const { assertAuthConfig } = await import('../src/auth.ts')
  assert.throws(() => assertAuthConfig({ nodeEnv: 'production', jwtSecret: '' }), /拒绝启动/)
  assert.throws(() => assertAuthConfig({ nodeEnv: 'production', jwtSecret: '   ' }), /拒绝启动/)
  // 开发环境放行（本地无 .env 也能跑）
  assert.doesNotThrow(() => assertAuthConfig({ nodeEnv: 'development', jwtSecret: '' }))
  // 配了密钥都放行
  assert.doesNotThrow(() => assertAuthConfig({ nodeEnv: 'production', jwtSecret: 'x' }))
})
