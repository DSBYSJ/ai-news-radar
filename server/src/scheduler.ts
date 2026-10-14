import type { FastifyInstance } from 'fastify'
import { config } from './config.ts'
import { runFullPipeline } from './jobs.ts'

/**
 * 定时调度：从简，不做多时段编排（见 docs/项目方案.md 第二节）。
 * SCHEDULE_INTERVAL_MIN > 0 时启用，每 N 分钟跑一轮「采集 → 加工 → 事件聚类」。
 * 带防重入：上一轮没跑完就跳过本轮，避免叠加。
 */
export function startScheduler(app: FastifyInstance): void {
  const intervalMin = config.scheduleIntervalMin
  if (intervalMin <= 0) {
    app.log.info(`定时调度未开启（SCHEDULE_INTERVAL_MIN=${intervalMin}），可用 HTTP 手动触发`)
    return
  }

  let running = false

  const tick = async (): Promise<void> => {
    if (running) {
      app.log.warn('上一轮尚未结束，跳过本次调度')
      return
    }
    running = true
    try {
      app.log.info('定时调度开始')
      const summary = await runFullPipeline()
      app.log.info(
        {
          fetched: summary.collect.totalFetched,
          inserted: summary.collect.totalInserted,
          classified: summary.process.classified,
          events: summary.events.events,
        },
        '定时调度完成',
      )
    } catch (err) {
      app.log.error({ err }, '定时调度失败')
    } finally {
      running = false
    }
  }

  setInterval(() => void tick(), intervalMin * 60_000)
  if (config.scheduleRunOnStart) void tick()

  app.log.info(`定时调度已启动：每 ${intervalMin} 分钟一轮`)
}
