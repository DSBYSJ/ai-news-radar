import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { hotRanking } from '../src/analytics/hot.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('a','源A','u','rss',3), ('b','源B','u','rss',2)").run()
  return db
}

function addArticle(db: DatabaseSync, opts: { key: string; at: string; source: string; score?: number; url: string; title: string }): void {
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES (?, ?, ?, ?, ?, 's', ?, ?, ?)`,
      )
      .run(opts.source, opts.url, opts.url, opts.url, opts.title, opts.at, opts.url, opts.at).lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
     VALUES (?, ?, ?, NULL, '摘要', 'model_release', NULL, ?, NULL, NULL, ?, ?, ?)`,
  ).run(rawId, opts.url, opts.title, opts.score ?? 70, opts.key, opts.at, opts.at)
}

function addCluster(db: DatabaseSync, opts: { id: string; date: string; title: string; sources: number; articles: number; first: string; last: string }): void {
  db.prepare(
    `INSERT INTO event_clusters (event_id, publish_date, representative_title, source_count, article_count, sources_list, category, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, '[]', 'model_release', ?, ?)`,
  ).run(opts.id, opts.date, opts.title, opts.sources, opts.articles, opts.first, opts.last)
}

const NOW = Date.parse('2026-10-20T13:00:00Z')

test('hotRanking：当天权重高于前一天（24 小时减半），并按热度排序', () => {
  const db = setup()
  addCluster(db, { id: 'e1', date: '2026-10-19', title: '昨天的大事', sources: 2, articles: 2, first: '2026-10-19T03:00:00Z', last: '2026-10-19T09:00:00Z' })
  addCluster(db, { id: 'e2', date: '2026-10-20', title: '今天的大事', sources: 2, articles: 2, first: '2026-10-20T02:00:00Z', last: '2026-10-20T08:00:00Z' })

  const items = hotRanking(db, { now: NOW })
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '今天的大事', '同规模时当天应排前面')
  assert.ok(items[0].hot > items[1].hot)
  assert.equal(items[0].hot, 80, '(2×3+2)×1×10')
  assert.equal(items[1].hot, 40, '(2×3+2)×0.5×10')
  db.close()
})

test('hotRanking：跨天同标题合并成一条，源数取最大而不相加', () => {
  const db = setup()
  addCluster(db, { id: 'e1', date: '2026-10-19', title: '同一个事件（标题相同）', sources: 3, articles: 3, first: '2026-10-19T03:00:00Z', last: '2026-10-19T10:00:00Z' })
  addCluster(db, { id: 'e2', date: '2026-10-20', title: '同一个事件（标题相同）', sources: 2, articles: 2, first: '2026-10-20T01:00:00Z', last: '2026-10-20T06:00:00Z' })

  const items = hotRanking(db, { now: NOW })
  assert.equal(items.length, 1, '应合并为一条')
  assert.equal(items[0].sources, 3, '源数取最大值，不重复计数')
  assert.equal(items[0].articles, 5, '文章数累加')
  assert.equal(items[0].eventKeys.length, 2)
  db.close()
})

test('hotRanking：标记新事件与动量（近 6 小时 vs 前 6 小时）', () => {
  const db = setup()
  addCluster(db, { id: 'e1', date: '2026-10-20', title: '刚出现的新闻', sources: 1, articles: 1, first: '2026-10-20T11:00:00Z', last: '2026-10-20T12:00:00Z' })
  addArticle(db, { key: 'e1', at: '2026-10-20T11:00:00Z', source: 'a', url: 'https://x/1', title: '刚出现的新闻' })

  addCluster(db, { id: 'e2', date: '2026-10-20', title: '持续发酵的新闻', sources: 2, articles: 6, first: '2026-10-20T03:00:00Z', last: '2026-10-20T12:30:00Z' })
  addArticle(db, { key: 'e2', at: '2026-10-20T05:00:00Z', source: 'a', url: 'https://x/2', title: '持续发酵的新闻' })
  addArticle(db, { key: 'e2', at: '2026-10-20T11:30:00Z', source: 'a', url: 'https://x/4', title: '持续发酵的新闻' })
  addArticle(db, { key: 'e2', at: '2026-10-20T12:30:00Z', source: 'b', url: 'https://x/5', title: '持续发酵的新闻' })

  const items = hotRanking(db, { now: NOW })
  const fresh = items.find((i) => i.title === '刚出现的新闻')
  const rising = items.find((i) => i.title === '持续发酵的新闻')
  assert.ok(fresh && rising)
  assert.equal(fresh.isNew, true, '首次出现在 6 小时内')
  assert.equal(rising.isNew, false)
  assert.equal(rising.recent, 2, '近 6 小时 2 篇')
  assert.equal(rising.deltaPct, 100, '近 6 小时 2 篇 vs 前 6 小时 1 篇 → +100%')
  assert.ok(rising.topArticle?.url.startsWith('https://x/'), '应带代表条目用于阅读')
  assert.equal(rising.hourly.length, 24, '走势图固定 24 个桶')
  assert.ok(rising.hourly.some((n) => n > 0), '近 24 小时应有计数')
  assert.ok(Array.isArray(rising.related), '大卡需要相关报道数组')
  db.close()
})
