import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { periodRange, periodReport, weekStart } from '../src/analytics/period.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function addArticle(db: DatabaseSync, date: string, category = 'model_release', entities: string | null = null): void {
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES ('s1', ?, 'https://x/a', 'https://x/a', 't', 's', ?, 'fp', ?)`,
      )
      .run(`${date}-${Math.random()}`, `${date}T08:00:00.000Z`, `${date}T08:00:00.000Z`).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
     VALUES (?, 'https://x/a', '标题', NULL, '摘要', ?, ?, 70, NULL, NULL, NULL, ?, ?)`,
  ).run(rawId, category, entities, `${date}T08:00:00.000Z`, `${date}T08:00:00.000Z`)
}

test('weekStart：周一为一周之始，周日回退 6 天', () => {
  assert.equal(weekStart('2026-10-20'), '2026-10-19', '周二 → 周一')
  assert.equal(weekStart('2026-10-19'), '2026-10-19', '周一 → 自身')
  assert.equal(weekStart('2026-10-25'), '2026-10-19', '周日 → 上周一')
})

test('periodRange：周为周一到周日，月为整月（含闰年二月）', () => {
  assert.deepEqual(periodRange('week', '2026-10-20'), { start: '2026-10-19', end: '2026-10-25', label: '10-19 ~ 10-25' })
  assert.deepEqual(periodRange('month', '2026-10-20'), { start: '2026-10-01', end: '2026-10-31', label: '2026-10' })
  assert.deepEqual(periodRange('month', '2028-02-10'), { start: '2028-02-01', end: '2028-02-29', label: '2028-02' })
})

test('periodReport：汇总条数 / 环比 / 分类 / 跨源事件 / 实体 / 要点', () => {
  const db = setup()
  // 本周（10-19 ~ 10-25）3 条；上周（10-12 ~ 10-18）1 条
  addArticle(db, '2026-10-19', 'model_release', '["OpenAI"]')
  addArticle(db, '2026-10-20', 'model_release', '["OpenAI","Gemini"]')
  addArticle(db, '2026-10-21', 'policy', null)
  addArticle(db, '2026-10-14', 'funding')

  db.prepare(
    `INSERT INTO event_clusters (event_id, publish_date, representative_title, source_count, article_count, sources_list, category, first_seen, last_seen)
     VALUES ('e1', '2026-10-20', '跨源大事', 4, 5, '["A","B","C","D"]', 'model_release', ?, ?)`,
  ).run('2026-10-20T08:00:00.000Z', '2026-10-20T08:00:00.000Z')
  db.prepare(
    `INSERT INTO burst_detection (date, category, article_count, baseline_mean, baseline_std, z_score, created_at)
     VALUES ('2026-10-20', 'all', 30, 5, 1.5, 16.6, ?)`,
  ).run('2026-10-20T08:00:00.000Z')

  // 传固定的"今天"（2026-11-15），否则跑到别的日期这周还没结束，统计天数会变
  const r = periodReport(db, 'week', '2026-10-20', '2026-11-15')
  assert.equal(r.partial, false)
  assert.equal(r.start, '2026-10-19')
  assert.equal(r.end, '2026-10-25')
  assert.equal(r.totals.articles, 3)
  assert.equal(r.totals.crossEvents, 1)
  assert.equal(r.totals.bursts, 1)
  assert.equal(r.totals.deltaPct, 200, '3 条 vs 上期 1 条 = +200%')
  assert.equal(r.categories[0].category, 'model_release')
  assert.equal(r.categories[0].count, 2)
  assert.equal(r.categories[0].share, 0.667)
  assert.equal(r.topEvents[0].title, '跨源大事')
  assert.equal(r.topEvents[0].sourceCount, 4)
  assert.equal(r.topEntities[0].name, 'OpenAI')
  assert.equal(r.topEntities[0].count, 2)
  assert.ok(r.highlights.length >= 3)
  assert.ok(r.highlights[0].includes('共收录 3 条'))
  assert.ok(r.highlights.join('').includes('跨源大事'))
  db.close()
})

test('periodReport：周期未结束时只算已过天数，并与上期同期比（避免拿 2 天比 7 天）', () => {
  const db = setup()
  // 本周（10-19 起）只过了 10-19、10-20 两天；上周同期（10-12、10-13）放 1 条
  addArticle(db, '2026-10-19', 'model_release')
  addArticle(db, '2026-10-20', 'model_release')
  addArticle(db, '2026-10-21', 'model_release')
  addArticle(db, '2026-10-12', 'funding')

  const r = periodReport(db, 'week', '2026-10-20', '2026-10-20')
  assert.equal(r.partial, true)
  assert.equal(r.daysElapsed, 2)
  assert.equal(r.totals.articles, 2, '10-21 还没发生，不计入')
  assert.equal(r.totals.perDay, 1, '2 条 / 2 天')
  assert.equal(r.totals.deltaPct, 100, '日均 1 vs 上期同期 0.5 → +100%')
  assert.ok(r.highlights[0].includes('进行中'))
  db.close()
})

test('periodReport：空周期不报错，环比为 null', () => {
  const db = setup()
  const r = periodReport(db, 'month', '2026-10-05', '2026-11-15')
  assert.equal(r.totals.articles, 0)
  assert.equal(r.totals.deltaPct, null)
  assert.deepEqual(r.categories, [])
  assert.ok(r.highlights[0].includes('没有入库条目'))
  db.close()
})
