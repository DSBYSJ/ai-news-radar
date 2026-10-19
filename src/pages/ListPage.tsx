import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import ArticleCard from '../components/ArticleCard.tsx'
import Filters, { type FilterState } from '../components/Filters.tsx'
import type { ArticlesResponse, SourceItem } from '../types.ts'

export default function ListPage({ sources }: { sources: SourceItem[] }) {
  const [filters, setFilters] = useState<FilterState>({
    days: 7,
    category: '',
    source: '',
    minScore: 0,
    q: '',
  })
  const [data, setData] = useState<ArticlesResponse | null>(null)
  const [limit, setLimit] = useState(50)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 关键词逐字符触发请求既浪费带宽也会让结果乱跳：这里对 q 单独防抖 300ms，
  // 其余筛选条件（下拉/滑块）仍然立即生效。
  const [debouncedQ, setDebouncedQ] = useState(filters.q)
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(filters.q), 300)
    return () => clearTimeout(timer)
  }, [filters.q])

  // 换筛选条件时回到第一页，否则会停在上一次的「加载更多」长度上。
  // 放在同一个更新里做（而不是另起 useEffect），否则 limit 与筛选会各触发一次请求。
  const applyFilters = useCallback((next: FilterState) => {
    setFilters(next)
    setLimit(50)
  }, [])

  // ⚠️ 依赖列表里绝不能放整个 filters 对象 —— 它含 q，每敲一个字都会触发一次请求，
  // 防抖就白做了（实测连续输入 5 个字符会发 6 次请求）。这里逐个列出真正的请求参数，
  // 关键词只走 debouncedQ。
  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(
        await api.articles({
          days: filters.days,
          category: filters.category,
          source: filters.source,
          minScore: filters.minScore,
          q: debouncedQ,
          limit,
        }),
      )
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filters.days, filters.category, filters.source, filters.minScore, debouncedQ, limit])

  useEffect(() => {
    void load()
  }, [load])

  const dirty =
    filters.days !== 7 || filters.category !== '' || filters.source !== '' || filters.minScore !== 0 || filters.q !== ''
  const reset = () => applyFilters({ days: 7, category: '', source: '', minScore: 0, q: '' })

  return (
    <div className="space-y-3">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
            <span className="inline-block h-4 w-[3px] rounded-full bg-gradient-to-b from-violet-500 to-indigo-500" />
            资讯列表
          </h2>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
            按时间倒序的成品条目 —— 默认只给「标题 + 一句话」，需要细节再展开摘要与实体
          </p>
        </div>
      </header>

      <Filters value={filters} onChange={applyFilters} sources={sources} />

      <div className="flex flex-wrap items-center justify-between gap-2 text-[11.5px] text-slate-500 dark:text-slate-400">
        <span className="flex items-center gap-2">
          {loading ? (
            <>
              <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600" />
              加载中…
            </>
          ) : (
            <>
              <span className="num font-semibold text-slate-800 dark:text-slate-100">{data?.total ?? 0}</span>
              条结果
              {data && data.items.length < (data.total ?? 0) && (
                <span className="text-slate-400 dark:text-slate-500">· 已显示 {data.items.length}</span>
              )}
            </>
          )}
          {dirty && !loading && (
            <button
              type="button"
              onClick={reset}
              className="rounded-full border border-slate-200 px-2.5 py-0.5 text-[11px] text-slate-500 transition hover:border-violet-300 hover:text-violet-700 dark:border-white/10 dark:text-slate-400 dark:hover:border-violet-500/40 dark:hover:text-violet-300"
            >
              清空筛选
            </button>
          )}
        </span>
        {data && data.total > (data.items.length ?? 0) && (
          <button
            type="button"
            onClick={() => setLimit((v) => v + 50)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-[12px] font-medium text-slate-700 shadow-sm transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200 dark:hover:border-white/20"
          >
            加载更多
          </button>
        )}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}

      {loading && !data && (
        <div className="space-y-3" aria-hidden="true">
          {[0, 1, 2].map((i) => (
            <div key={i} className="card p-4">
              <div className="flex gap-2">
                <span className="skeleton h-4 w-12 rounded-full" />
                <span className="skeleton h-4 w-16 rounded-full" />
                <span className="skeleton h-4 w-24 rounded-full" />
              </div>
              <div className="skeleton mt-3 h-4 w-4/5 rounded" />
              <div className="skeleton mt-2 h-3 w-3/5 rounded" />
            </div>
          ))}
        </div>
      )}

      {data && data.items.length === 0 && !loading && (
        <div className="card flex flex-col items-center gap-2 px-6 py-12 text-center">
          <svg viewBox="0 0 24 24" className="h-8 w-8 text-slate-300 dark:text-slate-600" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="7" />
            <path d="M20 20l-3.5-3.5" />
          </svg>
          <p className="text-[13px] font-medium text-slate-600 dark:text-slate-300">没有符合条件的条目</p>
          <p className="text-[12px] text-slate-400 dark:text-slate-500">
            试试放宽时间范围或清空筛选，也可以先跑一轮「采集 + 加工」
          </p>
        </div>
      )}

      <div className="space-y-3">
        {data?.items.map((a, i) => (
          // 入场错峰：只给前 12 条加延迟，避免长列表末尾要等很久才出现
          <div key={a.id} className={i < 12 ? 'reveal' : undefined} style={i < 12 ? { animationDelay: `${i * 28}ms` } : undefined}>
            <ArticleCard article={a} />
          </div>
        ))}
      </div>
    </div>
  )
}
