import { rebuildBursts } from './analytics/bursts.ts'
import { rebuildEvents } from './analytics/events.ts'
import { runProcessing } from './ai/pipeline.ts'
import { generateDailySummary, yesterdayUtc } from './ai/summary.ts'
import { runCollect } from './collector/index.ts'

export interface PipelineSummary {
  ranAt: string
  collect: Awaited<ReturnType<typeof runCollect>>
  process: Awaited<ReturnType<typeof runProcessing>>
  events: Awaited<ReturnType<typeof rebuildEvents>>
  bursts: Awaited<ReturnType<typeof rebuildBursts>>
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
  // 昨日的简报：首次运行生成，之后自动跳过（统计版会在 AI 可用时自动升级）
  const summary = await generateDailySummary({ date: yesterdayUtc() })

  return { ranAt: new Date().toISOString(), collect, process, events, bursts, summary }
}
