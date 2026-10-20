import { useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { HotItem } from '../types.ts'

/** 动量标记：新出现 / 发酵中 / 持平 / 回落 */
function Momentum({ item }: { item: HotItem }) {
  if (item.isNew) {
    return (
      <span className="rounded-full bg-[var(--hot-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--hot)]">新</span>
    )
  }
  if (item.deltaPct === null) return null
  if (item.deltaPct >= 15) {
    return (
      <span className="rounded-full bg-[var(--hot-soft)] px-2 py-0.5 text-[10px] font-medium text-[var(--hot)]">
        发酵中 ↑{item.deltaPct}%
      </span>
    )
  }
  if (item.deltaPct <= -15) {
    return (
      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-white/5 dark:text-slate-400">
        ↓{Math.abs(item.deltaPct)}%
      </span>
    )
  }
  return (
    <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] text-slate-500 dark:bg-white/5 dark:text-slate-400">
      持平
    </span>
  )
}

function HotIndex({ value, size = 'lg' }: { value: number; size?: 'lg' | 'sm' }) {
  return (
    <div className="text-right">
      <p className={`num font-semibold leading-none text-[var(--hot)] ${size === 'lg' ? 'text-2xl' : 'text-base'}`}>
        {value}
      </p>
      {size === 'lg' && <p className="mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">热度指数</p>}
    </div>
  )
}

/**
 * AI 热点榜：近 48 小时讨论最多的事件。
 * 版式参考 AIHOT /hot（前 3 名大卡 + 4–10 紧凑行），热度口径见下方说明。
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

  const top = items.slice(0, 3)
  const rest = items.slice(3)

  return (
    <div className="space-y-4">
      <header>
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">AI 热点榜</h2>
          <span className="num text-[11px] text-slate-400 dark:text-slate-500">
            {updatedAt ? `${new Date(updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 更新` : '—'}
            {' · '}按讨论热度排序
          </span>
        </div>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          过去 <b className="text-slate-600 dark:text-slate-300">48 小时</b> AI 圈讨论最多的 10 件事 —— 看的是「多少家独立源在说」，不是谁发得多。
        </p>
      </header>

      {loading && (
        <div className="space-y-2.5">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card h-24 animate-pulse" />
          ))}
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

      {/* Top 3：大卡 */}
      {top.map((item) => (
        <article key={item.eventKeys[0] ?? item.title} className="card card-accent relative overflow-hidden p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <span className="num text-[11px] font-bold tracking-tight text-[var(--hot)]">
                NO.{String(item.rank).padStart(2, '0')}
              </span>
              <Momentum item={item} />
            </div>
            <HotIndex value={item.hot} />
          </div>

          <h3 className="mt-2 text-[16px] font-semibold leading-snug text-slate-900 dark:text-white">
            {item.topArticle ? (
              <a href={item.topArticle.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </h3>

          {(item.topArticle?.summary || item.topArticle?.tldr) && (
            <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-slate-600 dark:text-slate-300">
              {item.topArticle.summary || item.topArticle.tldr}
            </p>
          )}

          <div className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-slate-400 dark:text-slate-500">
            <span className="num">
              {item.sources} 个来源 · {item.articles} 篇报道
            </span>
            {item.topArticle && <span className="truncate">首发 {item.topArticle.sourceName}</span>}
            {item.topArticle && (
              <a
                href={item.topArticle.url}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-auto shrink-0 font-medium text-[var(--accent)] hover:underline"
              >
                原文 ↗
              </a>
            )}
          </div>
        </article>
      ))}

      {/* 04–10：紧凑列表 */}
      {rest.length > 0 && (
        <ol className="card divide-y divide-[var(--line)] overflow-hidden p-0">
          {rest.map((item) => (
            <li key={item.eventKeys[0] ?? item.title} className="flex items-start gap-3 px-3.5 py-2.5">
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
                <p className="num mt-0.5 text-[10px] text-slate-400 dark:text-slate-500">
                  {item.sources} 源 · {item.articles} 篇
                </p>
              </div>
              <div className="shrink-0 text-right">
                <p className="num text-sm font-semibold leading-none text-[var(--hot)]">{item.hot}</p>
                <div className="mt-1">
                  <Momentum item={item} />
                </div>
              </div>
            </li>
          ))}
        </ol>
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
            <p>· 局限：本项目事件键按天分桶，跨天的跟进若标题措辞不同，会分成两条。</p>
          </div>
        </details>
      )}
    </div>
  )
}
