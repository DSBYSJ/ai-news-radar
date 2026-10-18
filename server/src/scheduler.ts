import type { FastifyInstance } from 'fastify'
import { generateDailySummary } from './ai/summary.ts'
import { config } from './config.ts'
import { runFullPipeline } from './jobs.ts'

const DAY_MS = 86_400_000
/** 北京时间相对 UTC 的偏移（无夏令时，恒定 +8） */
const BEIJING_OFFSET_MS = 8 * 3_600_000

/**
 * 定时调度：
 * 1. 采集轮：SCHEDULE_INTERVAL_MIN > 0 时每 N 分钟跑一轮「采集 → 加工 → 事件聚类」（带防重入）
 * 2. 每日简报：每天 SUMMARY_AT（默认 23:00 北京时间）生成**当天**的简报
 */
export function startScheduler(app: FastifyInstance): void {
  const intervalMin = config.scheduleIntervalMin
  if (intervalMin <= 0) {
    app.log.info(`定时调度未开启（SCHEDULE_INTERVAL_MIN=${intervalMin}），可用 HTTP 手动触发`)
  } else {
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

  startDailySummary(app)
}

/** 距离「下一个本地 hh:mm」的毫秒数（纯函数，便于测试） */
export function msUntilNextLocal(nowMs: number, hour: number, minute: number, offsetMs = BEIJING_OFFSET_MS): number {
  const localNow = nowMs + offsetMs
  const dayStart = Math.floor(localNow / DAY_MS) * DAY_MS
  let target = dayStart + hour * 3_600_000 + minute * 60_000
  if (target <= localNow) target += DAY_MS
  return target - localNow
}

/** 指定时区下的当天日期（YYYY-MM-DD） */
export function localDate(nowMs: number, offsetMs = BEIJING_OFFSET_MS): string {
  return new Date(nowMs + offsetMs).toISOString().slice(0, 10)
}

/**
 * 每日简报：默认每天 23:00（北京时间）生成**当天**的简报。
 * · 23:00 时北京日期与 UTC 日期一致（15:00 UTC），所以写入的 date 与趋势图分桶天然对齐
 * · SUMMARY_AT 可改成 "22:30" 这类时刻；设为 off/false 关闭
 */
function startDailySummary(app: FastifyInstance): void {
  const spec = config.summaryAt.trim().toLowerCase()
  if (!spec || spec === 'off' || spec === 'false') {
    app.log.info('每日简报定时未开启（SUMMARY_AT=off）')
    return
  }

  const match = spec.match(/^(\d{1,2}):(\d{2})$/)
  const hour = match ? Math.min(23, Math.max(0, Number(match[1]))) : 23
  const minute = match ? Math.min(59, Math.max(0, Number(match[2]))) : 0
  if (!match) app.log.warn(`SUMMARY_AT 格式应为 HH:MM（收到 ${spec}），已回退为 23:00`)

  const scheduleNext = (): void => {
    const delay = msUntilNextLocal(Date.now(), hour, minute)
    const at = new Date(Date.now() + delay)
    app.log.info(
      `每日简报定时：${at.toISOString()}（北京时间 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}，约 ${(delay / 3_600_000).toFixed(1)} 小时后）生成当天简报`,
    )

    setTimeout(() => {
      void (async () => {
        const date = localDate(Date.now())
        try {
          // 先补一轮采集 + 加工，保证 23:00 的简报含当天最近几小时的内容
          // （采集轮每 6 小时一次，不先跑一轮的话简报可能停在下午的数据）
          try {
            const pipeline = await runFullPipeline()
            app.log.info({ inserted: pipeline.collect.totalInserted, classified: pipeline.process.classified }, '简报前采集完成')
          } catch (err) {
            app.log.warn({ err }, '简报前采集失败，按现有数据生成')
          }

          const result = await generateDailySummary({ date, force: true })
          app.log.info({ date, ok: result.ok, model: result.model }, '每日简报已生成')
        } catch (err) {
          app.log.error({ err, date }, '每日简报生成失败')
        }
        scheduleNext()
      })()
    }, delay)
  }

  scheduleNext()
}