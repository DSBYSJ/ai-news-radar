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
  db.prepare(
    "INSERT INTO sources (id, name, url, kind, weight) VALUES ('a','源A','u','rss',3), ('b','源B','u','rss',2), ('c','源C','u','rss',2)",
  ).run()
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

const NOW = Date.parse('2026-10-20T13:00:00Z')
const at = (h: number): string => new Date(NOW - h * 3_600_000).toISOString()

test('hotRanking：连续衰减 —— 24 小时前 ≈ 权重减半', () => {
  const db = setup()
  addArticle(db, { key: 'eA', at: at(1), source: 'a', url: 'https://x/a', title: '一小时前的事' })
  addArticle(db, { key: 'eB', at: at(25), source: 'b', url: 'https://x/b', title: '二十五小时前的事' })

  const items = hotRanking(db, { now: NOW })
  assert.equal(items.length, 2)
  assert.equal(items[0].title, '一小时前的事')
  assert.equal(items[0].hot, 10, '0.5^(1/24)*10 ≈ 9.7 → 10')
  assert.equal(items[1].hot, 5, '0.5^(25/24)*10 ≈ 4.9 → 5，正好是 24 小时减半')
  db.close()
})

test('hotRanking：热度只数独立来源，同源连发不计入', () => {
  const db = setup()
  // 同一源发 3 篇 → sources=1，hot≈10
  addArticle(db, { key: 'eC', at: at(1), source: 'a', url: 'https://x/1', title: '同源连发' })
  addArticle(db, { key: 'eC', at: at(3), source: 'a', url: 'https://x/2', title: '同源连发' })
  addArticle(db, { key: 'eC', at: at(5), source: 'a', url: 'https://x/3', title: '同源连发' })
  // 3 家独立源 → sources=3
  addArticle(db, { key: 'eD', at: at(1), source: 'a', url: 'https://x/4', title: '三家印证' })
  addArticle(db, { key: 'eD', at: at(2), source: 'b', url: 'https://x/5', title: '三家印证' })
  addArticle(db, { key: 'eD', at: at(3), source: 'c', url: 'https://x/6', title: '三家印证' })

  const items = hotRanking(db, { now: NOW })
  const same = items.find((i) => i.title === '同源连发')
  const multi = items.find((i) => i.title === '三家印证')
  assert.ok(same && multi)
  assert.equal(same.sources, 1)
  assert.equal(same.hot, 10, '同源 3 篇 = 1 个源的热度')
  assert.equal(multi.sources, 3)
  assert.ok(multi.hot > 25, '3 家独立源热度应远高于同源连发')
  db.close()
})

test('hotRanking：跨天同标题合并成一条，源数取独立源', () => {
  const db = setup()
  addArticle(db, { key: 'e1', at: at(25), source: 'a', url: 'https://x/1', title: '同一个事件标题' })
  addArticle(db, { key: 'e2', at: at(1), source: 'b', url: 'https://x/2', title: '同一个事件标题' })

  const items = hotRanking(db, { now: NOW })
  assert.equal(items.length, 1, '应合并为一条')
  assert.equal(items[0].sources, 2, '两个独立源')
  assert.equal(items[0].eventKeys.length, 2)
  assert.equal(items[0].articles, 2)
  db.close()
})

test('hotRanking：标记新事件与动量（近 6 小时 vs 前 6 小时）', () => {
  const db = setup()
  addArticle(db, { key: 'eNew', at: at(2), source: 'a', url: 'https://x/n', title: '刚出现的新闻' })

  addArticle(db, { key: 'eRise', at: at(10), source: 'a', url: 'https://x/1', title: '持续发酵的新闻' })
  addArticle(db, { key: 'eRise', at: at(3), source: 'b', url: 'https://x/2', title: '持续发酵的新闻' })
  addArticle(db, { key: 'eRise', at: at(1), source: 'c', url: 'https://x/3', title: '持续发酵的新闻' })

  const items = hotRanking(db, { now: NOW })
  const fresh = items.find((i) => i.title === '刚出现的新闻')
  const rising = items.find((i) => i.title === '持续发酵的新闻')
  assert.ok(fresh && rising)
  assert.equal(fresh.isNew, true)
  assert.equal(rising.isNew, false)
  assert.equal(rising.recent, 2, '近 6 小时 2 篇（3h、1h）')
  assert.equal(rising.deltaPct, 100, '前 6 小时 1 篇 → +100%')
  assert.equal(rising.hourly.length, 24)
  assert.ok(rising.hourly.some((n) => n > 0))
  assert.ok(rising.topArticle?.url === 'https://x/1', '代表条目应是分数最高的那篇')
  assert.ok(Array.isArray(rising.related))
  db.close()
})

test('hotRanking：返回来源直链与跨天时间线（item 8 / item 5）', () => {
  const db = setup()
  // setup() 已建 a / b / c 三个源，直接用 a 和 b 当"两家独立源"
  const mk = (key: string, at: string, source: string, url: string): void => {
    const rawId = Number(
      db
        .prepare(
          `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
           VALUES (?, ?, ?, ?, ?, 's', ?, ?, ?)`,
        )
        .run(source, url, url, url, '同一个事件', at, url, at).lastInsertRowid,
    )
    db.prepare(
      `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at, ai_relevant)
       VALUES (?, ?, ?, NULL, '摘要', 'model_release', NULL, 70, NULL, NULL, ?, ?, ?, 1)`,
    ).run(rawId, url, '同一个事件', key, at, at)
  }
  mk('e1', '2026-10-20T03:00:00Z', 'a', 'https://x/1')
  mk('e2', '2026-10-21T03:00:00Z', 'b', 'https://x/2')

  const items = hotRanking(db, { now: Date.parse('2026-10-21T13:00:00Z') })
  assert.equal(items.length, 1, '跨天同标题应合并')
  const it = items[0]
  assert.equal(it.sourceLinks.length, 2, '两家来源都应给出直链')
  assert.ok(it.sourceLinks.every((s) => s.url.startsWith('https://x/')), '直链应指向原文')
  assert.equal(it.timeline.length, 2, '跨天事件应有 2 个时间点')
  assert.equal(it.timeline[0].date, '2026-10-20')
  assert.equal(it.timeline[1].date, '2026-10-21')
  db.close()
})

test('hotRanking：单日事件不返回时间线', () => {
  const db = setup()
  addArticle(db, { key: 'e1', at: at(2), source: 'a', url: 'https://x/1', title: '只在今天' })
  const items = hotRanking(db, { now: NOW })
  assert.equal(items[0].timeline.length, 0, '单日事件时间线为空数组')
  db.close()
})
