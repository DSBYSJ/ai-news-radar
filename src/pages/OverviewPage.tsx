import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api.ts'
import AskPanel from '../components/AskPanel.tsx'
import type { CrossSourceResponse, EntityItem, Health, SentimentResponse, SummaryListItem, VelocityResponse } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS } from '../utils/format.ts'

type Nav = (tab: 'list' | 'trend' | 'summary') => void

interface Props {
  health: Health | null
  onNavigate: Nav
}

/**
 * 迷你走势线（sparkline）：KPI 卡里的一小段历史曲线。
 * 专业仪表盘的标志性细节 —— 让"72 条"这个孤零零的数字带上方向感。
 * 纯 SVG，无依赖；面积用渐变，末尾一个实心点标出"现在"。
 */
function Sparkline({ values, color = '#7c3aed', width = 96, height = 30 }: { values: number[]; color?: string; width?: number; height?: number }) {
  const pts = values.filter((v) => Number.isFinite(v))
  if (pts.length < 2) return null
  const max = Math.max(...pts)
  const min = Math.min(...pts)
  const span = max - min || 1
  const stepX = width / (pts.length - 1)
  const yOf = (v: number) => height - 2 - ((v - min) / span) * (height - 4)
  const line = pts.map((v, i) => `${i === 0 ? 'M' : 'L'}${(i * stepX).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ')
  const area = `${line} L${width},${height} L0,${height} Z`
  const gid = `sk${color.replace('#', '')}`
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="overflow-visible" aria-hidden="true">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.26" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} stroke="none" />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={width} cy={yOf(pts[pts.length - 1])} r="2.2" fill={color} />
    </svg>
  )
}

/**
 * KPI 卡：一眼要读出「这是什么 · 多少 · 比之前怎么样」。
 * - 顶部渐隐高光线 + 悬停光标柔光（.card-accent / .card-glow）
 * - 数字用大号等宽字体，单位降级到小字
 * - 变化用箭头胶囊表达方向，颜色语义：升温=红（资讯变多通常意味着有事发生），降温=绿
 */
function Kpi({
  label,
  value,
  unit,
  hint,
  tone = 'default',
  delta,
  icon,
  trend,
  delay = 0,
}: {
  label: string
  value: string
  unit?: string
  hint?: string
  tone?: 'default' | 'up' | 'down'
  /** 变化描述（如 "周环比 ↑ 12.4%"），有则渲染成方向胶囊 */
  delta?: string
  icon?: ReactNode
  /** 迷你走势数据（右下方） */
  trend?: number[]
  delay?: number
}) {
  // 大数字一律中性墨色：颜色语义只放在下面的变化量胶囊里。
  // 之前大数字随涨跌染色，一屏出现红/绿/黑三种，像告警面板而不是仪表盘。
  const valueTone = 'text-slate-900 dark:text-slate-50'

  const deltaCls =
    tone === 'up'
      ? 'bg-red-50 text-red-600 ring-red-100 dark:bg-red-500/10 dark:text-red-400 dark:ring-red-500/20'
      : tone === 'down'
        ? 'bg-emerald-50 text-emerald-700 ring-emerald-100 dark:bg-emerald-500/10 dark:text-emerald-400 dark:ring-emerald-500/20'
        : 'bg-slate-100 text-slate-500 ring-slate-200/70 dark:bg-white/[0.06] dark:text-slate-400 dark:ring-white/10'

  return (
    <div
      className="card card-accent card-glow card-hover reveal relative overflow-hidden p-4"
      style={{ animationDelay: `${delay}ms` }}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="eyebrow">{label}</p>
        {icon && <span className="shrink-0 text-slate-200 dark:text-slate-700">{icon}</span>}
      </div>

      <div className="mt-2 flex items-end justify-between gap-2">
        <p className="flex items-baseline gap-1.5">
          <span className={`kpi-value num text-[30px] ${valueTone}`}>{value}</span>
          {unit && <span className="text-[11px] font-medium text-slate-400 dark:text-slate-500">{unit}</span>}
        </p>
        {trend && trend.length > 1 && (
          <span className="mb-0.5 shrink-0 opacity-80 transition-opacity group-hover:opacity-100">
            <Sparkline values={trend} color={tone === 'up' ? '#dc2626' : tone === 'down' ? '#059669' : '#7c3aed'} />
          </span>
        )}
      </div>

      {delta && (
        <p className={`mt-2 inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ${deltaCls}`}>
          {delta}
        </p>
      )}
      {hint && (
        <p className={`text-[11px] leading-snug text-slate-400 dark:text-slate-500 ${delta ? 'mt-1.5' : 'mt-2'}`}>
          {hint}
        </p>
      )}
    </div>
  )
}

/** 线性小图标（16px）：只做视觉锚点，不抢数字的注意力 */
const iconCls = 'h-4 w-4'

function IconStack() {
  return (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7l9-4 9 4-9 4-9-4z" />
      <path d="M3 12l9 4 9-4" />
      <path d="M3 17l9 4 9-4" />
    </svg>
  )
}

function IconCross() {
  return (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z" />
    </svg>
  )
}

function IconBolt() {
  return (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 2L5 13h6l-1 9 8-11h-6l1-9z" />
    </svg>
  )
}

function IconPulse() {
  return (
    <svg viewBox="0 0 24 24" className={iconCls} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 12h4l2.5-6 4 12 2.5-6h5" />
    </svg>
  )
}

/** 区块卡：标题左侧一道渐隐强调条，与 KPI 卡形成层级差 */
function Card({ title, action, children }: { title: string; action?: ReactNode; children: ReactNode }) {
  return (
    <section className="card p-5">
      <header className="mb-3.5 flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-[15px] font-semibold tracking-[-0.01em] text-slate-900 dark:text-slate-100">
          <span className="inline-block h-3.5 w-[3px] rounded-full bg-gradient-to-b from-violet-500 to-indigo-500" />
          {title}
        </h3>
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
        // 一次请求拿齐六份数据：移动端（尤其安卓 WebView）省掉 5 个 RTT
        const res = await api.overview()
        if (!alive) return
        setVelocity(res.velocity)
        setCross(res.cross)
        setSummaries(res.summaries.items)
        setEntities(res.entities.items)
        setSentiment(res.sentiment)
      } catch {
        // 后端不可用时静默降级（顶栏已有提示）
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // 「今天」= 库内最新有数据的一天，而不是服务器当天：
  // 采集每天只有五个时间点（07/10/13/17/21），服务器当天常常还没入库，
  // 按当天算会让「今日收录 / 跨源事件 / 突发 / 负面占比」四张 KPI 全为 0。
  const today = health?.latestDate || cross?.points[cross.points.length - 1]?.date || ''
  const todayCount = velocity?.points.find((p) => p.date === today)?.count ?? 0
  const change = velocity?.changePct
  const todayEvents = (cross?.dayEvents?.[today] ?? []).filter((e) => e.sourceCount >= 2)
  const maxSources = todayEvents.reduce((m, e) => Math.max(m, e.sourceCount), 0)
  const recentBursts = (cross?.bursts ?? []).filter((b) => b.date >= shiftDate(today, -2))
  const topBurstZ = recentBursts.reduce((m, b) => Math.max(m, b.z), 0)
  // 与「最新收录」同口径：取数据所在那天的情感占比，而不是数组最后一项（服务器当天）
  const sentiToday =
    sentiment?.byDay.find((d) => d.date === today) ?? sentiment?.byDay[sentiment.byDay.length - 1]
  const negShare = sentiToday && sentiToday.classified > 0 ? sentiToday.ratios.negative : null
  const latestSummary = summaries[0]

  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <div className="min-w-0 space-y-4 lg:col-span-2">
        {/* 关键指标 */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Kpi
            label={`最新收录 · ${today ? today.slice(5) : '—'}`}
            value={String(todayCount)}
            unit="条"
            icon={<IconStack />}
            trend={velocity?.points.map((p) => p.count)}
            delay={0}
            delta={
              change === null || change === undefined
                ? undefined
                : `周环比 ${change >= 0 ? '↑' : '↓'} ${Math.abs(change)}%`
            }
            tone={change === null || change === undefined ? 'default' : change >= 0 ? 'up' : 'down'}
            hint={
              change === null || change === undefined
                ? (velocity?.note ?? '数据不足，暂无环比')
                : '对比上一周同期'
            }
          />
          <Kpi
            label="跨源事件"
            value={String(todayEvents.length)}
            unit="个"
            icon={<IconCross />}
            delay={60}
            hint={maxSources > 0 ? `最高被 ${maxSources} 家独立源报道` : '暂无多源印证事件'}
          />
          <Kpi
            label="近 3 天突发"
            value={String(recentBursts.length)}
            unit="条"
            icon={<IconBolt />}
            trend={cross?.points.slice(-7).map((p) => p.eventCount)}
            delay={120}
            tone={recentBursts.length > 0 ? 'up' : 'default'}
            delta={topBurstZ > 0 ? `最高 z = ${topBurstZ}` : undefined}
            hint={recentBursts.length === 0 ? '无异常，属正常' : '偏离 14 天基线 z ≥ 2.5'}
          />
          <Kpi
            label="负面情感"
            value={negShare === null ? '—' : `${Math.round(negShare * 100)}%`}
            icon={<IconPulse />}
            delay={180}
            tone={negShare !== null && negShare >= 0.35 ? 'up' : 'default'}
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
                AI 每天 23:00（北京时间）自动生成当天简报，含综述、分类要点与关注方向；历史可回看。
              </p>
            </div>
          ) : (
            <p className="text-xs text-slate-500 dark:text-slate-400">还没有简报，去「简报」页点「生成 / 更新」。</p>
          )}
        </Card>

        {/* 今日跨源事件：整张卡 + 分隔线列表（不再每条套一张卡，视觉上更安静） */}
        <Card
          title="最新跨源事件"
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
            <p className="text-xs text-slate-500 dark:text-slate-400">这天还没有被 2 家以上独立源同时报道的事件。</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {todayEvents.slice(0, 6).map((e) => (
                <li key={e.eventKey} className="py-2.5 first:pt-0 last:pb-0">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                    <span
                      className={`num shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-semibold ${
                        e.sourceCount >= 3
                          ? 'bg-red-600 text-white'
                          : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'
                      }`}
                    >
                      {e.sourceCount} 源
                    </span>
                    <span
                      className="shrink-0 text-[10.5px] font-medium"
                      style={{ color: CATEGORY_COLORS[e.category] ?? '#94a3b8' }}
                    >
                      {CATEGORY_LABELS[e.category] ?? e.category}
                    </span>
                    <span className="num ml-auto shrink-0 text-[10.5px] text-slate-400 dark:text-slate-500">
                      {e.date.slice(5)}
                    </span>
                  </div>
                  <p className="mt-1 break-words text-[13px] leading-snug text-slate-800 dark:text-slate-100">
                    {e.title}
                  </p>
                  <p className="mt-1 break-words text-[10.5px] text-slate-400 dark:text-slate-500">
                    {e.sources.join('、') || '（来源未知）'}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </Card>

        {/* 实体热度 */}
      </div>

      <aside className="space-y-4">
        {/* 只有助手粘性跟随：整列都 sticky 会让长内容互相顶住 */}
        <div className="lg:sticky lg:top-4">
          <AskPanel />
        </div>

        {/* 突发提醒 */}
        <Card title="突发提醒（z ≥ 2.5）">
          {recentBursts.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">近 3 天没有触发突发阈值，属正常。</p>
          ) : (
            <ul className="divide-y divide-slate-100 dark:divide-white/[0.06]">
              {recentBursts.slice(0, 8).map((b) => {
                // 红只表达"强度"，不再整行铺底色 —— 之前 11 行红块把页面拉低成告警面板
                const hot = Math.min(1, Math.max(0.25, (b.z - 2.5) / 6))
                return (
                  <li
                    key={`${b.date}-${b.category}`}
                    className="flex items-center gap-2.5 py-2 text-[11.5px] leading-snug text-slate-600 transition-colors hover:bg-slate-50/70 dark:text-slate-300 dark:hover:bg-white/[0.03]"
                  >
                    {/* 严重度色条 */}
                    <span aria-hidden="true" className="h-6 w-[2.5px] shrink-0 rounded-full bg-red-500" style={{ opacity: hot }} />
                    <span className="num shrink-0 text-slate-400 dark:text-slate-500">{b.date.slice(5)}</span>
                    <span className="min-w-0 flex-1 truncate font-medium text-slate-800 dark:text-slate-100">
                      {b.category === 'all' ? '全站' : (CATEGORY_LABELS[b.category] ?? b.category)}
                    </span>
                    <span className="num shrink-0 text-slate-400 dark:text-slate-500">{b.count} 条</span>
                    <span className="num shrink-0 rounded bg-slate-100 px-1.5 py-0.5 font-semibold text-slate-600 tabular-nums dark:bg-white/[0.06] dark:text-slate-300">
                      z {b.z}
                    </span>
                  </li>
                )
              })}
            </ul>
          )}
        </Card>

        <Card
          title="实体热度（近 7 天）"
          action={
            <button
              type="button"
              onClick={() => onNavigate('list')}
              className="text-[11px] text-slate-400 transition hover:text-violet-700 dark:hover:text-violet-300"
            >
              资讯列表 →
            </button>
          }
        >
          {entities.length === 0 ? (
            <p className="text-xs text-slate-500 dark:text-slate-400">暂无实体数据。</p>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {entities.slice(0, 12).map((e) => (
                <span key={e.entity} className="chip max-w-full break-words !py-0.5 !text-[10.5px]">
                  {e.entity}
                  <span className="num ml-0.5 font-semibold text-slate-500 dark:text-slate-400">{e.count}</span>
                </span>
              ))}
            </div>
          )}
          {health && (
            <div className="mt-3 border-t border-slate-100 pt-2.5 text-[10.5px] leading-relaxed text-slate-400 dark:border-white/[0.06] dark:text-slate-500">
              <p>
                数据规模 {health.sources} 源 · {health.rawItems.toLocaleString('en-US')} 原始 ·{' '}
                {(health.aiArticles ?? health.articles).toLocaleString('en-US')} 条 AI 成品 ·{' '}
                {health.events.toLocaleString('en-US')} 个事件
              </p>
              {health.collectAt && (
                <p className="mt-0.5">
                  定时 采集 {health.collectAt.split(',').join(' / ')} · 简报 {health.summaryAt || '23:00'}
                </p>
              )}
            </div>
          )}
        </Card>
      </aside>
    </div>
  )
}

function shiftDate(date: string, deltaDays: number): string {
  const t = Date.parse(`${date}T00:00:00Z`)
  return new Date(t + deltaDays * 86_400_000).toISOString().slice(0, 10)
}