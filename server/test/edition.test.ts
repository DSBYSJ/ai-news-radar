import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { dailyEdition } from '../src/analytics/edition.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  return db
}

function addArticle(
  db: DatabaseSync,
  opts: { date: string; title: string; category: string; score: number; source: string; url: string; eventKey?: string; weight?: number },
): void {
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES (?, ?, ?, ?, ?, 'src', ?, ?, ?)`,
      )
      .run(opts.source, opts.url, opts.url, opts.url, opts.title, `${opts.date}T08:00:00.000Z`, opts.url, `${opts.date}T08:00:00.000Z`)
      .lastInsertRowid,
  )
  db.prepare(
    `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    rawId,
    opts.url,
    opts.title,
    `${opts.title}（一句话）`,
    `${opts.title}（摘要）`,
    opts.category,
    opts.score,
    opts.eventKey ?? null,
    `${opts.date}T08:00:00.000Z`,
    `${opts.date}T08:00:00.000Z`,
  )
}

test('dailyEdition：空日期安全返回', () => {
  const db = setup()
  const e = dailyEdition(db, '2026-10-20')
  assert.equal(e.headline, null)
  assert.deepEqual(e.sections, [])
  assert.deepEqual(e.flash, [])
  assert.equal(e.brief, null)
  assert.equal(e.stats.total, 0)
  db.close()
})

test('dailyEdition：头条优先跨源事件，分区按固定枚举顺序且不重复，低分进快讯', () => {
  const db = setup()
  const day = '2026-10-20'
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('a', '官方 A', 'u', 'rss', 3), ('b', '媒体 B', 'u', 'rss', 1), ('c', '媒体 C', 'u', 'rss', 1)").run()

  addArticle(db, { date: day, title: '高分单源', category: 'model_release', score: 90, source: 'a', url: 'https://x/1' })
  addArticle(db, { date: day, title: '跨源事件', category: 'product_update', score: 70, source: 'a', url: 'https://x/2', eventKey: 'evt_cross' })
  addArticle(db, { date: day, title: '跨源事件（第二家）', category: 'product_update', score: 60, source: 'b', url: 'https://x/3', eventKey: 'evt_cross' })
  addArticle(db, { date: day, title: '低分快讯', category: 'other', score: 20, source: 'c', url: 'https://x/4' })

  db.prepare(
    `INSERT INTO event_clusters (event_id, publish_date, representative_title, source_count, article_count, sources_list, category, first_seen, last_seen)
     VALUES ('evt_cross', ?, '跨源事件', 3, 2, '["官方 A","媒体 B","媒体 C"]', 'product_update', ?, ?)`,
  ).run(day, `${day}T08:00:00.000Z`, `${day}T08:00:00.000Z`)
  db.prepare(
    `INSERT INTO daily_summaries (date, title, content, highlights, stats, model, created_at, updated_at)
     VALUES (?, '当天主题', '综述正文', NULL, NULL, 'deepseek-chat', ?, ?)`,
  ).run(day, `${day}T10:00:00.000Z`, `${day}T10:00:00.000Z`)

  const e = dailyEdition(db, day)
  assert.equal(e.headline?.title, '跨源事件', '跨源事件优先于更高分的单源条目')
  assert.equal(e.headline?.sourceCount, 3)
  assert.deepEqual(e.headline?.sources, ['官方 A', '媒体 B', '媒体 C'])
  assert.equal(e.stats.total, 4)
  assert.equal(e.stats.crossSource, 1)

  // 分区只剩高分单源（model_release）；product_update 的两条已被头条占用一条
  const labels = e.sections.map((s) => s.label)
  assert.deepEqual(labels, ['模型发布'], `预期只保留模型发布，实际 ${labels.join('/')}`)
  assert.equal(e.sections[0].items[0].title, '高分单源')

  // 低分条目落到快讯
  assert.equal(e.flash.length, 1)
  assert.equal(e.flash[0].title, '低分快讯')

  // 导语来自 AI 简报
  assert.equal(e.brief?.title, '当天主题')
  assert.equal(e.brief?.content, '综述正文')
  db.close()
})
