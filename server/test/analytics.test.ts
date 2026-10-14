import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { rebuildBursts } from '../src/analytics/bursts.ts'
import { rebuildEvents } from '../src/analytics/events.ts'
import { categoryRatio, crossSource, dailyVolume, velocity } from '../src/analytics/trend.ts'
import { jaccard, titleTokens } from '../src/analytics/tokens.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.exec("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源一','u','rss',2),('s2','源二','u','rss',2)")
  return db
}

function addRaw(db: DatabaseSync, sourceId: string, guid: string, publishedAt: string): number {
  const r = db
    .prepare(
      `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(sourceId, guid, `https://x/${guid}`, `https://x/${guid}`, guid, '摘要', publishedAt, `fp-${guid}`, publishedAt)
  return Number(r.lastInsertRowid)
}

function addArticle(
  db: DatabaseSync,
  rawId: number,
  title: string,
  category: string,
  score: number,
  publishedAt: string,
  summary: string | null = null,
): number {
  const r = db
    .prepare(
      `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, event_key, published_at, created_at)
       VALUES (?,?,?,NULL,?,?,NULL,?,NULL,NULL,?,?)`,
    )
    .run(rawId, 'https://x', title, summary, category, score, publishedAt, publishedAt)
  return Number(r.lastInsertRowid)
}

test('titleTokens：英文按词、中文按字 bigram', () => {
  const tokens = titleTokens('OpenAI 发布 GPT-6')
  assert.ok(tokens.includes('openai'))
  assert.ok(tokens.includes('gpt'))
  assert.ok(tokens.includes('发布'))
  assert.equal(jaccard(new Set(['a', 'b']), new Set(['a', 'b'])), 1)
  assert.equal(jaccard(new Set(['a']), new Set(['b'])), 0)
})

test('第 1 层 dailyVolume：补齐空日期、计数正确', () => {
  const db = setup()
  addArticle(db, addRaw(db, 's1', 'a1', iso(0)), '标题一', 'policy', 50, iso(0))
  const points = dailyVolume(db, 7)
  assert.equal(points.length, 7)
  assert.equal(points[points.length - 1].value, 1)
  assert.equal(points[0].value, 0)
  db.close()
})

test('第 2 层 categoryRatio：占比合计为 1，且不受总条数影响', () => {
  const db = setup()
  addArticle(db, addRaw(db, 's1', 'a1', iso(0)), '标题一', 'policy', 50, iso(0))
  addArticle(db, addRaw(db, 's1', 'a2', iso(0)), '标题二', 'funding', 50, iso(0))
  addArticle(db, addRaw(db, 's2', 'a3', iso(0)), '标题三', 'policy', 50, iso(0))

  const points = categoryRatio(db, 7)
  const today = points[points.length - 1]
  assert.equal(today.total, 3)
  const sum = Object.values(today.ratios).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(sum - 1) < 1e-9)
  assert.ok(Math.abs(today.ratios.policy - 2 / 3) < 1e-9)
  db.close()
})

test('第 3 层 velocity：ma7 前 6 天为 null，之后有值；环比可算', () => {
  const db = setup()
  for (let i = 0; i < 10; i++) {
    addArticle(db, addRaw(db, 's1', `a${i}`, iso(i)), `标题${i}`, 'policy', 50, iso(i))
  }
  const result = velocity(db, 14)
  assert.equal(result.points[0].ma7, null)
  assert.equal(result.points[5].ma7, null)
  assert.ok(result.points[13].ma7 !== null)
  assert.ok(result.thisWeekAvg > 0)
  db.close()
})

test('事件聚类（SimHash ≥0.75）：多源报道同一事件 → 一条事件、source_count=2，并写入 event_clusters', async () => {
  const db = setup()
  const day = iso(0)
  addArticle(db, addRaw(db, 's1', 'g1', day), 'OpenAI 发布 GPT-6，面向所有人开放', 'model_release', 90, day)
  addArticle(db, addRaw(db, 's2', 'g2', day), 'OpenAI 发布 GPT-6，面向所有人开放', 'model_release', 88, day)
  addArticle(db, addRaw(db, 's1', 'g3', day), '某团队提出全新的稀疏注意力架构', 'research_paper', 60, day)

  const summary = await rebuildEvents({ db })
  assert.equal(summary.scanned, 3)
  assert.equal(summary.events, 2)
  assert.equal(summary.crossSourceEvents, 1)

  const event = db
    .prepare('SELECT source_count, article_count FROM events ORDER BY source_count DESC LIMIT 1')
    .get() as { source_count: number; article_count: number }
  assert.equal(event.source_count, 2)
  assert.equal(event.article_count, 2)

  // 需求输出表：event_clusters（含 sources_list / publish_date）
  const cluster = db
    .prepare('SELECT publish_date, representative_title, source_count, article_count, sources_list FROM event_clusters ORDER BY source_count DESC LIMIT 1')
    .get() as { publish_date: string; representative_title: string; source_count: number; article_count: number; sources_list: string }
  assert.equal(cluster.publish_date, day.slice(0, 10))
  assert.equal(cluster.source_count, 2)
  assert.equal(cluster.article_count, 2)
  assert.deepEqual(JSON.parse(cluster.sources_list), ['源一', '源二'])
  assert.ok(cluster.representative_title.includes('GPT-6'))
  db.close()
})

test('事件聚类：改写标题（SimHash 高分）也能合并', async () => {
  const db = setup()
  const day = iso(0)
  addArticle(db, addRaw(db, 's1', 'h1', day), 'OpenAI 发布 GPT-6，面向所有用户开放', 'model_release', 90, day, '新模型向全体用户开放，支持更长上下文')
  addArticle(db, addRaw(db, 's2', 'h2', day), 'OpenAI 正式发布 GPT-6：面向所有用户开放', 'model_release', 85, day, '新模型向全体用户开放，支持更长上下文')

  const summary = await rebuildEvents({ db })
  assert.equal(summary.events, 1)
  assert.equal(summary.crossSourceEvents, 1)
  db.close()
})

test('事件聚类：同标题但不同日 → 不合并（同日口径）', async () => {
  const db = setup()
  addArticle(db, addRaw(db, 's1', 'd1', iso(1)), '同一事件标题', 'policy', 50, iso(1))
  addArticle(db, addRaw(db, 's2', 'd2', iso(0)), '同一事件标题', 'policy', 50, iso(0))

  const summary = await rebuildEvents({ db })
  assert.equal(summary.events, 2)
  assert.equal(summary.crossSourceEvents, 0)
  db.close()
})

test('突发检测（14 天滑动基线）：单日激增被标为异常并写入 burst_detection', async () => {
  const db = setup()
  for (let i = 1; i <= 9; i++) {
    addArticle(db, addRaw(db, 's1', `b${i}`, iso(i)), `政策新闻${i}`, 'policy', 50, iso(i))
  }
  for (let i = 0; i < 12; i++) {
    addArticle(db, addRaw(db, 's1', `c${i}`, iso(0)), `政策爆发${i}`, 'policy', 50, iso(0))
  }

  const rebuilt = await rebuildBursts({ db, days: 30 })
  assert.ok(rebuilt.flagged >= 1, '应至少命中华 1 条突发')

  const result = crossSource(db, 30)
  const burst = result.bursts.find((b) => b.category === 'policy')
  assert.ok(burst, '应检测到 policy 分类的突发')
  assert.ok(burst.z >= 2.5)
  assert.ok(burst.count >= 12)
  // 基线 = 前 14 天均值 ≈ 9/14
  assert.ok(Math.abs(burst.baseline - 0.643) < 0.05)

  // 需求输出表：burst_detection
  const row = db
    .prepare('SELECT article_count, baseline_mean, baseline_std, z_score FROM burst_detection WHERE category = ? ORDER BY z_score DESC LIMIT 1')
    .get('policy') as { article_count: number; baseline_mean: number; baseline_std: number; z_score: number }
  assert.ok(row)
  assert.equal(row.article_count, 12)
  assert.ok(row.z_score >= 2.5)

  // 列表按 Z-score 降序
  const all = result.bursts.map((b) => b.z)
  for (let i = 1; i < all.length; i++) assert.ok(all[i - 1] >= all[i])
  db.close()
})

test('第 4 层 crossSource：返回 dayEvents（悬浮提示用，含来源列表）', async () => {
  const db = setup()
  const day = iso(0)
  addArticle(db, addRaw(db, 's1', 'e1', day), 'Meta 发布新模型 Muse', 'model_release', 90, day)
  addArticle(db, addRaw(db, 's2', 'e2', day), 'Meta 发布新模型 Muse', 'model_release', 88, day)
  await rebuildEvents({ db })

  const result = crossSource(db, 7)
  const date = day.slice(0, 10)
  const events = result.dayEvents[date] ?? []
  assert.equal(events.length, 1)
  assert.equal(events[0].sourceCount, 2)
  assert.deepEqual(events[0].sources, ['源一', '源二'])
  db.close()
})
