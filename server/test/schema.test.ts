import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

test('schema.sql：可在空库上建出 9 张表', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  const rows = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[]
  assert.deepEqual(
    rows.map((r) => r.name),
    [
      'article_vectors',
      'articles',
      'burst_detection',
      'daily_summaries',
      'event_clusters',
      'events',
      'mentions',
      'raw_items',
      'sources',
    ],
  )
  db.close()
})

test('schema.sql：重复执行幂等（IF NOT EXISTS）', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.exec(schemaSql)
  db.close()
})

test('schema.sql：raw_items 的 UNIQUE(source_id, guid) 让重复条目被忽略', () => {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  const insert = db.prepare(`
    INSERT OR IGNORE INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
    VALUES ('s1', 'g1', 'https://example.com/a', 'https://example.com/a', 't', NULL, '2026-10-14T00:00:00.000Z', 'fp', '2026-10-14T00:00:00.000Z')
  `)
  assert.equal(Number(insert.run().changes), 1)
  assert.equal(Number(insert.run().changes), 0)
  db.close()
})
