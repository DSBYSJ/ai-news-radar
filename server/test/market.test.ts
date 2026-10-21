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
