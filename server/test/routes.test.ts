import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import Fastify from 'fastify'

// 在加载配置前指定隔离测试库；不读取或写入本机生产数据库，不调用外部服务。
const dir = mkdtempSync(path.join(tmpdir(), 'news-routes-'))
process.env.DATABASE_PATH = path.join(dir, 'test.db')
process.env.FMP_API_KEY = 'test-only-placeholder'
const { newsRoutes } = await import('../src/routes/news.ts')
const { getDb, closeDb } = await import('../src/db.ts')
const app = Fastify()

before(async () => {
  await app.register(newsRoutes)
  await app.ready()
  const db = getDb()
  db.prepare('INSERT INTO sources (id, name, url, kind) VALUES (?, ?, ?, ?)').run('test', 'Test', 'https://example.com/feed', 'rss')
  const now = new Date().toISOString()
  for (let i = 1; i <= 4; i++) {
    const url = `https://example.com/${i}`
    db.prepare('INSERT INTO raw_items (id, source_id, guid, url, url_norm, title, published_at, fingerprint, fetched_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(i, 'test', String(i), url, url, `AI ${i}`, now, String(i), now)
    db.prepare('INSERT INTO articles (raw_id, url, title, category, score, published_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(i, url, `AI ${i}`, 'model', 80, now, now)
  }
})
after(async () => { await app.close(); closeDb(); rmSync(dir, { recursive: true, force: true }) })

test('文章分页：负数限制不能取消上限，小数不能触发 SQLite 错误', async () => {
  for (const query of ['limit=-1', 'limit=1.5&offset=0.5', 'limit=0', 'days=1e300', 'days=-3']) {
    const res = await app.inject(`/api/news/articles?${query}`)
    assert.equal(res.statusCode, 200, query)
    const body = res.json()
    assert.ok(Number.isInteger(body.limit) && body.limit >= 1 && body.limit <= 200, query)
    assert.ok(Number.isInteger(body.offset) && body.offset >= 0, query)
    assert.ok(body.items.length <= body.limit, query)
  }
})

test('统计接口：小数或超大时间窗口不会返回 500 或产生无界序列', async () => {
  for (const url of ['/api/news/bursts?limit=1.5', '/api/news/risk/history?days=7.5',
    '/api/news/trend/volume?days=2.5', '/api/news/trend/volume?days=1e300']) {
    const res = await app.inject(url)
    assert.equal(res.statusCode, 200, url)
    const body = res.json()
    if (body.days !== undefined) assert.ok(Number.isInteger(body.days) && body.days >= 1 && body.days <= 400)
  }
})

test('行情同步：拒绝不存在的标的，不创建空同步任务', async () => {
  const res = await app.inject({ method: 'POST', url: '/api/news/market/sync?only=NOT_A_SYMBOL' })
  assert.equal(res.statusCode, 400)
  assert.equal(res.json().ok, false)
})

test('行情同步：上游全部失败时任务报错；成功写入部分数据时保留覆盖报告', async (t) => {
  let fail = true
  t.mock.method(globalThis, 'fetch', async (input: URL | string) => {
    if (fail) return new Response('unavailable', { status: 503 })
    const url = new URL(input)
    if (url.pathname.endsWith('/light')) return Response.json([{ date: '2026-11-12', price: 100, volume: 10 }])
    return new Response('unavailable', { status: 503 })
  })
  const run = async () => {
    const start = await app.inject({ method: 'POST', url: '/api/news/market/sync?only=NVDA' })
    assert.equal(start.json().ok, true)
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10))
      const status = (await app.inject(`/api/news/market/sync/${start.json().jobId}`)).json()
      if (status.status !== 'running') return status
    }
    assert.fail('同步任务没有结束')
  }
  const failed = await run()
  assert.equal(failed.status, 'error')
  assert.ok(failed.startedAt && failed.finishedAt)
  assert.ok(failed.report.prices.skipped.length > 0)
  fail = false
  const partial = await run()
  assert.equal(partial.status, 'done')
  assert.ok(partial.startedAt && partial.finishedAt)
  assert.equal(partial.report.prices.rows, 1)
  assert.equal(partial.report.ratios.skipped.length, 1)
})
