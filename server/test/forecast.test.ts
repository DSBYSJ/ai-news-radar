import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { forecastVolume, holtForecast } from '../src/analytics/forecast.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

test('Holt：平坦序列 → 预测保持在原值附近，且 lo ≤ 点 ≤ hi', () => {
  const { point, lo, hi } = holtForecast([5, 5, 5, 5, 5, 5], 3)
  for (const p of point) assert.ok(Math.abs(p - 5) < 0.8, `预测 ${p} 应接近 5`)
  point.forEach((p, i) => {
    assert.ok(lo[i] <= p + 1e-9)
    assert.ok(hi[i] >= p - 1e-9)
  })
})

test('Holt：上升序列预测继续上行，下降序列预测回落', () => {
  const up = holtForecast([1, 2, 3, 4, 5, 6, 7], 3).point
  assert.ok(up[0] > 6.5, `上升预测 ${up[0]} 应高于最后实际值`)
  const down = holtForecast([7, 6, 5, 4, 3, 2, 1], 3).point
  assert.ok(down[0] < 1.5, `下降预测 ${down[0]} 应低于最后实际值`)
})

test('Holt：阻尼 — 越远的预测增量越小', () => {
  const point = holtForecast([1, 2, 3, 4, 5, 6], 5).point
  const d1 = point[1] - point[0]
  const d4 = point[4] - point[3]
  assert.ok(d4 <= d1 + 1e-9, '阻尼趋势应让远期增量不超过近期')
})

test('Holt：结果非负（含置信带下界）', () => {
  const { point, lo } = holtForecast([3, 2, 1, 0.5, 0], 5)
  assert.ok(point.every((v) => v >= 0))
  assert.ok(lo.every((v) => v >= 0))
})

test('forecastVolume：历史 + 7 天预测 + 摘要齐全', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.exec("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源一','u','rss',2)")
  const addRaw = (guid: string, publishedAt: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
           VALUES ('s1',?,?,?,?,'摘要',?,?,?)`,
        )
        .run(guid, `https://x/${guid}`, `https://x/${guid}`, `标题${guid}`, publishedAt, `fp-${guid}`, publishedAt).lastInsertRowid,
    )
  for (let d = 0; d < 10; d++) {
    for (let k = 0; k < 2; k++) {
      const rawId = addRaw(`g${d}-${k}`, iso(d))
      db.prepare(
        `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, event_key, published_at, created_at)
         VALUES (?,?,?,NULL,NULL,'policy',NULL,50,NULL,NULL,?,?)`,
      ).run(rawId, 'https://x', `标题${d}-${k}`, iso(d), iso(d))
    }
  }

  const res = forecastVolume(db, 14, 7)
  assert.equal(res.history.length, 14)
  assert.equal(res.forecast.length, 7)
  assert.ok(res.forecast.every((p) => p.value >= 0 && p.lo <= p.value && p.hi >= p.value))
  assert.ok(res.summary.message.length > 0)
  db.close()
})
