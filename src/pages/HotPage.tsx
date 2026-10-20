import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { HotItem } from '../types.ts'

/** 动量标记：新出现 / 发酵中 / 持平 / 回落 */
function Momentum({ item, size = 'md' }: { item: HotItem; size?: 'md' | 'sm' }) {
  const cls = size === 'sm' ? 'text-[10px] px-1.5 py-0.5' : 'text-[10px] px-2 py-0.5'
  if (item.isNew) {
    return <span className={`${cls} rounded-full bg-[var(--hot-soft)] font-medium text-[var(--hot)]`}>新</span>
  }
  if (item.deltaPct === null) return null
  if (item.deltaPct >= 15) {
    return (
      <span className={`${cls} rounded-full bg-[var(--hot-soft)] font-medium text-[var(--hot)]`}>
        发酵中 ↑{item.deltaPct}%
      </span>
    )
  }
  if (item.deltaPct <= -15) {
    return (
      <span className={`${cls} rounded-full bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400`}>
        ↓{Math.abs(item.deltaPct)}%
      </span>
    )
  }
  return (
    <span className={`${cls} rounded-full bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400`}>持平</span>
  )
}

/** 24 小时迷你走势（纯 SVG，不引图表库） */
function Sparkline({ hourly, className = '' }: { hourly: number[]; className?: string }) {
  const w = 96
  const h = 26
  const max = Math.max(1, ...hourly)
  const step = hourly.length > 1 ? w / (hourly.length - 1) : w
  const pts = hourly
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * (h - 3) - 1.5).toFixed(1)}`)
    .join(' ')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className={className} aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke="var(--hot)"
        strokeWidth="1.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        opacity="0.85"
      />
    </svg>
  )
}

function HotScore({ value, big = false }: { value: number; big?: boolean }) {
  return (
    <div className="text-right">
      <p className={`num font-semibold leading-none text-[var(--hot)] ${big ? 'text-[26px]' : 'text-lg'}`}>{value}</p>
      {big && <p className="mt-1 text-[10px] text-slate-400 dark:text-slate-500">热度指数</p>}
    </div>
  )
}

function SourceLine({ item }: { item: HotItem }) {
  return (
    <span className="num text-[11px] text-slate-400 dark:text-slate-500">
      {item.sources} 个来源 · {item.articles} 篇报道
    </span>
  )
}

/** 大卡（NO.01 用完整版，右侧 NO.02/03 用 compact） */
function HotCard({ item, compact = false, fill = false }: { item: HotItem; compact?: boolean; fill?: boolean }) {
  const summary = item.topArticle?.summary || item.topArticle?.tldr || ''
  return (
    <article className={`card card-accent relative flex flex-col overflow-hidden ${compact ? 'p-3.5' : 'p-4'} ${fill ? 'h-full' : ''}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="num text-[11px] font-bold tracking-tight text-[var(--hot)]">
            NO.{String(item.rank).padStart(2, '0')}
          </span>
          <Momentum item={item} size="sm" />
        </div>
        {!compact && <HotScore value={item.hot} big />}
      </div>

      <div className={compact ? '' : 'mt-1 flex flex-1 gap-4'}>
        <div className="min-w-0 flex-1">
          <h3
            className={`font-semibold leading-snug text-slate-900 dark:text-white ${compact ? 'mt-1.5 text-[13.5px]' : 'text-[19px]'}`}
          >
            <a href={item.topArticle?.url ?? '#'} target="_blank" rel="noopener noreferrer" className="hover:underline">
              {item.title}
            </a>
          </h3>

          {summary && (
            <p
              className={`mt-1.5 leading-relaxed text-slate-600 dark:text-slate-300 ${compact ? 'line-clamp-2 text-[11px]' : 'line-clamp-4 text-[13px]'}`}
            >
              {summary}
            </p>
          )}

          <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
            <SourceLine item={item} />
            {item.topArticle && (
              <a
                href={item.topArticle.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] font-medium text-[var(--accent)] hover:underline"
              >
                原文 ↗
              </a>
            )}
          </div>
        </div>

        {/* 大卡右侧：相关报道（对应 AIHOT 大卡里的 linked items 面板） */}
        {!compact && item.related.length > 0 && (
          <aside className="hidden w-[46%] shrink-0 rounded-lg border border-[var(--line)] bg-[var(--surface-2)] p-2.5 lg:block">
            <p className="eyebrow mb-1.5 text-[10px] text-slate-400 dark:text-slate-500">相关报道</p>
            <ul className="space-y-1.5">
              {item.related.map((r) => (
                <li key={r.id} className="text-[11px] leading-snug">
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="line-clamp-2 text-slate-600 hover:text-[var(--accent)] hover:underline dark:text-slate-300"
                  >
                    {r.title}
                  </a>
                  <span className="num mt-0.5 block text-[10px] text-slate-400 dark:text-slate-500">{r.sourceName}</span>
                </li>
              ))}
            </ul>
          </aside>
        )}
      </div>

      {compact ? (
        <div className="mt-2 flex items-end justify-between gap-2">
          <Sparkline hourly={item.hourly} className="h-6 w-16 opacity-80" />
          <HotScore value={item.hot} />
        </div>
      ) : (
        <div className="mt-2 flex items-end justify-end">
          <Sparkline hourly={item.hourly} className="h-8 w-40 opacity-90" />
        </div>
      )}
    </article>
  )
}

/**
 * AI 热点榜：近 48 小时讨论最多的事件。
 * 版式对齐 AIHOT /hot：NO.01 大卡（含相关报道）+ 右侧 NO.02/03 + 04–10 紧凑行 + 24h 走势。
 */
export default function HotPage() {
  const [items, setItems] = useState<HotItem[]>([])
  const [updatedAt, setUpdatedAt] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .hot(10, 48)
      .then((res) => {
        if (!alive) return
        setItems(res.items)
        setUpdatedAt(res.updatedAt)
        setError(null)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const first = items[0]
  const side = items.slice(1, 3)
  const rest = items.slice(3)

  return (
    <div className="space-y-4">
      {/* 头部 */}
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-wide text-[var(--hot)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--hot)]" />
            实时热度
          </p>
          <h2 className="mt-1 text-xl font-semibold tracking-tight text-slate-900 dark:text-slate-100">AI 热点榜</h2>
          <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">过去 48 小时，AI 圈讨论最多的 10 件事</p>
        </div>
        <p className="num text-[11px] text-slate-400 dark:text-slate-500">
          {updatedAt
            ? `${new Date(updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新`
            : '—'}
          {' · '}按讨论热度排序
        </p>
      </header>

      {loading && (
        <div className="space-y-3">
          <div className="card h-44 animate-pulse" />
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="card h-28 animate-pulse" />
            <div className="card h-28 animate-pulse" />
          </div>
        </div>
      )}

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}

      {!loading && !error && items.length === 0 && (
        <p className="card p-6 text-center text-xs text-slate-500 dark:text-slate-400">
          最近 48 小时还没有形成事件 —— 采集是每天 5 个时间点，等下一轮或点「采集 / 加工」。
        </p>
      )}

      {/* NO.01 头条：整宽（内容偏短时，三栏布局会在左侧留下大片空白） */}
      {first && <HotCard item={first} />}

      {/* NO.02 / NO.03 并排 */}
      {side.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2">
          {side.map((item) => (
            <HotCard key={item.eventKeys[0] ?? item.title} item={item} compact fill />
          ))}
        </div>
      )}

      {/* 04–10 */}
      {rest.length > 0 && (
        <>
          <div className="flex items-end justify-between gap-3 border-b border-[var(--line)] pb-1.5">
            <h3 className="text-xs font-semibold text-slate-700 dark:text-slate-200">继续看 No.04–10</h3>
            <span className="num hidden text-[10px] text-slate-400 dark:text-slate-500 sm:block">
              来源数 · 24 小时走势 · 热度指数
            </span>
          </div>
          <ol className="divide-y divide-[var(--line)]">
            {rest.map((item) => (
              <li key={item.eventKeys[0] ?? item.title} className="flex items-start gap-3 py-2.5">
                <span className="num mt-0.5 w-6 shrink-0 text-[11px] font-semibold text-slate-400 dark:text-slate-500">
                  {String(item.rank).padStart(2, '0')}
                </span>
                <div className="min-w-0 flex-1">
                  <a
                    href={item.topArticle?.url ?? '#'}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-[13px] font-medium leading-snug text-slate-800 hover:text-[var(--accent)] hover:underline dark:text-slate-100"
                  >
                    {item.title}
                  </a>
                  {(item.topArticle?.summary || item.topArticle?.tldr) && (
                    <p className="mt-0.5 line-clamp-1 text-[11px] text-slate-500 dark:text-slate-400">
                      {item.topArticle?.summary || item.topArticle?.tldr}
                    </p>
                  )}
                  <p className="num mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                    {item.sources} 个来源 · {item.articles} 篇
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <Sparkline hourly={item.hourly} className="hidden h-5 w-16 opacity-70 sm:block" />
                  <div className="text-right">
                    <p className="num text-lg font-semibold leading-none text-[var(--hot)]">{item.hot}</p>
                    <div className="mt-1">
                      <Momentum item={item} size="sm" />
                    </div>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        </>
      )}

      {/* 口径说明 */}
      {items.length > 0 && (
        <details className="rounded-xl border border-[var(--line)] px-3 py-2">
          <summary className="cursor-pointer list-none text-[11px] text-slate-500 dark:text-slate-400">
            热度是怎么算的？
          </summary>
          <div className="mt-2 space-y-1 text-[11px] leading-relaxed text-slate-500 dark:text-slate-400">
            <p>· 只看最近 48 小时；同一个事件按「独立来源数」计，同一家发十篇也只算一次。</p>
            <p>· 热度 = Σ 每天（独立源 × 3 + 文章数）× 时间衰减（当天 1.0，前一天 0.5，即 24 小时减半）。</p>
            <p>· 「发酵中 ↑N%」＝ 近 6 小时的文章数与前 6 小时相比；「新」＝ 6 小时内首次出现。</p>
            <p>· 曲线是近 24 小时逐小时的新增报道数，只反映「还在被讨论」的节奏。</p>
            <p>· 局限：本项目事件键按天分桶，跨天的跟进若标题措辞不同，会分成两条。</p>
          </div>
        </details>
      )}
    </div>
  )
}
