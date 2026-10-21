import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { riskReport } from '../src/risk/index.ts'
import { narrativeFroth } from '../src/risk/narrative.ts'
import type { MacroSnapshot } from '../src/risk/macro.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源','u','rss',2)").run()
  return db
}

const NOW = Date.parse('2026-10-21T00:00:00Z')
const day = (n: number): string => new Date(NOW - n * 86_400_000).toISOString()

function add(
  db: DatabaseSync,
  opts: { i: number; daysAgo: number; title: string; summary?: string; category?: string; sentiment?: string; entities?: string },
): void {
  const at = day(opts.daysAgo)
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES ('s1', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(`g${opts.i}`, `https://x/${opts.i}`, `https://x/${opts.i}`, opts.title, opts.summary ?? '', at, `f${opts.i}`, at).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at, ai_relevant)
     VALUES (?, ?, ?, NULL, ?, ?, ?, 60, NULL, ?, NULL, ?, ?, 1)`,
  ).run(rawId, `https://x/${opts.i}`, opts.title, opts.summary ?? '', opts.category ?? 'other', opts.entities ?? null, opts.sentiment ?? null, at, at)
}

test('narrativeFroth：样本不足时返回 null，不硬算', () => {
  const db = setup()
  add(db, { i: 1, daysAgo: 1, title: '只有一条' })
  const r = narrativeFroth(db, { now: NOW })
  assert.equal(r.nfi, null)
  assert.equal(r.band, 'unknown')
  assert.ok(r.observations[0].value.includes('不足以计算'))
  db.close()
})

test('narrativeFroth：融资密集 + 情绪偏正 + 实体集中 + 加速 → 指数显著偏高', () => {
  const db = setup()
  // 前 7 天：每天 5 条；近 7 天：每天 10 条（2 倍加速，过基期门槛 ≥5）
  // 一半带融资词；情绪全正；实体集中
  let i = 0
  for (let d = 14; d > 7; d--) {
    for (let k = 0; k < 5; k++) add(db, { i: ++i, daysAgo: d, title: `普通消息 ${i}`, category: 'other', sentiment: 'neutral' })
  }
  for (let d = 7; d > 0; d--) {
    for (let k = 0; k < 10; k++) {
      add(db, {
        i: ++i,
        daysAgo: d,
        title: k % 2 === 0 ? `某公司完成 B 轮融资，估值创新高 ${i}` : `模型发布 ${i}`,
        category: k % 2 === 0 ? 'funding' : 'model_release',
        sentiment: 'positive',
        entities: '["OpenAI","OpenAI"]',
      })
    }
  }
  const r = narrativeFroth(db, { now: NOW })
  assert.ok(r.nfi !== null && r.nfi >= 55, `预期偏高，实际 ${r.nfi}`)
  assert.ok(r.band === 'warm' || r.band === 'hot')
  const accel = r.factors.find((f) => f.key === 'acceleration')
  assert.ok(accel && (accel.score ?? 0) > 50, '加速度应显著')
  db.close()
})

test('riskReport：没有宏观数据时不给危机概率，并说明缺什么', async () => {
  const db = setup()
  for (let d = 1; d <= 10; d++) add(db, { i: d, daysAgo: d, title: `消息 ${d}`, sentiment: 'neutral' })
  // 显式注入"宏观不可用"，避免测试依赖网络
  const unavailable: MacroSnapshot = {
    available: false,
    missing: ['10 年期美债收益率', '高收益债信用利差', '纳斯达克指数'],
    series: {},
    inversion: null,
    notes: ['测试注入'],
    fetchedAt: new Date(NOW).toISOString(),
  }
  const r = await riskReport(db, { now: NOW, macro: unavailable })
  assert.equal(r.crisis, null)
  assert.equal(r.macro.available, false)
  assert.equal(r.macro.missing.length, 3)
  assert.ok(r.disclaimer.includes('不是估值模型'))
  db.close()
})

test('riskReport：接入宏观数据后才计算风险分与概率区间', async () => {
  const db = setup()
  for (let d = 1; d <= 20; d++) {
    add(db, { i: d, daysAgo: d, title: `某公司完成融资，估值暴涨 ${d}`, category: 'funding', sentiment: 'positive' })
  }
  const macro: MacroSnapshot = {
    available: true,
    missing: [],
    inversion: false,
    fetchedAt: new Date(NOW).toISOString(),
    notes: [],
    series: {
      rates10y: { key: 'rates10y', label: '10Y', value: 4.8, asOf: '2026-10-20', yearAgo: 3.9, avg200: null, high52w: null, history: [3.9, 4.8], source: 'test' },
      creditSpread: { key: 'creditSpread', label: 'OAS', value: 2.6, asOf: '2026-10-20', yearAgo: 3.4, avg200: null, high52w: null, history: [3.4, 2.6], source: 'test' },
      nasdaq: { key: 'nasdaq', label: 'NDX', value: 26000, asOf: '2026-10-20', yearAgo: 18000, avg200: 22000, high52w: 27000, history: [18000, 26000], source: 'test' },
    },
  }
  const r = await riskReport(db, { now: NOW, macro })
  assert.ok(r.crisis, '有宏观时应给出风险分')
  assert.ok(r.crisis!.score > 40, `风险分应偏高，实际 ${r.crisis!.score}`)
  assert.ok(r.crisis!.probability12m)
  const p = r.crisis!.probability12m!
  assert.ok(p.low < p.high && p.high <= 75)
  assert.ok(r.crisis!.factors.some((f) => f.key === 'narrative'))
  db.close()
})
