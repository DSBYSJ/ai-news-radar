import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { buildLinkage } from '../src/market/linkage.ts'
import { symbolOfEntity } from '../src/market/universe.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

/** 造一条新闻：sourceId + 日期 + 提及的实体 */
function addArticle(db: DatabaseSync, i: number, sourceId: string, date: string, entity: string): void {
  const rawId = Number(
    db
      .prepare(
        `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
         VALUES (?, ?, ?, ?, ?, '', ?, ?, ?)`,
      )
      .run(sourceId, `g${i}`, `https://x/${i}`, `https://x/${i}`, `t${i}`, `${date}T10:00:00Z`, `f${i}`, `${date}T10:00:00Z`)
      .lastInsertRowid,
  )
  const artId = Number(
    db
      .prepare(
        `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, sentiment, event_key, published_at, created_at, ai_relevant)
         VALUES (?, ?, ?, NULL, '', 'other', NULL, 60, NULL, NULL, NULL, ?, ?, 1)`,
      )
      .run(rawId, `https://x/${i}`, `t${i}`, `${date}T10:00:00Z`, `${date}T10:00:00Z`).lastInsertRowid,
  )
  db.prepare('INSERT INTO mentions (article_id, entity) VALUES (?, ?)').run(artId, entity)
}

function seedPrices(db: DatabaseSync): void {
  // NVDA：6 个交易日，前 5 天缓涨，第 6 天跳涨
  const days = ['2026-10-01', '2026-10-02', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08']
  const closes = [100, 101, 102, 103, 104, 110]
  const ins = db.prepare('INSERT INTO equity_daily (symbol, date, close, volume) VALUES (?, ?, ?, 1000)')
  days.forEach((d, i) => ins.run('NVDA', d, closes[i]))
  // 纳指：同期几乎不动，用来验证"超额"确实剔除了市场
  const nasdaq = db.prepare('INSERT INTO macro_history (date, series, value) VALUES (?, ?, ?)')
  days.forEach((d) => nasdaq.run(d, 'nasdaq', 20000))
}

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','源1','u','rss',1)").run()
  db.prepare("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s2','源2','u','rss',1)").run()
  seedPrices(db)
  return db
}

test('symbolOfEntity：别名精确匹配，不做模糊包含', () => {
  assert.equal(symbolOfEntity('NVIDIA'), 'NVDA')
  assert.equal(symbolOfEntity('英伟达'), 'NVDA')
  assert.equal(symbolOfEntity('google'), 'GOOGL')
  assert.equal(symbolOfEntity('OpenAI'), null, '非上市公司不应映射')
  assert.equal(symbolOfEntity('NVIDIA Corp'), null, '不做模糊匹配，避免误连')
})

test('buildLinkage：同一实体被两家独立源报道才算事件', () => {
  const db = setup()
  // 只有一家源报道 → 不构成事件
  addArticle(db, 1, 's1', '2026-10-01', 'NVIDIA')
  const one = buildLinkage(db, { minSources: 2, horizon: 5, windowDays: 3650 })
  assert.equal(one.rawEvents, 0, '单源不应算事件')

  // 第二家源同日报道 → 构成事件
  addArticle(db, 2, 's2', '2026-10-01', 'NVIDIA')
  const two = buildLinkage(db, { minSources: 2, horizon: 5, windowDays: 3650 })
  assert.equal(two.rawEvents, 1)
  assert.equal(two.mappedEvents, 1)
  db.close()
})

test('buildLinkage：超额收益 = 个股收益 − 纳指收益（不是绝对涨跌）', () => {
  const db = setup()
  addArticle(db, 1, 's1', '2026-10-01', 'NVIDIA')
  addArticle(db, 2, 's2', '2026-10-01', 'NVIDIA')
  const r = buildLinkage(db, { minSources: 2, horizon: 5, windowDays: 3650 })
  const e = r.items[0]

  // 事件日 10-01 收盘 100，5 个交易日后 10-08 收盘 110 → 个股 +10%
  assert.ok(Math.abs((e.stockReturn as number) - 0.1) < 1e-9, `个股收益应 +10%，实际 ${e.stockReturn}`)
  // 纳指全程 20000 → 0%
  assert.ok(Math.abs((e.indexReturn as number) - 0) < 1e-9)
  // 超额应等于个股收益（因为指数没动）
  assert.ok(Math.abs((e.excessReturn as number) - 0.1) < 1e-9, `超额应 +10%，实际 ${e.excessReturn}`)
  db.close()
})

test('buildLinkage：窗口没走完的事件不计入 T+N 统计，但要如实列出', () => {
  const db = setup()
  // 最后一天的事件：后面没有 5 个交易日
  addArticle(db, 1, 's1', '2026-10-08', 'NVIDIA')
  addArticle(db, 2, 's2', '2026-10-08', 'NVIDIA')
  const r = buildLinkage(db, { minSources: 2, horizon: 5, windowDays: 3650 })
  assert.equal(r.items.length, 1, '事件仍要列出来')
  assert.equal(r.items[0].excessReturn, null, '但结果为空')
  assert.match(r.items[0].reason ?? '', /窗口未走完/)
  assert.equal(r.forward.evaluated, 0, '不能把没走完的当成 0 收益')
  db.close()
})

test('buildLinkage：样本不足时 sufficient=false，不给出"有效"暗示', () => {
  const db = setup()
  addArticle(db, 1, 's1', '2026-10-01', 'NVIDIA')
  addArticle(db, 2, 's2', '2026-10-01', 'NVIDIA')
  const r = buildLinkage(db, { minSources: 2, horizon: 5, windowDays: 3650 })
  assert.equal(r.sufficient, false, '1 个事件远不足以判断')
  assert.match(r.note, /不足以判断/)
  db.close()
})

test('buildLinkage：无法映射到上市公司的实体单独列出（叙事集中在未上市主体）', () => {
  const db = setup()
  addArticle(db, 1, 's1', '2026-10-01', 'OpenAI')
  addArticle(db, 2, 's2', '2026-10-01', 'OpenAI')
  const r = buildLinkage(db, { minSources: 2, horizon: 5, windowDays: 3650 })
  assert.equal(r.mappedEvents, 0, 'OpenAI 没有股票')
  assert.equal(r.unmappedTop[0].entity, 'OpenAI')
  assert.equal(r.unmappedTop[0].mentions, 2)
  db.close()
})
