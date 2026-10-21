import type { DatabaseSync } from 'node:sqlite'
import { loadSeries, type SeriesData } from '../risk/macroHistory.ts'
import { classifyEntity, type EntityClass, type EntityMapping } from './entityClass.ts'
import { loadPrices } from './prices.ts'
import { symbolOfEntity } from './universe.ts'

/**
 * 新闻→股价联动：前瞻性观察系统（v0.43.0）
 *
 * 与 v0.42 的临时统计的区别：**记录当时知道什么，而不是每天重算一遍覆盖掉**。
 *
 * 三条不可动摇的规则：
 *   1. **首次入选时的事实永不覆盖** —— 实体映射规则以后会改（补别名、公司 IPO），
 *      但"当时我们是怎么认的"必须保留，否则历史统计被静默改写。
 *   2. **没成熟就是没成熟** —— T+5 要等 5 个交易日走完且价格有效；
 *      缺数据标 `pending`，绝不当成 0 收益。
 *   3. **可复现** —— 任何一天的汇总都能用 `asOf` 重算出来，
 *      快照里记下算法版本、映射版本、价格数据截止日。
 */

/** 算法版本：事件识别/结算逻辑变化时递增 */
export const ALGO_VERSION = 'linkage-1'
/** 映射规则版本：别名表或产品-母公司表变化时递增 */
export const MAPPING_VERSION = 'alias-1'

const HORIZON = 5
const MIN_SOURCES = 2
/** 样本门槛：低于此值不做结论 */
export const MIN_EVENTS = 30

function firstIndexAtOrAfter(dates: string[], date: string): number {
  let lo = 0
  let hi = dates.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (dates[mid] >= date) {
      ans = mid
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return ans
}

/** 只保留 <= asOf 的部分，保证"当时能看到" */
function sliceUntil(s: SeriesData, asOf: string): SeriesData {
  let n = s.dates.length
  while (n > 0 && s.dates[n - 1] > asOf) n -= 1
  return { dates: s.dates.slice(0, n), values: s.values.slice(0, n) }
}

interface RawEvent {
  date: string
  entity: string
  sources: number
  mentions: number
}

function rawEvents(db: DatabaseSync, asOf: string, minSources: number): RawEvent[] {
  return db
    .prepare(
      `SELECT date(a.published_at) AS date, m.entity AS entity,
              COUNT(DISTINCT r.source_id) AS sources, COUNT(*) AS mentions
         FROM mentions m
         JOIN articles a ON a.id = m.article_id
         JOIN raw_items r ON r.id = a.raw_id
        WHERE a.ai_relevant = 1 AND date(a.published_at) <= ?
        GROUP BY date(a.published_at), m.entity
       HAVING sources >= ?`,
    )
    .all(asOf, minSources) as unknown as RawEvent[]
}

/* ============================ 1. 记录 ============================ */

export interface RecordResult {
  scanned: number
  inserted: number
  existing: number
}

/**
 * 把满足条件的跨源事件写成观察记录。
 *
 * **幂等**：event_id = `事件日|实体`，重复运行不会重复插入，也不会覆盖首次记录的事实。
 * 定时任务可以随便重跑 —— 这是单机采集架构下最基本的要求。
 */
export function recordObservations(
  db: DatabaseSync,
  opts: { asOf: string; minSources?: number; now?: string },
): RecordResult {
  const minSources = opts.minSources ?? MIN_SOURCES
  const now = opts.now ?? new Date().toISOString()
  const events = rawEvents(db, opts.asOf, minSources)

  const insert = db.prepare(
    `INSERT INTO linkage_observations
       (event_id, event_date, entity_raw, entity_class, symbol, mapping_method, mapping_version,
        algo_version, first_seen_at, sources, mentions, status, status_reason, revision, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
     ON CONFLICT(event_id) DO NOTHING`,
  )

  let inserted = 0
  db.exec('BEGIN')
  try {
    for (const e of events) {
      const m: EntityMapping = classifyEntity(e.entity, symbolOfEntity)
      const status: 'unmapped' | 'pending' =
        m.symbol === null ? 'unmapped' : 'pending'
      const reason =
        m.symbol === null
          ? m.entityClass === 'private'
            ? '未上市主体，无对应股票'
            : m.entityClass === 'unknown'
              ? '别名表未覆盖，属于识别能力不足（不等于没有资产）'
              : '无可联动股票'
          : '等待行情数据'
      const r = insert.run(
        `${e.date}|${e.entity}`,
        e.date,
        e.entity,
        m.entityClass,
        m.symbol,
        m.method,
        MAPPING_VERSION,
        ALGO_VERSION,
        now,
        Number(e.sources),
        Number(e.mentions),
        status,
        reason,
        now,
      )
      if (Number(r.changes) > 0) inserted += 1
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return { scanned: events.length, inserted, existing: events.length - inserted }
}

/* ============================ 2. 结算 ============================ */

export interface SettleResult {
  checked: number
  matured: number
  pending: number
  noPrice: number
  revised: number
}

interface ObsRow {
  event_id: string
  event_date: string
  symbol: string | null
  t0_excess: number | null
  t5_excess: number | null
  status: string
  revision: number
}

/**
 * 结算：算 T0 与 T+5。
 *
 * - T0：事件日（或其后第一个交易日）相对前一交易日 → 只需 2 根 K 线
 * - T+5：事件日起第 5 个交易日 → 必须**走完**且价格有效，否则保持 pending
 * - 没价格序列 → no_price（不是 pending，因为再等也不会来）
 *
 * 结果变化时 `revision + 1`，保留原始映射与首次发现时间不变。
 */
export function settleObservations(
  db: DatabaseSync,
  opts: { asOf: string; now?: string },
): SettleResult {
  const now = opts.now ?? new Date().toISOString()
  const nasdaq = sliceUntil(loadSeries(db, 'nasdaq'), opts.asOf)
  const priceCache = new Map<string, SeriesData>()

  const rows = db
    .prepare(
      `SELECT event_id, event_date, symbol, t0_excess, t5_excess, status, revision
         FROM linkage_observations
        WHERE symbol IS NOT NULL AND status IN ('pending','no_price','matured')`,
    )
    .all() as unknown as ObsRow[]

  const update = db.prepare(
    `UPDATE linkage_observations
        SET t0_excess = ?, t5_excess = ?, status = ?, status_reason = ?,
            settled_at = ?, revision = revision + ?, updated_at = ?
      WHERE event_id = ?`,
  )

  const out: SettleResult = { checked: rows.length, matured: 0, pending: 0, noPrice: 0, revised: 0 }
  db.exec('BEGIN')
  try {
    for (const r of rows) {
      const symbol = r.symbol as string
      let prices = priceCache.get(symbol)
      if (!prices) {
        const raw = loadPrices(db, symbol)
        prices = sliceUntil({ dates: raw.map((p) => p.date), values: raw.map((p) => p.close) }, opts.asOf)
        priceCache.set(symbol, prices)
      }

      if (prices.dates.length === 0) {
        out.noPrice += 1
        if (r.status !== 'no_price') {
          update.run(null, null, 'no_price', '该标的没有可用的行情数据', now, 1, now, r.event_id)
          out.revised += 1
        }
        continue
      }

      const i = firstIndexAtOrAfter(prices.dates, r.event_date)
      const ni = firstIndexAtOrAfter(nasdaq.dates, r.event_date)

      // T0：需要前一日
      let t0: number | null = null
      if (i > 0 && ni > 0) {
        const s0 = prices.values[i - 1]
        const s1 = prices.values[i]
        const n0 = nasdaq.values[ni - 1]
        const n1 = nasdaq.values[ni]
        if (s0 > 0 && n0 > 0) t0 = s1 / s0 - n1 / n0
      }

      // T+5：必须 5 个交易日完整
      let t5: number | null = null
      if (i >= 0 && ni >= 0 && i + HORIZON < prices.dates.length && ni + HORIZON < nasdaq.dates.length) {
        const s0 = prices.values[i]
        const s1 = prices.values[i + HORIZON]
        const n0 = nasdaq.values[ni]
        const n1 = nasdaq.values[ni + HORIZON]
        if (s0 > 0 && n0 > 0) t5 = s1 / s0 - n1 / n0
      }

      const status: 'pending' | 'matured' = t5 === null ? 'pending' : 'matured'
      const reason =
        status === 'matured'
          ? null
          : t0 === null
            ? '行情尚未覆盖到事件日'
            : `还需 ${HORIZON} 个交易日走完（当前只有 ${prices.dates.length - i} 个）`

      if (status === 'matured') out.matured += 1
      else out.pending += 1

      const changed =
        r.status !== status ||
        (t0 !== null && r.t0_excess !== null && Math.abs(t0 - r.t0_excess) > 1e-9) ||
        (t5 !== null && r.t5_excess !== null && Math.abs(t5 - r.t5_excess) > 1e-9) ||
        (r.t0_excess === null && t0 !== null) ||
        (r.t5_excess === null && t5 !== null)

      if (changed) {
        out.revised += 1
        update.run(t0, t5, status, reason, now, 1, now, r.event_id)
      }
    }
    db.exec('COMMIT')
  } catch (err) {
    db.exec('ROLLBACK')
    throw err
  }
  return out
}

/* ============================ 3. 统计（可复现） ============================ */

export interface LinkageStats {
  asOf: string
  priceDataUntil: string | null
  totalEvents: number
  byClass: Record<EntityClass, number>
  byStatus: { unmapped: number; no_price: number; pending: number; matured: number }
  mapping: { direct: number; indirect: number; none: number }
  t0: { evaluated: number; avg: number | null; median: number | null; winRate: number | null }
  t5: { evaluated: number; avg: number | null; median: number | null; winRate: number | null }
  /** 结果是否集中在少数标的（避免"其实是英伟达一家的故事"） */
  concentration: { symbol: string; share: number } | null
  sufficient: boolean
  note: string
}

function stat(vals: number[]): { evaluated: number; avg: number | null; median: number | null; winRate: number | null } {
  if (vals.length === 0) return { evaluated: 0, avg: null, median: null, winRate: null }
  const s = [...vals].sort((a, b) => a - b)
  const avg = s.reduce((x, v) => x + v, 0) / s.length
  const median =
    s.length % 2 === 1 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return {
    evaluated: s.length,
    avg: Number(avg.toFixed(4)),
    median: Number(median.toFixed(4)),
    winRate: Number((s.filter((v) => v > 0).length / s.length).toFixed(3)),
  }
}

/**
 * 从观察记录重算统计。
 *
 * **不直接用库里存的 t5**，而是按 asOf 重新算一遍 ——
 * 这样"用 10 月 20 日的数据复现 10 月 20 日的汇总"才成立。
 * 库里存的 t5 只是最近一次结算的结果，用于展示。
 */
export function computeStats(db: DatabaseSync, opts: { asOf: string }): LinkageStats {
  const obs = db
    .prepare(
      `SELECT event_date, entity_class, symbol, t0_excess, t5_excess, status
         FROM linkage_observations WHERE event_date <= ?`,
    )
    .all(opts.asOf) as unknown as {
    event_date: string
    entity_class: EntityClass
    symbol: string | null
    t0_excess: number | null
    t5_excess: number | null
    status: string
  }[]

  const byClass: Record<EntityClass, number> = { listed: 0, product: 0, private: 0, unknown: 0 }
  const byStatus = { unmapped: 0, no_price: 0, pending: 0, matured: 0 }
  let direct = 0
  let indirect = 0

  const t0Vals: number[] = []
  const t5Vals: number[] = []
  const perSymbol = new Map<string, number>()

  for (const o of obs) {
    byClass[o.entity_class] = (byClass[o.entity_class] ?? 0) + 1
    if (o.status in byStatus) byStatus[o.status as keyof typeof byStatus] += 1
    if (o.entity_class === 'listed') direct += 1
    else if (o.entity_class === 'product') indirect += 1
    if (o.t0_excess !== null) t0Vals.push(o.t0_excess)
    if (o.t5_excess !== null) {
      t5Vals.push(o.t5_excess)
      if (o.symbol) perSymbol.set(o.symbol, (perSymbol.get(o.symbol) ?? 0) + 1)
    }
  }

  const total = obs.length
  const top = [...perSymbol.entries()].sort((a, b) => b[1] - a[1])[0]
  const concentration =
    top && t5Vals.length > 0 ? { symbol: top[0], share: Number((top[1] / t5Vals.length).toFixed(2)) } : null

  const t5 = stat(t5Vals)
  const sufficient = t5.evaluated >= MIN_EVENTS
  const notes: string[] = []
  if (!sufficient) {
    notes.push(`T+5 可评估 ${t5.evaluated} 个，低于门槛 ${MIN_EVENTS} —— 样本不足，暂不能判断`)
  } else {
    notes.push(`T+5 可评估 ${t5.evaluated} 个，达到门槛；但达到门槛不等于证明有效，仍需看独立性与稳定性`)
  }
  if (concentration && concentration.share >= 0.5) {
    notes.push(`结果高度集中在 ${concentration.symbol}（占 ${Math.round(concentration.share * 100)}%），可能只是单一标的的故事`)
  }

  const priceUntil = db
    .prepare('SELECT MAX(date) AS d FROM equity_daily WHERE date <= ?')
    .get(opts.asOf) as { d: string | null } | undefined

  return {
    asOf: opts.asOf,
    priceDataUntil: priceUntil?.d ?? null,
    totalEvents: total,
    byClass,
    byStatus,
    mapping: { direct, indirect, none: total - direct - indirect },
    t0: stat(t0Vals),
    t5,
    concentration,
    sufficient,
    note: notes.join('；'),
  }
}

/* ============================ 4. 每日快照 ============================ */

export interface SnapshotRow extends LinkageStats {
  date: string
  generatedAt: string
  algoVersion: string
  mappingVersion: string
  newEvents: number
}

/** 写当日快照（同一天重跑覆盖，幂等） */
export function writeSnapshot(db: DatabaseSync, opts: { asOf: string; now?: string }): SnapshotRow {
  const now = opts.now ?? new Date().toISOString()
  const s = computeStats(db, { asOf: opts.asOf })
  const newEvents = (
    db
      .prepare('SELECT COUNT(*) AS c FROM linkage_observations WHERE date(first_seen_at) = ?')
      .get(opts.asOf) as { c: number }
  ).c

  db.prepare(
    `INSERT INTO linkage_daily_snapshots
       (date, generated_at, algo_version, mapping_version, price_data_until, new_events, total_events,
        mapped_events, pending, matured, no_price, unmapped,
        t0_evaluated, t0_avg, t0_median, t0_winrate,
        t5_evaluated, t5_avg, t5_median, t5_winrate,
        rate_direct, rate_indirect, rate_none, sufficient, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date) DO UPDATE SET
       generated_at = excluded.generated_at, algo_version = excluded.algo_version,
       mapping_version = excluded.mapping_version, price_data_until = excluded.price_data_until,
       new_events = excluded.new_events, total_events = excluded.total_events,
       mapped_events = excluded.mapped_events, pending = excluded.pending, matured = excluded.matured,
       no_price = excluded.no_price, unmapped = excluded.unmapped,
       t0_evaluated = excluded.t0_evaluated, t0_avg = excluded.t0_avg,
       t0_median = excluded.t0_median, t0_winrate = excluded.t0_winrate,
       t5_evaluated = excluded.t5_evaluated, t5_avg = excluded.t5_avg,
       t5_median = excluded.t5_median, t5_winrate = excluded.t5_winrate,
       rate_direct = excluded.rate_direct, rate_indirect = excluded.rate_indirect,
       rate_none = excluded.rate_none, sufficient = excluded.sufficient, note = excluded.note`,
  ).run(
    opts.asOf,
    now,
    ALGO_VERSION,
    MAPPING_VERSION,
    s.priceDataUntil,
    newEvents,
    s.totalEvents,
    s.byClass.listed + s.byClass.product,
    s.byStatus.pending,
    s.byStatus.matured,
    s.byStatus.no_price,
    s.byStatus.unmapped,
    s.t0.evaluated,
    s.t0.avg,
    s.t0.median,
    s.t0.winRate,
    s.t5.evaluated,
    s.t5.avg,
    s.t5.median,
    s.t5.winRate,
    s.totalEvents > 0 ? Number((s.byClass.listed / s.totalEvents).toFixed(3)) : null,
    s.totalEvents > 0 ? Number((s.byClass.product / s.totalEvents).toFixed(3)) : null,
    s.totalEvents > 0
      ? Number(((s.byClass.private + s.byClass.unknown) / s.totalEvents).toFixed(3))
      : null,
    s.sufficient ? 1 : 0,
    s.note,
  )

  return { ...s, date: opts.asOf, generatedAt: now, algoVersion: ALGO_VERSION, mappingVersion: MAPPING_VERSION, newEvents }
}

/** 读历史快照（用于趋势与复现核对） */
export function listSnapshots(db: DatabaseSync, days = 30): SnapshotRow[] {
  const rows = db
    .prepare(`SELECT * FROM linkage_daily_snapshots ORDER BY date DESC LIMIT ?`)
    .all(days) as unknown as Record<string, unknown>[]
  return rows.reverse().map((r) => ({
    date: String(r.date),
    generatedAt: String(r.generated_at),
    algoVersion: String(r.algo_version),
    mappingVersion: String(r.mapping_version),
    newEvents: Number(r.new_events),
    asOf: String(r.date),
    priceDataUntil: (r.price_data_until as string) ?? null,
    totalEvents: Number(r.total_events),
    byClass: { listed: 0, product: 0, private: 0, unknown: 0 },
    byStatus: {
      unmapped: Number(r.unmapped),
      no_price: Number(r.no_price),
      pending: Number(r.pending),
      matured: Number(r.matured),
    },
    mapping: {
      direct: Math.round(Number(r.rate_direct ?? 0) * Number(r.total_events)),
      indirect: Math.round(Number(r.rate_indirect ?? 0) * Number(r.total_events)),
      none: Math.round(Number(r.rate_none ?? 0) * Number(r.total_events)),
    },
    t0: {
      evaluated: Number(r.t0_evaluated),
      avg: r.t0_avg === null ? null : Number(r.t0_avg),
      median: r.t0_median === null ? null : Number(r.t0_median),
      winRate: r.t0_winrate === null ? null : Number(r.t0_winrate),
    },
    t5: {
      evaluated: Number(r.t5_evaluated),
      avg: r.t5_avg === null ? null : Number(r.t5_avg),
      median: r.t5_median === null ? null : Number(r.t5_median),
      winRate: r.t5_winrate === null ? null : Number(r.t5_winrate),
    },
    concentration: null,
    sufficient: Number(r.sufficient) === 1,
    note: String(r.note ?? ''),
  }))
}
