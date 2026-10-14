/**
 * MCP Server（stdio 传输，零依赖手写 JSON-RPC 2.0）
 *
 * 设计约束（合规）：**只读、仅自用** —— 走 stdio 本地进程，不开放任何网络端口；
 * 不提供写入/触发类工具，避免把采集或 AI 调用暴露给外部会话。
 *
 * 用法：
 *   node src/mcp/stdio.ts            # 由 MCP 客户端（Claude Desktop / WorkBuddy 等）拉起
 *   npm run mcp
 */
import { createInterface } from 'node:readline'
import { CATEGORY_LABELS, type Category } from '../ai/categories.ts'
import { getSummary, listSummaries } from '../ai/summary.ts'
import { forecastVolume } from '../analytics/forecast.ts'
import { dailySentiment, sentimentAlerts, topEntitiesWithSentiment } from '../analytics/sentiment.ts'
import { crossSource, dailyVolume, velocity } from '../analytics/trend.ts'
import { config } from '../config.ts'
import { getDb } from '../db.ts'

const SERVER_INFO = { name: 'ai-news-radar', version: config.version }

const DAY_MS = 86_400_000
const cutoffIso = (days: number) => new Date(Date.now() - days * DAY_MS).toISOString()

const label = (category: string) => CATEGORY_LABELS[category as Category] ?? category

interface ToolDef {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

const TOOLS: ToolDef[] = [
  {
    name: 'search_articles',
    description: '按关键词 / 分类 / 最低分检索近期资讯（只返回标题、摘要、来源与原文链接）',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词（匹配标题/摘要/TL;DR）' },
        days: { type: 'number', description: '回溯天数，默认 7' },
        category: { type: 'string', description: '分类（model_release/product_update/research_paper/open_source/funding/policy/opinion/other）' },
        minScore: { type: 'number', description: '最低重要度（0~100）' },
        limit: { type: 'number', description: '返回条数，默认 10，最大 50' },
      },
    },
  },
  {
    name: 'get_trend',
    description: '获取每日收录量、7 日均线、周环比与未来 7 天短期预测',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: '统计窗口，默认 30' } } },
  },
  {
    name: 'get_cross_events',
    description: '跨源交叉事件榜：同一事件被几家独立源报道（≥2 源为跨源事件）',
    inputSchema: {
      type: 'object',
      properties: {
        days: { type: 'number', description: '统计窗口，默认 30' },
        minSources: { type: 'number', description: '最少源数，默认 2' },
        limit: { type: 'number', description: '返回条数，默认 10' },
      },
    },
  },
  {
    name: 'get_bursts',
    description: '突发检测结果（14 天滑动基线，z ≥ 2.5），按 Z-score 降序',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: '统计窗口，默认 30' } } },
  },
  {
    name: 'get_sentiment',
    description: '情感趋势：每日正/负/中占比 + 实体负面情感飙升预警',
    inputSchema: { type: 'object', properties: { days: { type: 'number', description: '统计窗口，默认 30' } } },
  },
  {
    name: 'list_daily_summaries',
    description: '每日简报历史列表（日期 + 标题）',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: '返回条数，默认 14' } } },
  },
  {
    name: 'get_daily_summary',
    description: '获取某天（UTC，YYYY-MM-DD）的完整简报内容',
    inputSchema: {
      type: 'object',
      properties: { date: { type: 'string', description: '日期 YYYY-MM-DD' } },
      required: ['date'],
    },
  },
]

interface ToolResult {
  content: { type: 'text'; text: string }[]
  isError?: boolean
}

function text(body: string): ToolResult {
  return { content: [{ type: 'text', text: body }] }
}

function num(v: unknown, fallback: number, min = 0, max = 1000): number {
  const n = Number(v)
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(n, min), max)
}

function callTool(name: string, args: Record<string, unknown>): ToolResult {
  const db = getDb()

  switch (name) {
    case 'search_articles': {
      const days = num(args.days, 7, 1, 365)
      const limit = num(args.limit, 10, 1, 50)
      const where = ['a.published_at >= ?']
      const params: (string | number)[] = [cutoffIso(days)]
      if (typeof args.query === 'string' && args.query.trim()) {
        where.push('(a.title LIKE ? OR a.summary LIKE ? OR a.tldr LIKE ?)')
        const like = `%${args.query.trim()}%`
        params.push(like, like, like)
      }
      if (typeof args.category === 'string' && args.category) {
        where.push('a.category = ?')
        params.push(args.category)
      }
      if (args.minScore !== undefined) {
        where.push('COALESCE(a.score, 0) >= ?')
        params.push(num(args.minScore, 0, 0, 100))
      }
      params.push(limit)

      const rows = db
        .prepare(
          `SELECT a.title, a.category, a.score, COALESCE(a.tldr, a.summary, '') AS brief,
                  s.name AS source, a.url, date(a.published_at) AS d
           FROM articles a
           JOIN raw_items r ON r.id = a.raw_id JOIN sources s ON s.id = r.source_id
           WHERE ${where.join(' AND ')}
           ORDER BY COALESCE(a.score, 0) DESC, a.published_at DESC
           LIMIT ?`,
        )
        .all(...params) as unknown as { title: string; category: string; score: number | null; brief: string; source: string; url: string; d: string }[]

      if (rows.length === 0) return text(`（近 ${days} 天内没有匹配的资讯）`)
      return text(
        rows
          .map((r) => `- [${r.d}] ${r.title}\n  ${label(r.category)} · ${r.score ?? '-'} 分 · ${r.source}\n  ${r.brief.slice(0, 120)}\n  ${r.url}`)
          .join('\n'),
      )
    }

    case 'get_trend': {
      const days = num(args.days, 30, 7, 365)
      const vel = velocity(db, days)
      const fc = forecastVolume(db, days, 7)
      const vol = dailyVolume(db, days).slice(-7)
      const forecastAvg = fc.forecast.reduce((a, b) => a + b.value, 0) / Math.max(1, fc.forecast.length)
      return text(
        [
          `近 ${days} 天趋势：本周均值 ${vel.thisWeekAvg} 条/天，上周 ${vel.lastWeekAvg} 条/天，周环比 ${vel.changePct ?? '—'}%`,
          `最近 7 天：${vol.map((p) => `${p.date}=${p.value}`).join(' ')}`,
          `预测：${fc.summary.message}（未来 7 天预计均值 ${forecastAvg.toFixed(1)} 条/天）`,
        ].join('\n'),
      )
    }

    case 'get_cross_events': {
      const days = num(args.days, 30, 7, 365)
      const minSources = num(args.minSources, 2, 1, 10)
      const limit = num(args.limit, 10, 1, 50)
      const events = crossSource(db, days).topEvents.filter((e) => e.sourceCount >= minSources).slice(0, limit)
      if (events.length === 0) return text(`（近 ${days} 天内没有 ≥${minSources} 源的事件）`)
      return text(
        events
          .map(
            (e) =>
              `- [${e.date}] ${e.title}\n  ${e.sourceCount} 源 / ${e.articleCount} 条 · ${label(e.category)}\n  来源：${e.sources.join('、')}`,
          )
          .join('\n'),
      )
    }

    case 'get_bursts': {
      const days = num(args.days, 30, 7, 365)
      const bursts = crossSource(db, days).bursts
      if (bursts.length === 0) return text(`（近 ${days} 天没有 z ≥ 2.5 的突发）`)
      return text(
        bursts.map((b) => `- ${b.date} · ${b.category === 'all' ? '全站' : label(b.category)} · ${b.count} 条（基线 ${b.baseline}, z=${b.z}）`).join('\n'),
      )
    }

    case 'get_sentiment': {
      const days = num(args.days, 30, 7, 365)
      const byDay = dailySentiment(db, days).slice(-7)
      const alerts = sentimentAlerts(db, days).slice(0, 8)
      const entities = topEntitiesWithSentiment(db, days, 6)
      return text(
        [
          `最近 7 天情感占比（正/中/负）：`,
          ...byDay.map(
            (d) =>
              `- ${d.date}: ${(d.ratios.positive * 100).toFixed(0)}% / ${(d.ratios.neutral * 100).toFixed(0)}% / ${(d.ratios.negative * 100).toFixed(0)}%（已判定 ${d.classified}/${d.total} 条）`,
          ),
          alerts.length > 0 ? `\n负面预警：` : `\n负面预警：无`,
          ...alerts.map((a) => `- ${a.date} · ${a.entity} · 负面 ${a.negativeCount} 条（基线 ${a.baseline}, z=${a.z}）`),
          `\n实体负面占比（近 ${days} 天）：`,
          ...entities.map((e) => `- ${e.entity}: ${(e.negShare * 100).toFixed(0)}%（${e.negative}/${e.count}）`),
        ].join('\n'),
      )
    }

    case 'list_daily_summaries': {
      const limit = num(args.limit, 14, 1, 90)
      const items = listSummaries(db, limit)
      if (items.length === 0) return text('（暂无每日简报）')
      return text(items.map((s) => `- ${s.date}　${s.title}　[${s.model}]`).join('\n'))
    }

    case 'get_daily_summary': {
      const date = String(args.date ?? '')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return text('日期格式应为 YYYY-MM-DD')
      const s = getSummary(db, date)
      if (!s) return text(`（${date} 暂无简报；可运行 npm run summary -- --date=${date} 补生成）`)
      return text(
        [
          `${s.date}　${s.title}（${s.model}）`,
          s.stats ? `共 ${s.stats.total} 条 · 跨源 ${s.stats.crossSource} 条 · 环比 ${s.stats.deltaPct ?? '—'}%` : '',
          '',
          s.content,
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }

    default:
      return { content: [{ type: 'text', text: `未知工具：${name}` }], isError: true }
  }
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`)
}

async function handle(msg: { id?: unknown; method?: string; params?: Record<string, unknown> }): Promise<void> {
  const { id, method, params } = msg

  // 通知（无 id）不需要响应
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (id === undefined) return

  try {
    switch (method) {
      case 'initialize': {
        const requested = typeof params?.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18'
        send({
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: requested,
            capabilities: { tools: {} },
            serverInfo: SERVER_INFO,
          },
        })
        return
      }
      case 'ping':
        send({ jsonrpc: '2.0', id, result: {} })
        return
      case 'tools/list':
        send({ jsonrpc: '2.0', id, result: { tools: TOOLS } })
        return
      case 'tools/call': {
        const name = String(params?.name ?? '')
        const args = (params?.arguments ?? {}) as Record<string, unknown>
        send({ jsonrpc: '2.0', id, result: callTool(name, args) })
        return
      }
      default:
        send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } })
    }
  } catch (err) {
    send({ jsonrpc: '2.0', id, error: { code: -32603, message: err instanceof Error ? err.message : String(err) } })
  }
}

const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const trimmed = line.trim()
  if (!trimmed) return
  try {
    const msg = JSON.parse(trimmed) as { id?: unknown; method?: string; params?: Record<string, unknown> }
    void handle(msg)
  } catch {
    // 非法 JSON：忽略（stdio 客户端只会发合法 JSON-RPC）
  }
})
