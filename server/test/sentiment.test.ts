import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { parseSentimentResult, runSentiment, sentimentHeuristic } from '../src/ai/sentiment.ts'
import { dailySentiment, entitySentiment, sentimentAlerts } from '../src/analytics/sentiment.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')
const iso = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString()

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.exec("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源一','u','rss',2)")
  return db
}

function addArticle(
  db: DatabaseSync,
  guid: string,
  title: string,
  daysAgo: number,
  sentiment: string | null,
  entity?: string,
): number {
  const at = iso(daysAgo)
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES ('s1',?,?,?,?,'摘要',?,?,?)`,
      )
      .run(guid, `https://x/${guid}`, `https://x/${guid}`, title, at, `fp-${guid}`, at).lastInsertRowid,
  )
  const articleId = Number(
    db
      .prepare(
        `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at)
         VALUES (?,?,?,NULL,NULL,'policy',NULL,50,NULL,?,NULL,?,?)`,
      )
      .run(rawId, 'https://x', title, sentiment, at, at).lastInsertRowid,
  )
  if (entity) {
    db.prepare('INSERT INTO mentions (article_id, entity) VALUES (?, ?)').run(articleId, entity)
  }
  return articleId
}

test('启发式情感：明显利好 / 利空 / 中性', () => {
  assert.equal(sentimentHeuristic('OpenAI 发布 GPT-6，性能大幅提升'), 'positive')
  assert.equal(sentimentHeuristic('某公司宣布裁员 500 人'), 'negative')
  assert.equal(sentimentHeuristic('一篇关于向量数据库的入门教程'), 'neutral')
  // 混合时按命中数量比较（利空占多）
  assert.equal(sentimentHeuristic('某公司融资失败，宣布破产'), 'negative')
})

test('parseSentimentResult：解析围栏 JSON；空/垃圾返回 null', () => {
  const m = parseSentimentResult(
    '```json\n{"results":[{"id":1,"sentiment":"positive"},{"id":2,"sentiment":"negative"}]}\n```',
  )
  assert.equal(m?.get(1), 'positive')
  assert.equal(m?.get(2), 'negative')
  assert.equal(parseSentimentResult('{"results":[]}'), null)
  assert.equal(parseSentimentResult('随便写点什么'), null)
})

test('runSentiment（无 AI）：启发式写入且幂等', async () => {
  const db = setup()
  addArticle(db, 'a1', 'OpenAI 发布新模型，能力大幅提升', 0, null)
  addArticle(db, 'a2', '某公司宣布裁员并关闭部分业务', 0, null)
  addArticle(db, 'a3', '向量数据库使用教程', 0, null)

  const r1 = await runSentiment({ db, useAi: false, days: 30 })
  assert.equal(r1.updated, 3)
  assert.equal(r1.mode, 'heuristic')

  const rows = db.prepare('SELECT sentiment FROM articles ORDER BY id').all() as unknown as { sentiment: string }[]
  assert.deepEqual(
    rows.map((r) => r.sentiment),
    ['positive', 'negative', 'neutral'],
  )

  const r2 = await runSentiment({ db, useAi: false, days: 30 })
  assert.equal(r2.scanned, 0)
  db.close()
})

test('dailySentiment：占比合计为 1；未判定条目不参与占比', () => {
  const db = setup()
  addArticle(db, 'b1', '标题1', 0, 'positive')
  addArticle(db, 'b2', '标题2', 0, 'positive')
  addArticle(db, 'b3', '标题3', 0, 'negative')
  addArticle(db, 'b4', '标题4', 0, 'neutral')
  addArticle(db, 'b5', '标题5', 0, null) // 未判定

  const days = dailySentiment(db, 7)
  const today = days[days.length - 1]
  assert.equal(today.total, 5)
  assert.equal(today.classified, 4)
  const sum = today.ratios.positive + today.ratios.neutral + today.ratios.negative
  assert.ok(Math.abs(sum - 1) < 1e-9)
  assert.ok(Math.abs(today.ratios.positive - 0.5) < 1e-9)
  db.close()
})

test('entitySentiment：负面占比与 7 日均值', () => {
  const db = setup()
  addArticle(db, 'c1', 'NVIDIA 相关中性新闻', 1, 'neutral', 'NVIDIA')
  addArticle(db, 'c2', 'NVIDIA 遭遇诉讼', 1, 'negative', 'NVIDIA')
  addArticle(db, 'c3', 'NVIDIA 发布新卡', 0, 'positive', 'NVIDIA')

  const res = entitySentiment(db, 'NVIDIA', 7)
  assert.equal(res.total, 3)
  assert.equal(res.negative, 1)
  const last = res.points[res.points.length - 1]
  assert.equal(last.count, 1)
  assert.equal(last.negRatio, 0)
  assert.ok(last.ma7 !== null)
  db.close()
})

test('sentimentAlerts：实体负面飙升（z ≥ 2 且负面数 ≥ 3）触发预警', () => {
  const db = setup()
  // 基线 14 天：隔天 1 条负面（均值 0.5、标准差 ≈ 0.52）
  for (let d = 2; d <= 15; d++) {
    if (d % 2 === 0) addArticle(db, `n${d}`, `某实体负面新闻${d}`, d, 'negative', 'OpenAI')
  }
  // 昨天：负面飙升到 3 条
  addArticle(db, 's1', 'OpenAI 遭遇重大诉讼', 1, 'negative', 'OpenAI')
  addArticle(db, 's2', 'OpenAI 被监管调查', 1, 'negative', 'OpenAI')
  addArticle(db, 's3', 'OpenAI 数据泄露事件', 1, 'negative', 'OpenAI')

  const alerts = sentimentAlerts(db, 30)
  assert.ok(alerts.length >= 1, '应至少触发一条预警')
  const hit = alerts.find((a) => a.entity === 'OpenAI')
  assert.ok(hit, '应命中 OpenAI')
  assert.ok(hit.z >= 2)
  assert.ok(hit.negativeCount >= 3)
  db.close()
})
