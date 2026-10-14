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

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setData(await api.articles({ ...filters, limit }))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }, [filters, limit])

  useEffect(() => {
    void load()
  }, [load])

  return (
    <div className="space-y-3">
      <Filters value={filters} onChange={setFilters} sources={sources} />

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>
          {loading ? '加载中…' : `共 ${data?.total ?? 0} 条，已显示 ${data?.items.length ?? 0} 条`}
        </span>
        {data && data.total > (data.items.length ?? 0) && (
          <button
            type="button"
            onClick={() => setLimit((v) => v + 50)}
            className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
          >
            加载更多
          </button>
        )}
      </div>

      {error && <p className="rounded bg-red-50 p-3 text-sm text-red-600">{error}</p>}

      {data && data.items.length === 0 && !loading && (
        <p className="rounded border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500">
          没有符合条件的条目 —— 可以先在右上角跑一轮「采集 + 加工」
        </p>
      )}

      <div className="space-y-3">
        {data?.items.map((a) => (
          <ArticleCard key={a.id} article={a} />
        ))}
      </div>
    </div>
  )
}
