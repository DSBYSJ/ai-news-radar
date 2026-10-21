import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import { exportVelocityCsv, exportEntitiesCsv } from '../lib/exporters.ts'
import AskPanel from '../components/AskPanel.tsx'
import ChartCard from '../components/ChartCard.tsx'
import CrossSourceChart from '../components/CrossSourceChart.tsx'
import LineChart from '../components/LineChart.tsx'
import StackedBarChart from '../components/StackedBarChart.tsx'
import type {
  CategoryRatioPoint,
  CrossSourceResponse,
  DailyPoint,
  EntityDailySeries,
  EntityItem,
  EntitySentimentResponse,
  ForecastResponse,
  SentimentResponse,
  VelocityResponse,
} from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, CATEGORY_ORDER } from '../utils/format.ts'

/**
 * 趋势分析（v0.35.0 信息架构重做）
 *
 * 旧版问题（用户反馈"太乱、不明确什么意思"）：
 *   1. 卡片标「第 1 层 / 第 2 层 …」，编号本身不携带信息；而且卡片有 5 张、"四层递进"却说 4 层
 *   2. 「每日收录条数」和「均线·环比·预测」画的是**同一条数据**，却占了两张卡
 *   3. 分类图里图例（8 个，可点显隐）和「联动筛选」（8 个按钮，跨图过滤）两套控件长得一样、行为不同
 *   4. 右上角问答助手占了整栏近一半高度，把数据挤到下面
 *
 * 新版结构：先给结论（速览条），再给三层递进的问题 ——
 *   「有多少」（总量+趋势）→「是什么」（构成）→「有什么异常」（跨源/突发/情绪）
 */

const SENTIMENTS = ['positive', 'neutral', 'negative']
const SENTIMENT_COLORS: Record<string, string> = { positive: '#57a97c', neutral: '#9aa3ad', negative: '#cf5a5a' }
const SENTIMENT_LABELS: Record<string, string> = { positive: '正面', neutral: '中性', negative: '负面' }

/** 速览条里的一个数字 */
function Metric({
  label,
  value,
  sub,
  tone = 'text-slate-900 dark:text-slate-100',
}: {
  label: string
  value: string
  sub?: string
  tone?: string
}) {
  return (
    <div className="min-w-[132px] flex-1 rounded-lg bg-slate-50/80 px-3 py-2 dark:bg-white/[0.03]">
      <p className="truncate text-[10.5px] text-slate-400 dark:text-slate-500">{label}</p>
      <p className={`num mt-0.5 text-[17px] font-semibold leading-tight ${tone}`}>{value}</p>
      {sub && <p className="mt-0.5 truncate text-[10px] text-slate-400 dark:text-slate-500">{sub}</p>}
    </div>
  )
}

export default function TrendPage() {
  const [days, setDays] = useState(30)
  const [volume, setVolume] = useState<DailyPoint[]>([])
  const [ratios, setRatios] = useState<CategoryRatioPoint[]>([])
  const [velocity, setVelocity] = useState<VelocityResponse | null>(null)
  const [cross, setCross] = useState<CrossSourceResponse | null>(null)
  const [entities, setEntities] = useState<EntityItem[]>([])
  const [forecast, setForecast] = useState<ForecastResponse | null>(null)
  const [sentiment, setSentiment] = useState<SentimentResponse | null>(null)
  const [selectedEntity, setSelectedEntity] = useState('')
  // 分类联动筛选（只影响均线预测与实体热度，不影响分类图本身的显隐）
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null)
  const [compareEntities, setCompareEntities] = useState<string[]>([])
  const [compareSeries, setCompareSeries] = useState<EntityDailySeries | null>(null)
  const [entityDetail, setEntityDetail] = useState<EntitySentimentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  const exportTrendCsv = (): void => {
    if (velocity) exportVelocityCsv(velocity)
    if (entities.length > 0) exportEntitiesCsv(entities, 30)
  }

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [v, c, vel, cr, en, fc, se] = await Promise.all([
          api.volume(days),
          api.category(days),
          api.velocity(days, categoryFilter ?? undefined),
          api.cross(days),
          api.entities(days, 40, categoryFilter ?? undefined),
          api.forecast(days, 7),
          api.sentiment(days),
        ])
        if (!alive) return
        setVolume(v.points)
        setRatios(c.points)
        setVelocity(vel)
        setCross(cr)
        setEntities(en.items)
        setForecast(fc)
        setSentiment(se)
        setSelectedEntity((cur) => cur || se.entities[0]?.entity || '')
        setError(null)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [days, categoryFilter])

  useEffect(() => {
    if (compareEntities.length < 2) {
      setCompareSeries(null)
      return
    }
    let alive = true
    void api.entitySeries(compareEntities, days).then((r) => {
      if (alive) setCompareSeries(r)
    })
    return () => {
      alive = false
    }
  }, [compareEntities, days])

  useEffect(() => {
    if (!selectedEntity) {
      setEntityDetail(null)
      return
    }
    let alive = true
    api
      .entitySentiment(selectedEntity, days)
      .then((d) => {
        if (alive) setEntityDetail(d)
      })
      .catch(() => {
        if (alive) setEntityDetail(null)
      })
    return () => {
      alive = false
    }
  }, [selectedEntity, days])

  const change = velocity?.changePct
  // 参考线必须与图上灰线同源（velocity.count），否则会画出一条对不上的"均值"
  const velocityCounts = velocity?.points.map((p) => p.count) ?? []
  const volumeMean =
    velocityCounts.length > 0 ? velocityCounts.reduce((a, b) => a + b, 0) / velocityCounts.length : 0

  // 未来 7 天预测（虚线从最后一条均线接续）
  const histLen = velocity?.points.length ?? 0
  const forecastLabels = forecast?.forecast.map((f) => f.date) ?? []
  const pad = Array(forecastLabels.length).fill(null) as null[]
  const lastMa7 = histLen > 0 ? (velocity?.points[histLen - 1]?.ma7 ?? null) : null
  const forecastBridge = Array(Math.max(0, histLen - 1)).fill(null) as null[]

  // 实体区块数据源：优先带情感口径的列表，缺失时退回纯热度
  const entityChips = useMemo(() => {
    const fromSentiment = sentiment?.entities ?? []
    if (fromSentiment.length > 0) return fromSentiment
    return entities.map((e) => ({ entity: e.entity, count: e.count, negative: 0, negShare: 0 }))
  }, [sentiment, entities])

  /** 窗口内最热的类目（按条数加权，而不是按天的占比平均 —— 后者会让小样本日权重过高） */
  const topCategory = useMemo(() => {
    const counts = new Map<string, number>()
    let total = 0
    for (const p of ratios) {
      for (const c of CATEGORY_ORDER) {
        const n = (p.ratios[c] ?? 0) * p.total
        if (n > 0) {
          counts.set(c, (counts.get(c) ?? 0) + n)
          total += n
        }
      }
    }
    let best: { c: string; n: number } | null = null
    for (const [c, n] of counts) if (!best || n > best.n) best = { c, n }
    return best && total > 0 ? { label: CATEGORY_LABELS[best.c] ?? best.c, share: best.n / total } : null
  }, [ratios])

  const crossStrong = cross?.topEvents.filter((e) => e.sourceCount >= 3).length ?? 0
  const alertCount = sentiment?.alerts.length ?? 0
  const lastDataDay = [...volume].reverse().find((p) => p.value > 0)?.date

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-4">
        <header className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
              <span className="inline-block h-4 w-[3px] rounded-full bg-gradient-to-b from-violet-500 to-indigo-500" />
              趋势分析
            </h2>
            <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
              三个问题依次回答：<b className="font-medium text-slate-600 dark:text-slate-300">有多少</b> →{' '}
              <b className="font-medium text-slate-600 dark:text-slate-300">是什么</b> →{' '}
              <b className="font-medium text-slate-600 dark:text-slate-300">有什么异常</b>
            </p>
          </div>
          <button
            type="button"
            onClick={exportTrendCsv}
            className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-[11.5px] text-slate-600 transition hover:border-slate-400 dark:text-slate-300"
            title="导出每日条数/均线与实体热度为 CSV（Excel 可直接打开）"
          >
            导出 CSV
          </button>
        </header>

        {/* 控制条 */}
        <div className="card flex flex-wrap items-center gap-x-3 gap-y-2 p-3">
          <label className="flex items-center gap-2 text-[11px] text-slate-500 dark:text-slate-400">
            统计窗口
            <select
              className="h-7 rounded-lg border border-slate-200 bg-white px-2 text-[12px] text-slate-700 outline-none transition hover:border-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={14}>近 14 天</option>
              <option value={30}>近 30 天</option>
              <option value={60}>近 60 天</option>
            </select>
          </label>
          <span className="text-[10.5px] text-slate-400 dark:text-slate-500">按 UTC 分桶（与库内一致）</span>
          {lastDataDay && (
            <span
              className={`chip num ml-auto !text-[11px] ${
                lastDataDay === new Date().toISOString().slice(0, 10)
                  ? ''
                  : '!border-amber-300/60 !text-amber-700 dark:!border-amber-500/30 dark:!text-amber-400'
              }`}
              title="窗口内最后一个真正有条目的日期；采集每天 5 个时间点，非当天说明最近一轮还没跑"
            >
              <span
                className={`inline-block h-1.5 w-1.5 rounded-full ${
                  lastDataDay === new Date().toISOString().slice(0, 10) ? 'bg-emerald-500' : 'bg-amber-500'
                }`}
              />
              数据截至 {lastDataDay}
            </span>
          )}
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
        )}

        {/* 速览：先给结论，再给图 */}
        <section className="card p-3">
          <div className="flex flex-wrap items-stretch gap-2">
            <Metric
              label="近 7 天日均"
              value={velocity ? `${velocity.thisWeekAvg.toFixed(1)} 条` : '—'}
              sub={
                change === null || change === undefined
                  ? velocity?.comparable === false
                    ? '两期数据不足，无法算环比'
                    : undefined
                  : `周环比 ${change >= 0 ? '+' : ''}${change}%`
              }
              tone={
                change === null || change === undefined
                  ? undefined
                  : change >= 0
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-emerald-600 dark:text-emerald-400'
              }
            />
            <Metric
              label="最热类目"
              value={topCategory?.label ?? '—'}
              sub={topCategory ? `占 ${Math.round(topCategory.share * 100)}%` : undefined}
            />
            <Metric
              label="跨源确认"
              value={`${crossStrong} 个事件`}
              sub={`被 ≥3 家独立源报道（窗口内共 ${cross?.topEvents.length ?? 0} 个跨源事件）`}
            />
            <Metric
              label="负面预警"
              value={alertCount > 0 ? `${alertCount} 条` : '无'}
              sub={alertCount > 0 ? '实体负面数 ≥3 且 z ≥2' : '窗口内未触发'}
              tone={alertCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-500 dark:text-slate-400'}
            />
          </div>
        </section>

        {/* 三层递进 */}
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {/* 有多少：把「每日条数」与「均线/预测」合并 —— 它们画的是同一条数据 */}
          <ChartCard
            level="有多少"
            tone="trend"
            title="收录量与 7 日趋势"
            hint="灰线是每日条数，红线是 7 日均线（抹掉单日噪声），紫色虚线是未来 7 天外推。"
            badge={
              change === null || change === undefined ? null : (
                <span className="flex items-baseline gap-1.5">
                  <span className="text-[10.5px] text-slate-400 dark:text-slate-500">周环比</span>
                  <span
                    className={`text-[15px] font-semibold leading-none ${
                      change >= 0 ? 'text-red-600 dark:text-red-400' : 'text-emerald-600 dark:text-emerald-400'
                    }`}
                  >
                    {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
                  </span>
                </span>
              )
            }
          >
            <LineChart
              labels={[...(velocity?.points.map((p) => p.date) ?? []), ...forecastLabels]}
              series={[
                {
                  name: '每日条数',
                  color: '#94a3b8',
                  values: [...(velocity?.points.map((p) => p.count) ?? []), ...pad],
                  width: 1.5,
                },
                {
                  name: '7 日均线',
                  color: '#dc2626',
                  values: [...(velocity?.points.map((p) => p.ma7) ?? []), ...pad],
                  width: 2.5,
                },
                {
                  name: '7 天预测',
                  color: '#7c3aed',
                  dashed: true,
                  values: [...forecastBridge, lastMa7, ...(forecast?.forecast.map((f) => f.value) ?? [])],
                  width: 2,
                },
              ]}
              bands={
                forecast
                  ? [
                      {
                        color: '#7c3aed',
                        lo: [...forecastBridge, lastMa7, ...forecast.forecast.map((f) => f.lo)],
                        hi: [...forecastBridge, lastMa7, ...forecast.forecast.map((f) => f.hi)],
                      },
                    ]
                  : undefined
              }
              reference={{ value: volumeMean, label: `窗口均值 ${volumeMean.toFixed(1)}` }}
              dots
              height={240}
            />
            {forecast && (
              <p className="mt-2 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
                <span className="mr-1 font-medium text-violet-700 dark:text-violet-300">预测</span>
                {forecast.summary.message}
              </p>
            )}
          </ChartCard>

          {/* 是什么 */}
          <ChartCard
            level="是什么"
            tone="mix"
            title="每天都是哪些类目"
            hint="每根柱子是一天的构成占比（不是绝对条数）；点图例可隐藏某个类目，右键式联动见下方下拉。"
          >
            <div className="mb-2.5 flex flex-wrap items-center gap-2">
              <span className="text-[10.5px] text-slate-400 dark:text-slate-500">联动其他图表</span>
              <select
                className="h-7 rounded-lg border border-slate-200 bg-white px-2 text-[11.5px] text-slate-600 outline-none transition hover:border-slate-300 focus:border-violet-400 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-300"
                value={categoryFilter ?? ''}
                onChange={(e) => setCategoryFilter(e.target.value || null)}
                title="只影响右侧的均线预测与实体热度，不影响本图的图例显隐"
              >
                <option value="">全部分类</option>
                {CATEGORY_ORDER.map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c] ?? c}
                  </option>
                ))}
              </select>
              {categoryFilter && (
                <button
                  type="button"
                  onClick={() => setCategoryFilter(null)}
                  className="rounded-full border border-[var(--line)] px-2 py-0.5 text-[10.5px] text-slate-500 transition hover:border-slate-400 dark:text-slate-400"
                >
                  ✕ 清除
                </button>
              )}
              {categoryFilter && (
                <span className="num text-[10.5px] text-[var(--accent)]">
                  均线预测与实体热度已只统计「{CATEGORY_LABELS[categoryFilter] ?? categoryFilter}」
                </span>
              )}
            </div>
            <StackedBarChart points={ratios} categories={CATEGORY_ORDER} height={250} />
          </ChartCard>

          {/* 有什么异常 · 一 */}
          <ChartCard
            level="异常"
            tone="alert"
            title="跨源确认与突发"
            hint="柱高 = 当天某个事件被最多几家独立源报道。越过 3 家，通常意味着这件事真的发生了、而且重要。"
          >
            <CrossSourceChart points={cross?.points ?? []} dayEvents={cross?.dayEvents} height={210} />
            {((cross?.topEvents.length ?? 0) > 0 || (cross?.bursts.length ?? 0) > 0) && (
              <details className="mt-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                <summary className="cursor-pointer text-[11.5px] text-slate-500 dark:text-slate-400">
                  展开跨源事件（{cross?.topEvents.length ?? 0}）与突发检测（{cross?.bursts.length ?? 0}）
                </summary>

                {cross && cross.topEvents.length > 0 && (
                  <ul className="mt-2 space-y-1.5">
                    {cross.topEvents.slice(0, 8).map((e) => (
                      <li key={e.eventKey} className="flex items-center gap-1.5 text-xs">
                        <span
                          className={`shrink-0 rounded-full px-1.5 py-0.5 text-[11px] font-medium text-white ${
                            e.sourceCount >= 3 ? 'bg-red-600' : 'bg-slate-400'
                          }`}
                        >
                          {e.sourceCount} 源
                        </span>
                        <span
                          className="shrink-0 rounded-full px-1.5 py-0.5 text-[11px] text-white"
                          style={{ backgroundColor: CATEGORY_COLORS[e.category] ?? '#9ca3af' }}
                        >
                          {CATEGORY_LABELS[e.category] ?? e.category}
                        </span>
                        <span className="truncate text-slate-700 dark:text-slate-200">{e.title}</span>
                        <span className="ml-auto shrink-0 text-[11px] text-slate-400">{e.date}</span>
                      </li>
                    ))}
                  </ul>
                )}

                {cross && cross.bursts.length > 0 && (
                  <div className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
                    <ul className="flex flex-wrap gap-1.5">
                      {cross.bursts.map((b) => {
                        const alpha = Math.min(0.3, 0.06 + Math.max(0, b.z - 2.5) * 0.02)
                        return (
                          <li
                            key={`${b.date}-${b.category}`}
                            className="rounded-full px-2.5 py-0.5 text-[11px] text-slate-700 dark:text-slate-200"
                            style={{ backgroundColor: `rgba(220, 38, 38, ${alpha})` }}
                          >
                            {b.date} · {b.category === 'all' ? '全站' : (CATEGORY_LABELS[b.category] ?? b.category)} ·{' '}
                            {b.count} 条 · z={b.z}
                          </li>
                        )
                      })}
                    </ul>
                  </div>
                )}
              </details>
            )}
          </ChartCard>

          {/* 有什么异常 · 二 */}
          <ChartCard
            level="情绪"
            tone="mood"
            title="正负面构成与预警"
            hint="每天已判定情感条目的正/中/负占比；下方是实体级的负面飙升预警。"
          >
            {sentiment ? (
              <>
                <StackedBarChart
                  points={sentiment.byDay.map((d) => ({ date: d.date, total: d.classified, ratios: d.ratios }))}
                  categories={SENTIMENTS}
                  colors={SENTIMENT_COLORS}
                  labelMap={SENTIMENT_LABELS}
                  height={230}
                />
                {sentiment.alerts.length > 0 ? (
                  <div className="mt-3 border-t border-slate-100 pt-2 dark:border-slate-800">
                    <p className="mb-1.5 text-[11px] font-medium text-slate-600 dark:text-slate-300">负面情感预警</p>
                    <ul className="flex flex-wrap gap-1.5">
                      {sentiment.alerts.slice(0, 8).map((a) => (
                        <li
                          key={`${a.date}-${a.entity}`}
                          className="rounded-full px-2.5 py-0.5 text-[11px] text-slate-700 dark:text-slate-200"
                          style={{ backgroundColor: `rgba(207, 90, 90, ${Math.min(0.3, 0.08 + Math.max(0, a.z - 2) * 0.03)})` }}
                        >
                          {a.date} · {a.entity} · 负面 {a.negativeCount} 条 · z={a.z}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <p className="mt-3 border-t border-slate-100 pt-2 text-[11px] text-slate-400 dark:border-slate-800 dark:text-slate-500">
                    近 {days} 天没有触发负面预警（实体负面数 ≥3 且 z ≥ 2）。
                  </p>
                )}
              </>
            ) : (
              <p className="py-8 text-center text-xs text-slate-400">暂无情感数据</p>
            )}
          </ChartCard>
        </div>
      </div>

      {/* 右栏：先放有内容的（实体），再放需要操作的（对比），问答放最后 */}
      <aside className="w-full shrink-0 lg:w-[360px]">
        <div className="space-y-4 lg:sticky lg:top-4">
          <ChartCard level="实体" tone="entity" title="谁被讨论得最多" hint="点击实体查看它的负面占比走势（7 日平滑）。">
            {entityChips.length === 0 ? (
              <p className="py-8 text-center text-xs text-slate-400">暂无实体数据</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {entityChips.map((e) => (
                    <button
                      key={e.entity}
                      type="button"
                      onClick={() => setSelectedEntity(e.entity)}
                      className={`rounded-full px-2.5 py-1 text-xs transition ${
                        selectedEntity === e.entity
                          ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                          : 'bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700'
                      }`}
                    >
                      {e.entity}
                      <span className="ml-1.5 opacity-60">{e.count}</span>
                      {e.negShare > 0 && (
                        <span className="ml-1 text-[10px] opacity-70">{Math.round(e.negShare * 100)}%负</span>
                      )}
                    </button>
                  ))}
                </div>
                {entityDetail && (
                  <div className="mt-3">
                    <LineChart
                      labels={entityDetail.points.map((p) => p.date)}
                      series={[
                        { name: '负面占比', color: '#cf5a5a', values: entityDetail.points.map((p) => p.negRatio), width: 1.5 },
                        { name: '7 日均值', color: '#7c3aed', values: entityDetail.points.map((p) => p.ma7), width: 2.5 },
                      ]}
                      yMax={1}
                      tickFormat={(v) => `${Math.round(v * 100)}%`}
                      valueFormat={(v) => `${Math.round(v * 100)}%`}
                      dots
                      height={190}
                    />
                  </div>
                )}
                <p className="mt-2 text-[10.5px] text-slate-400 dark:text-slate-500">
                  口径：该实体当日被提及的文章中，负面文章占比（仅统计已判定条目）
                </p>
              </>
            )}
          </ChartCard>

          <ChartCard level="对比" tone="base" title="两个实体谁更热" hint="选 2–3 个实体，叠加看每日提及量。">
            <div className="mb-3 flex flex-wrap items-center gap-1.5">
              {entities.slice(0, 12).map((e) => {
                const active = compareEntities.indexOf(e.entity) >= 0
                return (
                  <button
                    key={e.entity}
                    type="button"
                    onClick={() => {
                      setCompareEntities((cur) => {
                        if (cur.includes(e.entity)) return cur.filter((x) => x !== e.entity)
                        if (cur.length >= 3) return cur
                        return [...cur, e.entity]
                      })
                    }}
                    className={`rounded-full px-2 py-0.5 text-[10.5px] transition ${
                      active
                        ? 'bg-[var(--accent)] text-white'
                        : 'border border-[var(--line)] text-slate-500 hover:border-slate-400 dark:text-slate-400'
                    }`}
                    title={active ? '点击移除' : compareEntities.length >= 3 ? '最多选 3 个' : '点击加入对比'}
                  >
                    {e.entity}
                    <span className="num ml-1 opacity-70">{e.count}</span>
                  </button>
                )
              })}
              {compareEntities.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setCompareEntities([])
                    setCompareSeries(null)
                  }}
                  className="ml-1 rounded-full border border-[var(--line)] px-2 py-0.5 text-[10.5px] text-slate-500 transition hover:border-slate-400 dark:text-slate-400"
                >
                  ✕ 清空
                </button>
              )}
            </div>

            {compareEntities.length < 2 ? (
              <p className="py-6 text-center text-[12px] text-slate-400 dark:text-slate-500">
                至少选 2 个实体才能对比（当前 {compareEntities.length} 个）
              </p>
            ) : (
              <>
                <LineChart
                  labels={compareSeries?.dates ?? []}
                  series={(compareSeries?.series ?? []).map((s2, i) => ({
                    name: s2.name,
                    color: ['#176b75', '#b3402a', '#b8873a'][i % 3],
                    values: s2.values,
                  }))}
                  height={200}
                />
                <p className="num mt-2 text-[10.5px] text-slate-400 dark:text-slate-500">
                  合计：
                  {(compareSeries?.series ?? []).map((s2) => `${s2.name} ${s2.values.reduce((a, b) => a + b, 0)}`).join(' · ')}
                </p>
              </>
            )}
          </ChartCard>

          <AskPanel />
        </div>
      </aside>
    </div>
  )
}
