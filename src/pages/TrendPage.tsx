import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import ChartCard from '../components/ChartCard.tsx'
import CrossSourceChart from '../components/CrossSourceChart.tsx'
import LineChart from '../components/LineChart.tsx'
import StackedAreaChart from '../components/StackedAreaChart.tsx'
import type { CrossSourceResponse, DailyPoint, CategoryRatioPoint, EntityItem, VelocityResponse } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, CATEGORY_ORDER, formatPct } from '../utils/format.ts'

export default function TrendPage() {
  const [days, setDays] = useState(30)
  const [volume, setVolume] = useState<DailyPoint[]>([])
  const [ratios, setRatios] = useState<CategoryRatioPoint[]>([])
  const [velocity, setVelocity] = useState<VelocityResponse | null>(null)
  const [cross, setCross] = useState<CrossSourceResponse | null>(null)
  const [entities, setEntities] = useState<EntityItem[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    const load = async () => {
      try {
        const [v, c, vel, cr, en] = await Promise.all([
          api.volume(days),
          api.category(days),
          api.velocity(days),
          api.cross(days),
          api.entities(days),
        ])
        if (!alive) return
        setVolume(v.points)
        setRatios(c.points)
        setVelocity(vel)
        setCross(cr)
        setEntities(en.items)
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

  const change = velocity?.changePct

  return (
    <div className="space-y-4">
      <div className="flex items-end gap-3 rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
        <label className="flex flex-col gap-1 text-xs text-slate-500">
          统计窗口
          <select
            className="rounded border border-slate-300 px-2 py-1 text-sm"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={14}>近 14 天</option>
            <option value={30}>近 30 天</option>
            <option value={60}>近 60 天</option>
          </select>
        </label>
        <p className="text-xs text-slate-500">日期按 UTC 分桶（与库内存储一致）</p>
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-600">{error}</p>}

      <ChartCard
        level="第 1 层"
        title="每日收录条数"
        hint="⚠️ 这是「假趋势」——源一变多数字自然就涨，只作为对照基线，别拿它下结论。"
      >
        <LineChart
          labels={volume.map((p) => p.date)}
          series={[{ name: '每日条数', color: '#2563eb', values: volume.map((p) => p.value) }]}
          height={200}
        />
      </ChartCard>

      <ChartCard
        level="第 2 层"
        title="分类占比趋势"
        hint="Y 轴是占比而非条数，排除了源数量变化的影响 —— 看到的是真实的结构迁移（如论文在涨、融资在跌）。"
      >
        <StackedAreaChart points={ratios} categories={CATEGORY_ORDER} />
      </ChartCard>

      <ChartCard
        level="第 3 层"
        title="7 日均线与周环比"
        hint="平滑之后看的是方向：在涨还是在跌，而不是当前有多热。"
        badge={
          change === null || change === undefined ? null : (
            <span
              className={`rounded px-2 py-0.5 text-xs font-medium ${
                change >= 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600'
              }`}
            >
              环比 {change >= 0 ? '↑' : '↓'} {Math.abs(change)}%
            </span>
          )
        }
      >
        <LineChart
          labels={velocity?.points.map((p) => p.date) ?? []}
          series={[
            { name: '每日条数', color: '#cbd5e1', values: velocity?.points.map((p) => p.count) ?? [] },
            { name: '7 日均线', color: '#dc2626', values: velocity?.points.map((p) => p.ma7) ?? [] },
          ]}
          height={210}
        />
      </ChartCard>

      <ChartCard
        level="第 4 层"
        title="跨源交叉度 + 突发检测"
        hint="同一事件被几家独立源报道 —— 这是聚合才有的视角，比主观打分更客观；越过 3 家通常意味着真的重要。鼠标悬浮柱子可查看当日事件与来源列表。"
      >
        <CrossSourceChart points={cross?.points ?? []} dayEvents={cross?.dayEvents} />

        {cross && cross.topEvents.length > 0 && (
          <div className="mt-3">
            <h4 className="mb-1.5 text-xs font-medium text-slate-700">跨源事件（按报道源数排序）</h4>
            <ul className="space-y-1">
              {cross.topEvents.slice(0, 8).map((e) => (
                <li key={e.eventKey} className="flex items-center gap-2 text-xs text-slate-600">
                  <span
                    className={`rounded px-1.5 py-0.5 font-medium text-white ${
                      e.sourceCount >= 3 ? 'bg-red-600' : 'bg-slate-400'
                    }`}
                  >
                    {e.sourceCount} 源 / {e.articleCount} 条
                  </span>
                  <span
                    className="rounded px-1.5 py-0.5 text-white"
                    style={{ backgroundColor: CATEGORY_COLORS[e.category] ?? '#9ca3af' }}
                  >
                    {CATEGORY_LABELS[e.category] ?? e.category}
                  </span>
                  <span className="truncate">{e.title}</span>
                  <span className="ml-auto shrink-0 text-slate-400">{e.date}</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {cross && cross.bursts.length > 0 && (
          <div className="mt-3">
            <h4 className="mb-1.5 text-xs font-medium text-slate-700">
              突发检测（14 天滑动基线，Z ≥ 2.5，按 Z-score 降序）
            </h4>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200 text-left text-slate-500">
                    <th className="py-1.5 pr-3 font-medium">日期</th>
                    <th className="py-1.5 pr-3 font-medium">分类</th>
                    <th className="py-1.5 pr-3 font-medium">文章数</th>
                    <th className="py-1.5 pr-3 font-medium">基线（前 14 天均值）</th>
                    <th className="py-1.5 font-medium">Z-score</th>
                  </tr>
                </thead>
                <tbody>
                  {cross.bursts.map((b) => (
                    <tr key={`${b.date}-${b.category}`} className="border-b border-slate-100 last:border-0">
                      <td className="py-1.5 pr-3 text-slate-600">{b.date}</td>
                      <td className="py-1.5 pr-3 text-slate-700">
                        {b.category === 'all' ? '全站' : (CATEGORY_LABELS[b.category] ?? b.category)}
                      </td>
                      <td className="py-1.5 pr-3 font-medium text-slate-800">{b.count}</td>
                      <td className="py-1.5 pr-3 text-slate-500">{b.baseline}</td>
                      <td className="py-1.5">
                        <span
                          className={`inline-block min-w-11 rounded px-1.5 py-0.5 text-center font-medium text-white ${
                            b.z >= 3 ? 'bg-red-600' : 'bg-orange-400'
                          }`}
                        >
                          {b.z.toFixed(2)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="mt-1.5 text-xs text-slate-400">红色徽章 = Z ≥ 3（强异常）；橙色 = 2.5 ≤ Z &lt; 3</p>
          </div>
        )}
      </ChartCard>

      {entities.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="mb-2 text-sm font-semibold text-slate-900">实体热度</h3>
          <div className="flex flex-wrap gap-2">
            {entities.map((e) => (
              <span key={e.entity} className="rounded bg-slate-100 px-2 py-1 text-xs text-slate-700">
                {e.entity}
                <span className="ml-1 text-slate-400">{e.count}</span>
              </span>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            占比口径示例：{ratios.length > 0 ? formatPct(ratios[ratios.length - 1].ratios.model_release ?? 0) : '0%'} 为最新一天的模型发布占比
          </p>
        </section>
      )}
    </div>
  )
}
