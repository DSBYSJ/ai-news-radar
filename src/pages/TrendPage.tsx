import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import AskPanel from '../components/AskPanel.tsx'
import ChartCard from '../components/ChartCard.tsx'
import CrossSourceChart from '../components/CrossSourceChart.tsx'
import LineChart from '../components/LineChart.tsx'
import StackedBarChart from '../components/StackedBarChart.tsx'
import type {
  CategoryRatioPoint,
  CrossSourceResponse,
  DailyPoint,
  EntityItem,
  EntitySentimentResponse,
  ForecastResponse,
  SentimentResponse,
  VelocityResponse,
} from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, CATEGORY_ORDER, formatPct } from '../utils/format.ts'

const SENTIMENTS = ['positive', 'neutral', 'negative']
const SENTIMENT_COLORS: Record<string, string> = { positive: '#57a97c', neutral: '#9aa3ad', negative: '#cf5a5a' }
const SENTIMENT_LABELS: Record<string, string> = { positive: '正面', neutral: '中性', negative: '负面' }

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
  const [entityDetail, setEntityDetail] = useState<EntitySentimentResponse | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [v, c, vel, cr, en, fc, se] = await Promise.all([
          api.volume(days),
          api.category(days),
          api.velocity(days),
          api.cross(days),
          api.entities(days),
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
  }, [days])

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
  const volumeValues = volume.map((p) => p.value)
  const volumeMean = volumeValues.length > 0 ? volumeValues.reduce((a, b) => a + b, 0) / volumeValues.length : 0

  // 第 3 层：历史 + 未来 7 天预测（虚线从最后一条均线接续）
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

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-4">
        <div className="flex flex-wrap items-end gap-3 card p-4">
          <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
            统计窗口
            <select
              className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              <option value={14}>近 14 天</option>
              <option value={30}>近 30 天</option>
              <option value={60}>近 60 天</option>
            </select>
          </label>
          <p className="text-xs text-slate-500 dark:text-slate-400">日期按 UTC 分桶（与库内存储一致）</p>
          {(() => {
            // ⚠️ 不能用 volume 的最后一项：序列是按天补齐的，最后一天永远是"今天"（值为 0），
            // 直接显示会变成"数据截至 今天"这种假新鲜度。取最后一个真正有条目的日子。
            const last = [...volume].reverse().find((p) => p.value > 0)?.date
            if (!last) return null
            const isToday = last === new Date().toISOString().slice(0, 10)
            return (
              <p
                className={`ml-auto text-xs ${isToday ? 'text-slate-500 dark:text-slate-400' : 'text-amber-600 dark:text-amber-400'}`}
                title="统计窗口的最后一天；采集每天 5 个时间点，非当天说明最近一轮还没跑"
              >
                数据截至 {last}
              </p>
            )
          })()}
        </div>

        {error && (
          <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
        )}

        {/* 2 × 3 网格：四层趋势 + 情感 + 实体 */}
        <div className="grid gap-4 xl:grid-cols-2">
          <ChartCard level="第 1 层" title="每日收录条数" hint="假趋势，只作对照基线。">
            <LineChart
              labels={volume.map((p) => p.date)}
              series={[{ name: '每日条数', color: '#3b82f6', values: volumeValues }]}
              area
              areaColor="#3b82f6"
              reference={{ value: volumeMean, label: `均值 ${volumeMean.toFixed(1)}` }}
              dots
              height={240}
            />
          </ChartCard>

          <ChartCard level="第 2 层" title="分类占比趋势" hint="每根柱子 = 当天的构成占比，点击图例可隐藏某类。">
            <StackedBarChart points={ratios} categories={CATEGORY_ORDER} height={250} />
          </ChartCard>

          <ChartCard
            level="第 3 层"
            title="均线 · 环比 · 7 天预测"
            hint="紫色虚线为未来 7 天外推，浅色带是残差区间。"
            badge={
              change === null || change === undefined ? null : (
                <span className="flex items-baseline gap-1.5">
                  <span className="text-xs text-slate-400 dark:text-slate-500">周环比</span>
                  <span
                    className={`text-lg font-semibold leading-none ${
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
              dots
              height={220}
            />
            {forecast && (
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                <span className="mr-1 font-medium text-violet-700 dark:text-violet-300">预测</span>
                {forecast.summary.message}
              </p>
            )}
          </ChartCard>

          <ChartCard
            level="第 4 层"
            title="跨源交叉度 + 突发检测"
            hint="柱高 = 当天事件被最多几家独立源报道；越过 3 家通常意味着真的重要。"
          >
            <CrossSourceChart points={cross?.points ?? []} dayEvents={cross?.dayEvents} height={210} />
            {((cross?.topEvents.length ?? 0) > 0 || (cross?.bursts.length ?? 0) > 0) && (
              <details className="mt-3 rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-700">
                <summary className="cursor-pointer text-xs text-slate-500 dark:text-slate-400">
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

          <ChartCard level="情感" title="情感趋势（AI 判定）" hint="每天的正 / 负 / 中占比与实体负面飙升预警。">
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

          <ChartCard level="实体" title="实体热度与负面占比" hint="点击实体查看它的负面占比走势（7 日平滑）。">
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
                <p className="mt-2 text-[11px] text-slate-400 dark:text-slate-500">
                  口径：该实体当日被提及的文章中，负面文章占比（仅统计已判定条目）
                </p>
              </>
            )}
          </ChartCard>
        </div>

        {entities.length > 0 && (
          <p className="px-1 text-[11px] text-slate-400 dark:text-slate-500">
            占比口径示例：
            {ratios.length > 0 ? formatPct(ratios[ratios.length - 1].ratios.model_release ?? 0) : '0%'} 为最新一天的模型发布占比
          </p>
        )}
      </div>

      <aside className="w-full shrink-0 lg:w-[380px]">
        <div className="lg:sticky lg:top-4">
          <AskPanel />
        </div>
      </aside>
    </div>
  )
}