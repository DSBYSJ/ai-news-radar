import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api.ts'
import AskPanel from '../components/AskPanel.tsx'
import type { CrossSourceResponse, EntityItem, Health, SentimentResponse, SummaryListItem, VelocityResponse } from '../types.ts'
import { CATEGORY_LABELS } from '../utils/format.ts'

type Nav = (tab: 'list' | 'trend' | 'summary') => void

interface Props {
  health: Health | null
  onNavigate: Nav
}

function Kpi({
  label,
  value,
  unit,
  hint,
  tone = 'default',
}: {
  label: string
  value: string
  unit?: string
  hint?: string
  tone?: 'default' | 'up' | 'down'
}) {
  const toneCls =
    tone === 'up'
      ? 'text-red-600 dark:text-red-400'
      : tone === 'down'
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-slate-900 dark:text-slate-100'
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
      <p className="text-xs text-slate-500 dark:text-slate-400">{label}</p>
      <p className="mt-1 flex items-baseline gap-1">
        <span className={`text-2xl font-semibold leading-none ${toneCls}`}>{value}</span>
        {unit && <span className="text-xs text-slate-400 dark:text-slate-500">{unit}</span>}
      </p>
      {hint && <p className="mt-1.5 text-[11px] text-slate-400 dark:text-slate-500">{hint}</p>}
    </div>
  )
}

function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
      <header className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">{title}</h3>
        {action}
      </header>
      {children}
    </section>
  )
}

/** 概览页：今天发生了什么 —— KPI + 今日简报 + 跨源事件 + 突发 + 实体热度 */
export default function OverviewPage({ health, onNavigate }: Props) {
  const [velocity, setVelocity] = useState<VelocityResponse | null>(null)
  const [cross, setCross] = useState<CrossSourceResponse | null>(null)
  const [summaries, setSummaries] = useState<SummaryListItem[]>([])
  const [entities, setEntities] = useState<EntityItem[]>([])
  const [sentiment, setSentiment] = useState<SentimentResponse | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const [vel, cr, su, en, se] = await Promise.all([
          api.velocity(7),
          api.cross(30),
          api.summaries(7),
          api.entities(7),
          api.sentiment(7),
        ])
        if (!alive) return
        setVelocity(vel)
        setCross(cr)
        setSummaries(su.items)
        setEntities(en.items)
        setSentiment(se)
      } catch {
        // 后端不可用时静默降级（顶栏已有提示）
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const today = cross?.points[cross.points.length - 1]?.date ?? ''
  const todayCount = velocity?.points[velocity.points.length - 1]?.count ?? 0
  const change = velocity?.changePct
  const todayEvents = (cross?.dayEvents?.[today] ?? []).filter((e) => e.sourceCount >= 2)
  const maxSources = todayEvents.reduce((m, e) => Math.max(m, e.sourceCount), 0)
  const recentBursts = (cross?.bursts ?? []).filter((b) => b.date >= shiftDate(today, -2))
  const topBurstZ = recentBursts.reduce((m, b) => Math.max(m, b.z), 0)
  const sentiToday = sentiment?.byDay[sentiment.byDay.length - 1]
  const negShare = sentiToday && sentiToday.classified > 0 ? sentiToday.ratios.negative : null
  const latestSummary = summaries[0]

  return (
    <div className="flex flex-col gap-4 lg:flex-row">
      <div className="min-w-0 flex-1 space-y-4">
        {/* 关键指标 */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label={`今日收录（${today || '—'}）`}
            value={String(todayCount)}
            unit="条"
            hint={change === null || change === undefined ? '暂无环比' : `周环比 ${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}%`}
            tone={change === null || change === undefined ? 'default' : change >= 0 ? 'up' : 'down'}
          />
          <Kpi
            label="今日跨源事件"
            value={String(todayEvents.length)}
            unit="个"
            hint={maxSources > 0 ? `最高被 ${maxSources} 家独立源报道` : '暂无多源印证事件'}
          />
          <Kpi
            label="近 3 天突发"
            value={String(recentBursts.length)}
            unit="条"
            hint={topBurstZ > 0 ? `最高 z=${topBurstZ}` : '无异常（正常）'}
          />
          <Kpi
            label="今日负面情感占比"
            value={negShare === null ? '—' : `${Math.round(negShare * 100)}%`}
            hint={sentiToday ? `已判定 ${sentiToday.classified} 条` : '情感判定待补齐'}
          />
        </div>

        {/* 今日简报 */}
        <Card
          title="最新每日简报"
          action={
            <button
              type="button"
              onClick={() => onNavigate('summary')}
              className="rounded-full border border-slate-300 px-3 py-1 text-xs text-slate-700 transition hover:-translate-y-0.5 hover:shadow-sm dark:border-slate-700 dark:text-slate-200"
            >
              查看全部
            </button>
          }
        >
          {latestSummary ? (
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-slate-900 px-2 py-0.5 text-[11px] text-white dark:bg-slate-700">
                  {latestSummary.date}
                </span>
                <span className="text-sm font-medium text-slate-800 dark:text-slate-100">{latestSummary.title}</span>
                {latestSummary.stats && (
                  <span className="text-[11px] text-slate-400 dark:text-slate-500">
                    共 {latestSummary.stats.total} 条 · 跨源 {latestSummary.stats.crossSource} 条
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">
                AI 每天自动生成昨日简报（历史可回看），内容包含综述、分类要点与关注方向。
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">还没有简报，去「简报」页点「生成 / 更新」。</p>
          )}
        </Card>

        <div className="grid gap-4 lg:grid-cols-2">
          {/* 今日跨源事件 */}
          <Card
            title="今日跨源事件"
            action={
              <button
                type="button"
                onClick={() => onNavigate('trend')}
                className="text-xs text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
              >
                看趋势 →
              </button>
            }
          >
            {todayEvents.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">今天还没有被 2 家以上独立源同时报道的事件。</p>
            ) : (
              <ul className="space-y-2">
                {todayEvents.slice(0, 5).map((e) => (
                  <li key={e.eventKey} className="rounded-lg border border-slate-200 p-2.5 dark:border-slate-700">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[11px] font-medium text-white ${
                          e.sourceCount >= 3 ? 'bg-red-600' : 'bg-slate-400'
                        }`}
                      >
                        {e.sourceCount} 源
                      </span>
                      <span className="truncate text-xs text-slate-700 dark:text-slate-200">{e.title}</span>
                    </div>
                    <p className="mt-1 text-[11px] text-slate-400 dark:text-slate-500">
                      {CATEGORY_LABELS[e.category] ?? e.category} · {e.sources.join('、')}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          {/* 突发提醒 */}
          <Card title="突发提醒（z ≥ 2.5）">
            {recentBursts.length === 0 ? (
              <p className="text-xs text-slate-500 dark:text-slate-400">近 3 天没有触发突发阈值，属正常。</p>
            ) : (
              <ul className="flex flex-wrap gap-2">
                {recentBursts.map((b) => {
                  const alpha = Math.min(0.3, 0.06 + Math.max(0, b.z - 2.5) * 0.02)
                  return (
                    <li
                      key={`${b.date}-${b.category}`}
                      className="rounded-full px-2.5 py-1 text-[11px] text-slate-700 dark:text-slate-200"
                      style={{ backgroundColor: `rgba(220, 38, 38, ${alpha})` }}
                    >
                      {b.date} · {b.category === 'all' ? '全站' : (CATEGORY_LABELS[b.category] ?? b.category)} ·{' '}
                      {b.count} 条 · z={b.z}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
        </div>

        {/* 实体热度 */}
        <Card
          title="实体热度（近 7 天）"
          action={
            <button
              type="button"
              onClick={() => onNavigate('list')}
              className="text-xs text-slate-400 transition hover:text-slate-700 dark:hover:text-slate-200"
            >
              去资讯列表 →
            </button>
          }
        >
          {entities.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">暂无实体数据。</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {entities.slice(0, 14).map((e) => (
                <span
                  key={e.entity}
                  className="cursor-default rounded-full bg-slate-100 px-3 py-1 text-xs text-slate-700 transition hover:bg-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:hover:bg-slate-700"
                >
                  {e.entity}
                  <span className="ml-1.5 font-medium text-slate-400 dark:text-slate-500">{e.count}</span>
                </span>
              ))}
            </div>
          )}
          {health && (
            <p className="mt-3 text-[11px] text-slate-400 dark:text-slate-500">
              数据规模：{health.sources} 个源 / {health.rawItems} 条原始 / {health.articles} 条成品 / {health.events} 个事件
            </p>
          )}
        </Card>
      </div>

      <aside className="w-full shrink-0 lg:w-[380px]">
        <div className="lg:sticky lg:top-4">
          <AskPanel />
        </div>
      </aside>
    </div>
  )
}

function shiftDate(date: string, deltaDays: number): string {
  const t = Date.parse(`${date}T00:00:00Z`)
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10)
}