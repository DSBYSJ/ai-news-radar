import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import {
  buildDailyPrompt,
  generateDailySummary,
  getSummary,
  listSummaries,
  parseSummaryResult,
  prevDate,
  renderSummaryContent,
  statisticalSummary,
} from '../src/ai/summary.ts'

const schemaSql = readFileSync(path.join(import.meta.dirname, '../src/schema.sql'), 'utf8')

function setup(): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(schemaSql)
  db.exec("INSERT INTO sources (id, name, url, kind, weight) VALUES ('s1','量子位','u','rss',2),('s2','TechCrunch AI','u','rss',2)")

  const addRaw = (id: string, guid: string) =>
    Number(
      db
        .prepare(
          `INSERT INTO raw_items (source_id, guid, url, url_norm, title, summary, published_at, fingerprint, fetched_at)
           VALUES (?,?,?,?,?,'摘要',?,?,?)`,
        )
        .run(id, guid, `https://x/${guid}`, `https://x/${guid}`, `标题-${guid}`, `${guid}-time`, guid, guid).lastInsertRowid,
    )

  const addArticle = (sourceId: string, guid: string, day: string, category: string, score: number, eventKey: string | null) => {
    const rawId = addRaw(sourceId, guid)
    db.prepare(
      `INSERT INTO articles (raw_id, url, title, tldr, summary, category, entities, score, score_parts, event_key, published_at, created_at)
       VALUES (?,?,?,?,?,?,NULL,?,NULL,?,?,?)`,
    ).run(rawId, `https://x/${guid}`, `标题-${guid}`, `TLDR-${guid}`, '摘要', category, score, eventKey, `${day}T08:00:00.000Z`, `${day}T08:00:00.000Z`)
  }

  // 10-13 三条（其中两条属于同一个跨源事件），10-12 一条
  addArticle('s1', 'a1', '2026-10-13', 'model_release', 90, 'evt_x')
  addArticle('s2', 'a2', '2026-10-13', 'model_release', 85, 'evt_x')
  addArticle('s1', 'a3', '2026-10-13', 'funding', 60, null)
  addArticle('s1', 'a4', '2026-10-12', 'policy', 50, null)

  db.prepare(
    `INSERT INTO events (event_key, first_seen, last_seen, source_count, article_count, title_repr, category)
     VALUES ('evt_x','2026-10-13T08:00:00.000Z','2026-10-13T08:00:00.000Z',2,2,'同一事件','model_release')`,
  ).run()

  return db
}

test('prevDate：跨月回退正确', () => {
  assert.equal(prevDate('2026-03-01'), '2026-02-28')
  assert.equal(prevDate('2026-10-13'), '2026-10-12')
})

test('parseSummaryResult：解析围栏 JSON；垃圾输入返回 null', () => {
  const raw = '```json\n{"title":"主题","overview":"综述","sections":[{"heading":"模型","points":["要点A"]}],"watch":"关注X"}\n```'
  const parsed = parseSummaryResult(raw)
  assert.ok(parsed)
  assert.equal(parsed.title, '主题')
  assert.equal(parsed.sections[0].points[0], '要点A')
  assert.equal(parseSummaryResult('今天没什么大事'), null)
})

test('renderSummaryContent：综述/分类要点/关注 组装正确', () => {
  const content = renderSummaryContent({
    title: 't',
    overview: '综述内容',
    sections: [{ heading: '模型发布', points: ['要点1', '要点2'] }],
    watch: '关注方向',
  })
  assert.ok(content.includes('综述内容'))
  assert.ok(content.includes('■ 模型发布'))
  assert.ok(content.includes('· 要点1'))
  assert.ok(content.includes('【关注】关注方向'))
})

test('buildDailyPrompt：包含日期、统计与条目', () => {
  const db = setup()
  const prompt = buildDailyPrompt('2026-10-13', [{ id: 1, title: '某模型发布', tldr: 'TLDR', summary: null, url: 'u', category: 'model_release', score: 90, sourceName: '源', sourceCount: 2 }], {
    total: 3,
    byCategory: { model_release: 2, funding: 1 },
    crossSource: 2,
    prevTotal: 1,
    deltaPct: 200,
    topSources: [],
  })
  assert.ok(prompt.includes('2026-10-13'))
  assert.ok(prompt.includes('某模型发布'))
  assert.ok(prompt.includes('[2源]'))
  db.close()
})

test('统计兜底版：包含总数与分类分布', () => {
  const stats = { total: 3, byCategory: { model_release: 2, funding: 1 }, crossSource: 2, prevTotal: 1, deltaPct: 200, topSources: [] }
  const s = statisticalSummary('2026-10-13', [], stats)
  assert.ok(s.title.includes('3 条'))
  assert.ok(s.overview.includes('共收录 3 条'))
  assert.ok(s.overview.includes('+200%'))
})

test('generateDailySummary：无条目的日期跳过、有则生成统计版、幂等、force 可重生成', async () => {
  const db = setup()

  // 无条目 → 跳过（不算失败）
  const empty = await generateDailySummary({ date: '2026-10-01', db, useAi: false })
  assert.equal(empty.ok, false)
  assert.equal(empty.reason, '当天没有条目')

  // 有 3 条 → 生成统计版
  const created = await generateDailySummary({ date: '2026-10-13', db, useAi: false })
  assert.equal(created.ok, true)
  assert.equal(created.skipped, false)
  assert.equal(created.model, 'statistical')

  const detail = getSummary(db, '2026-10-13')
  assert.ok(detail)
  assert.ok(detail.content.includes('2026-10-13'))
  assert.equal(detail.stats?.total, 3)
  assert.equal(detail.stats?.crossSource, 2)
  assert.equal(detail.stats?.prevTotal, 1)
  assert.ok((detail.highlights?.length ?? 0) > 0)

  // 再跑一次 → 幂等跳过
  const again = await generateDailySummary({ date: '2026-10-13', db, useAi: false })
  assert.equal(again.skipped, true)

  // force → 重生成
  const forced = await generateDailySummary({ date: '2026-10-13', db, useAi: false, force: true })
  assert.equal(forced.skipped, false)

  // 列表按日期倒序
  const list = listSummaries(db)
  assert.equal(list.length, 1)
  assert.equal(list[0].date, '2026-10-13')

  db.close()
})
