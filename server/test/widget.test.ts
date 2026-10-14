import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { widgetSnapshot } from '../src/analytics/widget.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function addArticle(db: DatabaseSync, publishedAt: string, category = 'model_release'): void {
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES ('s1', ?, ?, ?, '标题', '摘要', ?, ?, ?)`,
      )
      .run(`g-${publishedAt}-${Math.random()}`, 'https://x/a', 'https://x/a', publishedAt, `fp-${Math.random()}`, publishedAt)
      .lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
     VALUES (?, 'https://x/a', '标题', NULL, '摘要', ?, NULL, 70, NULL, NULL, NULL, ?, ?)`,
  ).run(rawId, category, publishedAt, publishedAt)
}

test('widgetSnapshot：空库时安全返回，不崩', () => {
  const db = setup()
  const s = widgetSnapshot(db)
  assert.equal(s.today, null)
  assert.equal(s.todayCount, 0)
  assert.equal(s.changePct, null)
  assert.equal(s.summary, null)
  assert.ok(s.updatedAt.includes('T'))
  db.close()
})

test('widgetSnapshot：数字来自库内，含跨源 / 突发 / 情感 / 最新简报', () => {
  const db = setup()
  const today = new Date().toISOString()
  const earlier = new Date(Date.now() - 10 * 86_400_000).toISOString()

  for (let i = 0; i < 3; i++) addArticle(db, today)
  for (let i = 0; i < 5; i++) addArticle(db, earlier)

  const day = today.slice(0, 10)
  // 两条源数 ≥2 的跨源事件 + 一条单源事件（不应计入）
  db.prepare(
    `INSERT INTO event_clusters (event_id, publish_date, representative_title, source_count, article_count, sources_list, category, first_seen, last_seen)
     VALUES (1, ?, '跨源事件 A', 3, 3, '["A","B","C"]', 'model_release', ?, ?),
            (2, ?, '跨源事件 B', 2, 2, '["A","B"]', 'funding', ?, ?),
            (3, ?, '单源事件', 1, 1, '["A"]', 'model_release', ?, ?)`,
  ).run(day, today, today, day, today, today, day, today, today)
  db.prepare(
    `INSERT INTO burst_detection (date, category, article_count, baseline_mean, baseline_std, z_score, created_at)
     VALUES (?, 'all', 20, 3.0, 1.2, 14.17, ?), (?, 'funding', 5, 0.5, 0.5, 9.0, ?)`,
  ).run(day, today, day, today)
  db.prepare(
    `INSERT INTO daily_summaries (date, title, content, highlights, stats, model, created_at, updated_at)
     VALUES (?, '今日主题', '正文', NULL, NULL, 'deepseek-chat', ?, ?)`,
  ).run(day, today, today)
  // 情感：3 条已判定，其中 1 条负面 → 占比 0.333
  db.prepare("UPDATE articles SET sentiment = 'negative' WHERE id IN (SELECT id FROM articles WHERE date(published_at) = ? LIMIT 1)").run(day)
  db.prepare("UPDATE articles SET sentiment = 'positive' WHERE id IN (SELECT id FROM articles WHERE date(published_at) = ? LIMIT 2 OFFSET 1)").run(day)

  const s = widgetSnapshot(db)
  assert.equal(s.today, day)
  assert.equal(s.todayCount, 3)
  assert.equal(s.crossToday, 2, '只统计源数 ≥ 2 的事件')
  assert.equal(s.crossEvents.length, 2, '单源事件不出现在跨源列表')
  assert.equal(s.crossEvents[0].title, '跨源事件 A', '按源数降序')
  assert.equal(s.crossEvents[0].sourceCount, 3)
  assert.equal(s.bursts3d, 2)
  assert.equal(s.topBurstZ, 14.17)
  assert.equal(s.topBurstCategory, 'all')
  assert.equal(s.bursts.length, 2)
  assert.equal(s.bursts[0].category, 'all', '按 z 降序')
  assert.equal(s.bursts[0].z, 14.17)
  assert.equal(s.classified, 3)
  assert.equal(s.negShare, 0.333)
  // node:sqlite 返回无原型对象，逐字段断言（deepEqual 会因原型不同失败）
  assert.equal(s.summary?.date, day)
  assert.equal(s.summary?.title, '今日主题')
  db.close()
})
