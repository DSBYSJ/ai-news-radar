import type { FastifyInstance } from 'fastify'
import { generateDailySummary } from './ai/summary.ts'
import { config } from './config.ts'
import { runFullPipeline } from './jobs.ts'
import { getDb } from './db.ts'
import { runBenchmark, saveBenchmark } from './aihot/benchmark.ts'
import { recordObservations, settleObservations, writeSnapshot } from './market/linkageObs.ts'

const DAY_MS = 86_400_000
/** 北京时间相对 UTC 的偏移（无夏令时，恒定 +8） */
const BEIJING_OFFSET_MS = 8 * 3_600_000

/**
 * 定时调度：
 * 1. 采集轮：COLLECT_AT（默认北京时间 07:00 / 10:00 / 13:00 / 17:00 / 21:00）到点跑一轮
 *    「采集 → 加工 → 事件聚类」；COLLECT_AT 为空时退回 SCHEDULE_INTERVAL_MIN 的固定间隔模式
 * 2. 每日简报：每天 SUMMARY_AT（默认 23:00 北京时间）生成**当天**的简报
 */
export function startScheduler(app: FastifyInstance): void {
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

  const slots = parseClockTimes(config.collectAt)
  if (slots.length > 0) {
    const scheduleNext = (): void => {
      const delay = msUntilNextSlot(Date.now(), slots)
      app.log.info(
        `采集定时：下次 ${new Date(Date.now() + delay).toISOString()}（约 ${(delay / 3_600_000).toFixed(1)} 小时后），每日 ${formatSlots(slots)}（北京时间）`,
      )
      setTimeout(() => {
        void (async () => {
          await tick()
          scheduleNext()
        })()
      }, delay)
    }
    scheduleNext()
    if (config.scheduleRunOnStart) void tick()
  } else {
    const intervalMin = config.scheduleIntervalMin
    if (intervalMin <= 0) {
      app.log.info(
        `定时采集未开启（COLLECT_AT=${config.collectAt || '空'}，SCHEDULE_INTERVAL_MIN=${intervalMin}），可用 HTTP 手动触发`,
      )
    } else {
      setInterval(() => void tick(), intervalMin * 60_000)
      app.log.info(`定时采集已启动：每 ${intervalMin} 分钟一轮`)
    }
    if (config.scheduleRunOnStart) void tick()
  }

  startDailySummary(app)
  startAihotBenchmark(app)
  startLinkageSettle(app)
}

/** 解析 "07:00,10:00" → 当天分钟数数组（去重、升序、忽略非法项）；空串表示不启用 */
export function parseClockTimes(spec: string): number[] {
  const out = new Set<number>()
  for (const raw of spec.split(',')) {
    const m = raw.trim().match(/^(\d{1,2}):(\d{2})$/)
    if (!m) continue
    const hour = Number(m[1])
    const minute = Number(m[2])
    if (hour > 23 || minute > 59) continue
    out.add(hour * 60 + minute)
  }
  return [...out].sort((a, b) => a - b)
}

/** 距离「下一个时间点」的毫秒数（slots 为当天分钟数，纯函数便于测试） */
export function msUntilNextSlot(nowMs: number, slots: number[], offsetMs = BEIJING_OFFSET_MS): number {
  const localNow = nowMs + offsetMs
  const dayStart = Math.floor(localNow / DAY_MS) * DAY_MS
  const elapsed = localNow - dayStart
  for (const slot of slots) {
    const target = slot * 60_000
    if (target > elapsed) return target - elapsed
  }
  // 当天的点都过了 → 明天第一个点
  return DAY_MS - elapsed + slots[0] * 60_000
}

function formatSlots(slots: number[]): string {
  return slots.map((s) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`).join(' / ')
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

/**
 * 每日 AIHOT 外部基准对照（v0.34.0）
 *
 * 为什么值得每天跑：它是一把**固定的尺子**。单次对照只能看"今天重合多少"，
 * 看不出"改源之后有没有变好"。有了日序列，扩源/改打分的效果就能被量化
 * （v0.33.0 补官方博客后，覆盖率从 14% 提到 26% 就是这么测出来的）。
 *
 * 成本：一次请求（带 ETag，多数时候 304 不传正文），失败不影响其他定时任务。
 */
function startAihotBenchmark(app: FastifyInstance): void {
  const spec = config.aihotBenchmarkAt.trim().toLowerCase()
  if (!spec || spec === 'off' || spec === 'false') {
    app.log.info('AIHOT 对照定时未开启（AIHOT_BENCHMARK_AT=off）')
    return
  }

  const match = spec.match(/^(\d{1,2}):(\d{2})$/)
  const hour = match ? Math.min(23, Math.max(0, Number(match[1]))) : 23
  const minute = match ? Math.min(59, Math.max(0, Number(match[2]))) : 40
  if (!match) app.log.warn(`AIHOT_BENCHMARK_AT 格式应为 HH:MM（收到 ${spec}），已回退为 23:40`)

  const scheduleNext = (): void => {
    const delay = msUntilNextLocal(Date.now(), hour, minute)
    app.log.info(
      `AIHOT 对照定时：${new Date(Date.now() + delay).toISOString()}（北京时间 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}，约 ${(delay / 3_600_000).toFixed(1)} 小时后）`,
    )
    setTimeout(() => {
      void (async () => {
        const date = localDate(Date.now())
        try {
          const db = getDb()
          const r = await runBenchmark({ db, hours: 24 })
          saveBenchmark(db, r, date)
          app.log.info(
            {
              date,
              aihot: r.aihot.count,
              ours: r.ours.count,
              matched: r.overlap.matched,
              coverageOfAihot: r.overlap.coverageOfAihot,
            },
            'AIHOT 对照完成',
          )
        } catch (err) {
          // 对照失败不影响采集/简报，静默降级
          app.log.warn({ err, date }, 'AIHOT 对照失败（不影响其他定时任务）')
        }
        scheduleNext()
      })()
    }, delay)
  }

  scheduleNext()
}


/**
 * 每日联动观察结算（v0.43.0）
 *
 * 顺序：记录（幂等）→ 结算（能算的算，没成熟保持 pending）→ 写快照。
 * 幂等：重复运行不会重复插事件、也不会覆盖首次记录的事实。
 */
function startLinkageSettle(app: FastifyInstance): void {
  const spec = config.linkageSettleAt.trim().toLowerCase()
  if (!spec || spec === 'off' || spec === 'false') {
    app.log.info('联动结算定时未开启（LINKAGE_SETTLE_AT=off）')
    return
  }
  const m = spec.match(/^(\d{1,2}):(\d{2})$/)
  const hour = m ? Math.min(23, Math.max(0, Number(m[1]))) : 8
  const minute = m ? Math.min(59, Math.max(0, Number(m[2]))) : 10

  const scheduleNext = (): void => {
    const delay = msUntilNextLocal(Date.now(), hour, minute)
    app.log.info(
      `联动结算定时：${new Date(Date.now() + delay).toISOString()}（北京时间 ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}）`,
    )
    setTimeout(() => {
      void (async () => {
        const date = localDate(Date.now())
        try {
          const db = getDb()
          const rec = recordObservations(db, { asOf: date })
          const st = settleObservations(db, { asOf: date })
          const snap = writeSnapshot(db, { asOf: date })
          app.log.info(
            { date, inserted: rec.inserted, matured: st.matured, pending: st.pending, t5: snap.t5.evaluated },
            '联动结算完成',
          )
        } catch (err) {
          app.log.warn({ err, date }, '联动结算失败（不影响其他任务）')
        }
        scheduleNext()
      })()
    }, delay)
  }
  scheduleNext()
}
