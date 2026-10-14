import { useEffect, useState } from 'react'
import { api } from '../api.ts'
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

  // 第 3 层：历史（每日 + 7 日均线）与未来 7 天预测拼接（虚线从最后一条均线接续）
  const histLen = velocity?.points.length ?? 0
  const forecastLabels = forecast?.forecast.map((f) => f.date) ?? []
  const pad = Array(forecastLabels.length).fill(null) as null[]
  const lastMa7 = histLen > 0 ? (velocity?.points[histLen - 1]?.ma7 ?? null) : null
  const forecastBridge = Array(Math.max(0, histLen - 1)).fill(null) as null[]

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
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
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}

      <ChartCard
        level="第 1 层"
        title="每日收录条数"
        hint="这是『假趋势』——源一变多数字自然就涨，只作为对照基线，别拿它下结论。"
      >
        <LineChart
          labels={volume.map((p) => p.date)}
          series={[{ name: '每日条数', color: '#3b82f6', values: volumeValues }]}
          area
          areaColor="#3b82f6"
          reference={{ value: volumeMean, label: `均值 ${volumeMean.toFixed(1)}` }}
          dots
          height={210}
        />
      </ChartCard>

      <ChartCard
        level="第 2 层"
        title="分类占比趋势"
        hint="每根柱子 = 当天收录内容的构成占比（数据稀疏的日子不再塌陷成三角）；悬浮看当日具体占比，点击图例可隐藏某类。"
      >
        <StackedBarChart points={ratios} categories={CATEGORY_ORDER} />
      </ChartCard>

      <ChartCard
        level="第 3 层"
        title="7 日均线 · 周环比 · 7 天预测"
        hint="平滑看方向，预测看势头：紫色虚线为未来 7 天外推（Holt 阻尼趋势），浅色带是残差区间——越远越不确定，仅作参考。"
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
          height={230}
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
        hint="同一事件被几家独立源报道 —— 这是聚合才有的视角，比主观打分更客观；越过 3 家通常意味着真的重要。鼠标悬浮柱子可查看当日事件与来源列表。"
      >
        <CrossSourceChart points={cross?.points ?? []} dayEvents={cross?.dayEvents} />

        {cross && cross.topEvents.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">跨源事件（按报道源数排序）</h4>
            <div className="grid gap-2 sm:grid-cols-2">
              {cross.topEvents.slice(0, 8).map((e) => (
                <div
                  key={e.eventKey}
                  className="rounded-xl border border-slate-200 bg-slate-50/70 p-3 transition hover:border-slate-300 hover:bg-slate-50 dark:border-slate-800 dark:bg-slate-800/40 dark:hover:border-slate-700"
                >
                  <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                    <span
                      className={`rounded-full px-2 py-0.5 text-[11px] font-medium text-white ${
                        e.sourceCount >= 3 ? 'bg-red-600' : 'bg-slate-400'
                      }`}
                    >
                      {e.sourceCount} 源
                    </span>
                    <span
                      className="rounded-full px-2 py-0.5 text-[11px] text-white"
                      style={{ backgroundColor: CATEGORY_COLORS[e.category] ?? '#9ca3af' }}
                    >
                      {CATEGORY_LABELS[e.category] ?? e.category}
                    </span>
                    <span className="ml-auto text-[11px] text-slate-400 dark:text-slate-500">{e.date}</span>
                  </div>
                  <div className="text-xs leading-snug text-slate-700 dark:text-slate-200">{e.title}</div>
                  <div className="mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
                    {e.articleCount} 条 · {e.sources.join('、') || '（来源未知）'}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {cross && cross.bursts.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
              突发检测（14 天滑动基线，Z ≥ 2.5，按 Z-score 降序）
            </h4>
            <ul className="flex flex-wrap gap-2">
              {cross.bursts.map((b) => {
                const alpha = Math.min(0.3, 0.06 + Math.max(0, b.z - 2.5) * 0.02)
                return (
                  <li
                    key={`${b.date}-${b.category}`}
                    className="rounded-full px-3 py-1 text-xs text-slate-700 dark:text-slate-200"
                    style={{ backgroundColor: `rgba(220, 38, 38, ${alpha})` }}
                    title={`${b.date} · ${b.category} · Z=${b.z}`}
                  >
                    <span className="font-medium">{b.date}</span>
                    <span className="mx-1.5 opacity-40">·</span>
                    {b.category === 'all' ? '全站' : (CATEGORY_LABELS[b.category] ?? b.category)}
                    <span className="mx-1.5 opacity-40">·</span>
                    {b.count} 条
                    <span className="ml-1 opacity-70">
                      (基线 {b.baseline}, z={b.z})
                    </span>
                  </li>
                )
              })}
            </ul>
            <p className="mt-1.5 text-xs text-slate-400 dark:text-slate-500">背景深浅随 Z-score 增大而加深（越深越异常）</p>
          </div>
        )}
      </ChartCard>

      {sentiment && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
          <header className="mb-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-medium text-white">情感</span>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">情感趋势（AI 判定）</h3>
            </div>
            <p className="mt-1 w-full text-xs leading-relaxed text-slate-500 dark:text-slate-400">
              每天的正 / 负 / 中占比 + 实体负面飙升预警 + 单实体负面占比曲线（新条目随流水线自动补齐判定）。
            </p>
          </header>

          <StackedBarChart
            points={sentiment.byDay.map((d) => ({ date: d.date, total: d.classified, ratios: d.ratios }))}
            categories={SENTIMENTS}
            colors={SENTIMENT_COLORS}
            labelMap={SENTIMENT_LABELS}
            height={220}
          />

          {sentiment.alerts.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                负面情感预警（实体负面数 ≥ 3 且 z ≥ 2）
              </h4>
              <ul className="flex flex-wrap gap-2">
                {sentiment.alerts.map((a) => (
                  <li
                    key={`${a.date}-${a.entity}`}
                    className="rounded-full px-3 py-1 text-xs text-slate-700 dark:text-slate-200"
                    style={{ backgroundColor: `rgba(207, 90, 90, ${Math.min(0.3, 0.08 + Math.max(0, a.z - 2) * 0.03)})` }}
                  >
                    <span className="font-medium">{a.date}</span>
                    <span className="mx-1.5 opacity-40">·</span>
                    {a.entity}
                    <span className="mx-1.5 opacity-40">·</span>
                    负面 {a.negativeCount} 条
                    <span className="ml-1 opacity-70">
                      (基线 {a.baseline}, z={a.z})
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {sentiment.entities.length > 0 && (
            <div className="mt-4">
              <h4 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">
                实体负面占比（点击切换实体）
              </h4>
              <div className="mb-3 flex flex-wrap gap-1.5">
                {sentiment.entities.map((e) => (
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
                    <span className="ml-1.5 opacity-60">{Math.round(e.negShare * 100)}%</span>
                  </button>
                ))}
              </div>
              {entityDetail && (
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
                  height={200}
                />
              )}
              <p className="mt-2 text-xs text-slate-400 dark:text-slate-500">
                口径：该实体当日被提及的文章中，负面文章占比（仅统计已判定条目；7 日均值做平滑）
              </p>
            </div>
          )}
        </section>
      )}

      {entities.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
          <h3 className="mb-3 text-base font-semibold text-slate-900 dark:text-slate-100">实体热度</h3>
          <div className="flex flex-wrap gap-2">
            {entities.map((e) => (
              <span
                key={e.entity}
                className="cursor-default rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
              >
                {e.entity}
                <span className="ml-1.5 font-medium text-slate-400 dark:text-slate-500">{e.count}</span>
              </span>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400 dark:text-slate-500">
            占比口径示例：{ratios.length > 0 ? formatPct(ratios[ratios.length - 1].ratios.model_release ?? 0) : '0%'}{' '}
            为最新一天的模型发布占比
          </p>
        </section>
      )}
    </div>
  )
}
