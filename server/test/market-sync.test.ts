import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { syncPrices, syncRatios } from '../src/market/prices.ts'

process.env.FMP_API_KEY = 'test-only-placeholder'
const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8')

test('行情同步：事务回滚的行不得计入成功更新数', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(schema)
  db.exec("CREATE TRIGGER reject_price BEFORE INSERT ON equity_daily WHEN NEW.date = '2026-11-12' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { date: '2026-11-11', price: 10, volume: 1 }, { date: '2026-11-12', price: 11, volume: 2 },
  ]))
  const report = await syncPrices(db, { only: ['NVDA'] })
  assert.equal(report.rows, 0)
  assert.equal(report.skipped.length, 1)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM equity_daily').get() as { n: number }).n, 0)
})

test('比率同步：事务回滚的行不得计入成功更新数', async (t) => {
  const db = new DatabaseSync(':memory:')
  t.after(() => db.close())
  db.exec(schema)
  db.exec("CREATE TRIGGER reject_ratio BEFORE INSERT ON company_ratios WHEN NEW.fiscal_end = '2025-12-31' BEGIN SELECT RAISE(ABORT, 'test failure'); END")
  t.mock.method(globalThis, 'fetch', async () => Response.json([
    { date: '2024-12-31', priceToSalesRatio: 2 }, { date: '2025-12-31', priceToSalesRatio: 3 },
  ]))
  const report = await syncRatios(db, { only: ['NVDA'] })
  assert.equal(report.rows, 0)
  assert.equal(report.skipped.length, 1)
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM company_ratios').get() as { n: number }).n, 0)
})
