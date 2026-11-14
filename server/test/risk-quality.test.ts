import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { riskReport } from '../src/risk/index.ts'
import { parseFredCsv, type MacroSnapshot } from '../src/risk/macro.ts'

const NOW = Date.parse('2026-11-14T12:00:00Z')
const schema = readFileSync(new URL('../src/schema.sql', import.meta.url), 'utf8')
function macro(): MacroSnapshot {
  return { available: true, missing: [], inversion: false, notes: [], fetchedAt: new Date(NOW).toISOString(),
    series: Object.fromEntries(['rates10y','rates2y','creditSpread','creditSpreadLong','nasdaq'].map(key => [key, {
      key, label: key, value: key === 'nasdaq' ? 100 : 3.2, asOf: '2026-11-13', yearAgo: null,
      avg200: null, high52w: null, history: [3], dates: ['2026-11-13'], source: 'test',
    }])) }
}
function setup(t: { after: (fn: () => void) => void }) {
  const db = new DatabaseSync(':memory:'); db.exec(schema); t.after(() => db.close())
  db.prepare('INSERT INTO sources(id,name,url,kind)VALUES(?,?,?,?)').run('s','Test','https://example.com','rss')
  return db
}
function add(db: DatabaseSync, i: number, sentiment: string, hours = 1) {
  const at = new Date(NOW - hours * 3_600_000).toISOString()
  db.prepare('INSERT INTO raw_items(id,source_id,guid,url,url_norm,title,published_at,fingerprint,fetched_at)VALUES(?,?,?,?,?,?,?,?,?)')
    .run(i,'s',String(i),`https://example.com/${i}`,`https://example.com/${i}`,'Model news',at,String(i),at)
  db.prepare('INSERT INTO articles(id,raw_id,url,title,category,entities,sentiment,published_at,created_at)VALUES(?,?,?,?,?,?,?,?,?)')
    .run(i,i,`https://example.com/${i}`,'Model news','model_release','["OpenAI"]',sentiment,at,at)
  db.prepare('INSERT INTO mentions(article_id,entity)VALUES(?,?)').run(i,'OpenAI')
}

test('质量：4 个必需序列与辅助代理序列分开计数，滞后取必需项最旧日期', async t => {
  const db = setup(t), m = macro()
  m.series.rates10y.asOf = '2026-11-03'
  const r = await riskReport(db, { now: NOW, macro: m })
  assert.equal(r.quality.dimensions.find(d => d.key === 'macro')?.value, '4/4 序列')
  assert.equal(r.quality.macro.staleDays, 11)
  assert.equal(r.crisis, null, '核心序列过期不得输出看似正常的 CRS')
})

test('CRS：核心序列缺失时不拿单个指标归一成完整危机分', async t => {
  const db = setup(t), m = macro()
  delete m.series.creditSpread
  const r = await riskReport(db, { now: NOW, macro: m })
  assert.equal(r.crisis, null)
  assert.ok(r.quality.unavailable.some(x => x.includes('暂停计算')))
})

test('实体风险：不受低 CRS 门槛屏蔽；没有融资报道本身不增加分数', async t => {
  const db = setup(t)
  for (let i = 1; i <= 4; i++) add(db, i, 'neutral')
  const quiet = await riskReport(db, { now: NOW, macro: macro() })
  assert.equal(quiet.vulnerableEntities.length, 0)
  db.exec("UPDATE articles SET sentiment='negative'")
  const negative = await riskReport(db, { now: NOW, macro: macro() })
  assert.ok(negative.crisis!.score < 50)
  assert.equal(negative.vulnerableEntities[0].score, 70)
  assert.ok(!negative.vulnerableEntities[0].reason.includes('无融资'))
})

test('质量：未来新闻不能污染来源数和实体覆盖率', async t => {
  const db = setup(t)
  add(db, 1, 'neutral', -24)
  const r = await riskReport(db, { now: NOW, macro: macro() })
  assert.equal(r.quality.dimensions.find(d => d.key === 'sources')?.value, '0 个')
  assert.equal(r.quality.dimensions.find(d => d.key === 'entities')?.value, '0%')
})

test('FRED CSV：降序响应必须排序，以最新观测而非最旧观测作为当前值', () => {
  const rows = parseFredCsv('observation_date,DGS10\n2026-11-13,4.5\n2026-11-12,4.4\n2026-11-11,.\n')
  assert.deepEqual(rows.map(r => r.date), ['2026-11-12','2026-11-13'])
  assert.equal(rows.at(-1)?.value, 4.5)
})
