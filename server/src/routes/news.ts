import type { FastifyInstance } from 'fastify'
import { rebuildEvents } from '../analytics/events.ts'
import { categoryRatio, crossSource, dailyVolume, topEntities, velocity } from '../analytics/trend.ts'
import { widgetSnapshot } from '../analytics/widget.ts'
import { CATEGORY_LABELS, type Category } from '../ai/categories.ts'
import { runProcessing } from '../ai/pipeline.ts'
import { askQuestion } from '../ai/ask.ts'
import { generateDailySummary, getSummary, listSummaries, yesterdayUtc } from '../ai/summary.ts'
import { forecastVolume } from '../analytics/forecast.ts'
import { dailySentiment, entitySentiment, sentimentAlerts, topEntitiesWithSentiment } from '../analytics/sentiment.ts'
import { broadcast, sinkCount } from '../push.ts'
import { runCollect } from '../collector/index.ts'
import { config } from '../config.ts'
import { getDb } from '../db.ts'
import { runFullPipeline } from '../jobs.ts'

const DAY_MS = 86_400_000

interface Query {
  [key: string]: string | undefined
}

function num(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function cutoff(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString()
}

function safeJson(text: string | null): string[] {
  if (!text) return []
  try {
    const parsed = JSON.parse(text) as unknown
    return Array.isArray(parsed) ? parsed.filter((e): e is string => typeof e === 'string') : []
  } catch {
    return []
  }
}

export async function newsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/news/health', async () => {
    const db = getDb()
    const countOf = (sql: string): number => {
      const row = db.prepare(sql).get() as unknown as { n: number } | undefined
      return row?.n ?? 0
    }
    return {
      ok: true,
      service: 'ai-news',
      version: config.version,
      sources: countOf('SELECT COUNT(*) AS n FROM sources WHERE enabled = 1'),
      rawItems: countOf('SELECT COUNT(*) AS n FROM raw_items'),
      articles: countOf('SELECT COUNT(*) AS n FROM articles'),
      events: countOf('SELECT COUNT(*) AS n FROM events'),
      aiEnabled: config.aiEnabled,
      authEnabled: Boolean(config.jwtSecret),
      time: new Date().toISOString(),
    }
  })

  /** 成品列表（日期 / 分类 / 源 / 最低分 / 关键词筛选 + 分页） */
  app.get('/api/news/articles', async (req) => {
    const q = req.query as Query
    const db = getDb()
    const days = num(q.days, 7)
    const limit = Math.min(num(q.limit, 50), 200)
    const offset = Math.max(num(q.offset, 0), 0)
    const minScore = num(q.minScore, 0)

    const where: string[] = ['a.published_at >= ?']
    const params: (string | number)[] = [cutoff(days)]

    if (q.category) {
      where.push('a.category = ?')
      params.push(q.category)
    }
    if (q.source) {
      where.push('r.source_id = ?')
      params.push(q.source)
    }
    if (minScore > 0) {
      where.push('a.score >= ?')
      params.push(minScore)
    }
    if (q.q) {
      where.push('(a.title LIKE ? OR COALESCE(a.summary, "") LIKE ?)')
      params.push(`%${q.q}%`, `%${q.q}%`)
    }
    const whereSql = where.join(' AND ')

    const rows = db
      .prepare(
        `SELECT a.id, a.title, a.tldr, a.summary, a.url, a.category, a.score, a.entities,
                a.published_at, r.source_id AS sourceId, s.name AS sourceName,
                a.event_key AS eventKey, e.source_count AS sourceCount
         FROM articles a
         JOIN raw_items r ON r.id = a.raw_id
         JOIN sources s ON s.id = r.source_id
         LEFT JOIN events e ON e.event_key = a.event_key
         WHERE ${whereSql}
         ORDER BY a.published_at DESC, a.score DESC
         LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as unknown as {
      id: number
      title: string
      tldr: string | null
      summary: string | null
      url: string
      category: string
      score: number | null
      entities: string | null
      published_at: string
      sourceId: string
      sourceName: string
      eventKey: string | null
      sourceCount: number | null
    }[]

    const totalRow = db
      .prepare(
        `SELECT COUNT(*) AS n FROM articles a
         JOIN raw_items r ON r.id = a.raw_id
         WHERE ${whereSql}`,
      )
      .get(...params) as unknown as { n: number }

    return {
      total: Number(totalRow?.n ?? 0),
      limit,
      offset,
      items: rows.map((r) => ({
        id: r.id,
        title: r.title,
        tldr: r.tldr,
        summary: r.summary,
        url: r.url,
        category: r.category,
        categoryLabel: CATEGORY_LABELS[(r.category as Category) ?? 'other'] ?? r.category,
        score: r.score,
        entities: safeJson(r.entities),
        publishedAt: r.published_at,
        sourceId: r.sourceId,
        sourceName: r.sourceName,
        eventKey: r.eventKey,
        sourceCount: r.sourceCount,
      })),
    }
  })

  /** 第 1 层 · 每日条数（⚠️ 假趋势，仅作对照） */
  app.get('/api/news/trend/volume', async (req) => {
    const days = num((req.query as Query).days, 30)
    return { days, points: dailyVolume(getDb(), days) }
  })

  /** 第 2 层 · 分类占比趋势 */
  app.get('/api/news/trend/category', async (req) => {
    const days = num((req.query as Query).days, 30)
    return { days, points: categoryRatio(getDb(), days) }
  })

  /** 第 3 层 · 7 日移动平均 + 周环比 */
  app.get('/api/news/trend/velocity', async (req) => {
    const days = num((req.query as Query).days, 30)
    return { days, ...velocity(getDb(), days) }
  })

  /** 第 4 层 · 跨源交叉度 + 突发检测（★ 差异化核心） */
  app.get('/api/news/trend/cross', async (req) => {
    const days = num((req.query as Query).days, 30)
    return { days, ...crossSource(getDb(), days) }
  })

  /** 突发检测输出表（burst_detection，按 Z-score 降序） */
  app.get('/api/news/bursts', async (req) => {
    const q = req.query as Query
    const days = num(q.days, 30)
    const limit = Math.min(num(q.limit, 50), 200)
    const rows = getDb()
      .prepare(
        `SELECT date, category, article_count, baseline_mean, baseline_std, z_score
         FROM burst_detection WHERE date >= ? ORDER BY z_score DESC LIMIT ?`,
      )
      .all(cutoff(days).slice(0, 10), limit) as unknown as {
      date: string
      category: string
      article_count: number
      baseline_mean: number
      baseline_std: number
      z_score: number
    }[]
    return {
      days,
      items: rows.map((r) => ({
        date: r.date,
        category: r.category,
        articleCount: Number(r.article_count),
        baselineMean: Number(r.baseline_mean),
        baselineStd: Number(r.baseline_std),
        z: Number(r.z_score),
      })),
    }
  })

  /** 实体热度 */
  app.get('/api/news/entities', async (req) => {
    const q = req.query as Query
    return { days: num(q.days, 30), items: topEntities(getDb(), num(q.days, 30), num(q.limit, 15)) }
  })

  /** 源清单（含最近抓取状态） */
  app.get('/api/news/sources', async () => ({
    items: getDb()
      .prepare('SELECT id, name, url, kind, weight, enabled, last_fetch_at, last_status FROM sources ORDER BY id')
      .all(),
  }))

  /** 桌面小组件快照（轻量：几个关键数字 + 最新简报标题，字段稳定） */
  app.get('/api/news/widget', async () => widgetSnapshot(getDb()))

  /** 自然语言问答（自用；统计类 = Text-to-SQL，归因类 = 向量检索 + 上下文） */
  app.post('/api/news/ask', async (req, reply) => {
    const body = (req.body ?? {}) as { question?: string }
    const question = typeof body.question === 'string' ? body.question.trim() : ''
    if (!question) return reply.code(400).send({ error: '请输入问题' })
    if (question.length > 200) return reply.code(400).send({ error: '问题请控制在 200 字以内' })
    return askQuestion(question)
  })

  /** 短期热度预测（Holt 阻尼趋势，本地计算，无外部依赖） */
  app.get('/api/news/forecast', async (req) => {
    const q = req.query as Query
    const days = num(q.days, 30)
    const horizon = Math.min(Math.max(num(q.horizon, 7), 1), 14)
    return { days, horizon, ...forecastVolume(getDb(), days, horizon) }
  })

  /** 情感趋势：每日正/负/中占比 + 实体负面预警 + 实体列表 */
  app.get('/api/news/sentiment', async (req) => {
    const q = req.query as Query
    const days = num(q.days, 30)
    const db = getDb()
    return {
      days,
      byDay: dailySentiment(db, days),
      alerts: sentimentAlerts(db, days),
      entities: topEntitiesWithSentiment(db, days),
    }
  })

  /** 情感趋势：某实体的负面占比曲线（7 日滑动平均） */
  app.get('/api/news/sentiment/entity/:entity', async (req) => {
    const { entity } = req.params as { entity: string }
    const days = num((req.query as Query).days, 30)
    return { days, ...entitySentiment(getDb(), entity, days) }
  })

  /** 实时推送自检（鉴权后可调用）：广播一条模拟突发，返回实际投递数 */
  app.post('/api/news/push/test', async () => {
    const delivered = broadcast({
      type: 'burst',
      at: new Date().toISOString(),
      items: [
        {
          date: new Date().toISOString().slice(0, 10),
          category: 'all',
          articleCount: 42,
          baseline: 1.5,
          z: 9.99,
          test: true,
        },
      ],
    })
    return { ok: true, delivered, clients: sinkCount() }
  })

  /** 每日总结：历史列表 */
  app.get('/api/news/summaries', async (req) => {
    const limit = Math.min(num((req.query as Query).limit, 60), 180)
    return { items: listSummaries(getDb(), limit) }
  })

  /** 每日总结：某天详情 */
  app.get('/api/news/summaries/:date', async (req, reply) => {
    const { date } = req.params as { date: string }
    const row = getSummary(getDb(), date)
    if (!row) return reply.code(404).send({ error: '该日期暂无每日总结' })
    return row
  })

  /** 每日总结：生成 / 更新（默认昨天；force=true 强制重生成） */
  app.post('/api/news/summaries/generate', async (req) => {
    const body = (req.body ?? {}) as { date?: string; force?: boolean }
    const date = typeof body.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(body.date) ? body.date : yesterdayUtc()
    const result = await generateDailySummary({ date, force: body.force === true })
    return { ...result, summary: getSummary(getDb(), date) }
  })

  // 手动触发（上线后同样受鉴权中间件保护）
  app.post('/api/news/collect', async () => runCollect())
  app.post('/api/news/process', async () => {
    const summary = await runProcessing({ sinceDays: 30, limit: 500 })
    const events = await rebuildEvents({ days: 90 })
    return { ...summary, events }
  })
  app.post('/api/news/pipeline', async () => runFullPipeline())
}
