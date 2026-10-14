import { rebuildBursts } from './analytics/bursts.ts'
import { rebuildEvents } from './analytics/events.ts'
import { runProcessing } from './ai/pipeline.ts'
import { runSentiment } from './ai/sentiment.ts'
import { generateDailySummary, yesterdayUtc } from './ai/summary.ts'
import { runCollect } from './collector/index.ts'
import { broadcast } from './push.ts'

export interface PipelineSummary {
  ranAt: string
  collect: Awaited<ReturnType<typeof runCollect>>
  process: Awaited<ReturnType<typeof runProcessing>>
  events: Awaited<ReturnType<typeof rebuildEvents>>
  bursts: Awaited<ReturnType<typeof rebuildBursts>>
  sentiment: Awaited<ReturnType<typeof runSentiment>>
  summary: Awaited<ReturnType<typeof generateDailySummary>>
}

/** 一轮完整流水线：采集 → AI 加工 → 事件聚类 → 昨日简报（幂等） */
export async function runFullPipeline(opts: { sinceDays?: number; limit?: number } = {}): Promise<PipelineSummary> {
  const collect = await runCollect()
  const process = await runProcessing({
    sinceDays: opts.sinceDays ?? 30,
    limit: opts.limit ?? 500,
  })
  const events = await rebuildEvents({ days: 90 })
  const bursts = await rebuildBursts({ days: 90 })

  // 实时推送：本次新增的突发立即广播给已连接的前端（无需刷新）
  if (bursts.newBursts.length > 0) {
    broadcast({ type: 'burst', at: new Date().toISOString(), items: bursts.newBursts })
  }

  const sentiment = await runSentiment({ days: 30 })
  // 昨日的简报：首次运行生成，之后自动跳过（统计版会在 AI 可用时自动升级）
  const summary = await generateDailySummary({ date: yesterdayUtc() })

  return { ranAt: new Date().toISOString(), collect, process, events, bursts, sentiment, summary }
}
