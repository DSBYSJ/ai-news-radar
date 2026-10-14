import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import type { SummaryDetail, SummaryListItem } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, formatDateTime } from '../utils/format.ts'

/** 每日总结：左侧历史日期列表 + 右侧简报正文（AI 生成，AI 不可用时为统计版） */
export default function SummaryPage() {
  const [items, setItems] = useState<SummaryListItem[]>([])
  const [selected, setSelected] = useState('')
  const [detail, setDetail] = useState<SummaryDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genDate, setGenDate] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)

  const loadList = useCallback(async (): Promise<SummaryListItem[]> => {
    setLoading(true)
    try {
      const res = await api.summaries(90)
      setItems(res.items)
      setSelected((cur) => cur || res.items[0]?.date || '')
      setError(null)
      return res.items
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return []
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadList()
  }, [loadList])

  useEffect(() => {
    if (!selected) {
      setDetail(null)
      return
    }
    let alive = true
    api
      .summary(selected)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch(() => {
        if (alive) setDetail(null)
      })
    return () => {
      alive = false
    }
  }, [selected])

  const generate = async () => {
    setGenerating(true)
    setMessage('')
    try {
      const res = await api.generateSummary(genDate || undefined, true)
      setMessage(
        !res.ok
          ? `跳过：${res.reason ?? '未知'}`
          : res.skipped
            ? `已存在，跳过（${res.model}）`
            : `已生成（${res.model}）`,
      )
      const list = await loadList()
      const target = res.summary && res.ok ? res.date : list[0]?.date
      if (target) {
        setSelected(target)
        if (res.summary) setDetail(res.summary)
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
        <label className="flex flex-col gap-1 text-xs text-slate-500 dark:text-slate-400">
          生成指定日期（UTC）
          <input
            type="date"
            className="rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-700 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-200"
            value={genDate}
            onChange={(e) => setGenDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating}
          className="rounded-full bg-violet-600 px-4 py-1.5 text-sm font-medium text-white transition hover:-translate-y-0.5 hover:bg-violet-500 hover:shadow-md disabled:opacity-50"
        >
          {generating ? '生成中…' : '生成 / 更新'}
        </button>
        <button
          type="button"
          onClick={() => void loadList()}
          className="rounded-full border border-slate-300 px-4 py-1.5 text-sm text-slate-700 transition hover:-translate-y-0.5 hover:shadow-sm dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
        >
          刷新
        </button>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          不选日期默认生成<b>昨天</b>（每天自动生成，无需手动）；历史日期可补生成
        </p>
        {message && <p className="w-full text-xs text-slate-600 dark:text-slate-300">{message}</p>}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}

      {!loading && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          还没有每日总结 —— 点上面的「生成 / 更新」先来一份
        </p>
      )}

      <div className="flex flex-col gap-4 md:flex-row">
        {items.length > 0 && (
          <aside className="w-full shrink-0 space-y-1.5 md:w-56">
            {items.map((it) => (
              <button
                key={it.date}
                type="button"
                onClick={() => setSelected(it.date)}
                className={`w-full rounded-lg border px-3 py-2 text-left text-sm transition ${
                  selected === it.date
                    ? 'border-violet-600 bg-violet-600 text-white'
                    : 'border-slate-200 bg-white text-slate-700 hover:border-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300 dark:hover:border-slate-600'
                }`}
              >
                <span className="block font-medium">{it.date}</span>
                <span
                  className={`block truncate text-xs ${
                    selected === it.date ? 'text-violet-100' : 'text-slate-500 dark:text-slate-400'
                  }`}
                >
                  {it.title}
                </span>
              </button>
            ))}
          </aside>
        )}

        {detail && (
          <article className="flex-1 rounded-xl border border-slate-200 bg-white p-5 shadow-[0_1px_2px_rgba(16,24,40,0.04)] dark:border-slate-800 dark:bg-slate-900">
            <header className="mb-3">
              <div className="flex flex-wrap items-center gap-2 text-xs">
                <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-white dark:bg-slate-700">
                  {detail.date}
                </span>
                <span
                  className={`rounded-full px-2.5 py-0.5 ${
                    detail.model === 'statistical'
                      ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400'
                      : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
                  }`}
                >
                  {detail.model === 'statistical' ? '统计版' : 'AI 简报'}
                </span>
                {detail.stats && (
                  <>
                    <span className="rounded-full bg-slate-100 px-2.5 py-0.5 text-slate-600 dark:bg-slate-800 dark:text-slate-300">
                      共 {detail.stats.total} 条
                    </span>
                    {detail.stats.deltaPct !== null && (
                      <span
                        className={`rounded-full px-2.5 py-0.5 ${
                          detail.stats.deltaPct >= 0
                            ? 'bg-red-50 text-red-600 dark:bg-red-950/40 dark:text-red-400'
                            : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
                        }`}
                      >
                        环比 {detail.stats.deltaPct >= 0 ? '↑' : '↓'} {Math.abs(detail.stats.deltaPct)}%
                      </span>
                    )}
                    {detail.stats.crossSource > 0 && (
                      <span className="rounded-full bg-red-50 px-2.5 py-0.5 text-red-600 dark:bg-red-950/40 dark:text-red-400">
                        跨源事件 {detail.stats.crossSource} 条
                      </span>
                    )}
                    <span className="text-slate-400 dark:text-slate-500">生成于 {formatDateTime(detail.updated_at)}</span>
                  </>
                )}
              </div>
              <h2 className="mt-2.5 text-base font-semibold text-slate-900 dark:text-slate-100">{detail.title}</h2>
              {detail.stats && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {Object.entries(detail.stats.byCategory)
                    .sort((a, b) => b[1] - a[1])
                    .map(([c, n]) => (
                      <span
                        key={c}
                        className="rounded-full px-2 py-0.5 text-xs text-white"
                        style={{ backgroundColor: CATEGORY_COLORS[c] ?? '#9ca3af' }}
                      >
                        {CATEGORY_LABELS[c] ?? c} {n}
                      </span>
                    ))}
                </div>
              )}
            </header>

            <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700 dark:text-slate-300">
              {detail.content}
            </pre>

            {detail.highlights.length > 0 && (
              <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
                <h3 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">当日重点条目</h3>
                <ul className="space-y-1.5">
                  {detail.highlights.map((h) => (
                    <li key={h.url} className="flex items-start gap-2 text-xs">
                      {h.sourceCount && h.sourceCount >= 2 && (
                        <span className="mt-0.5 shrink-0 rounded-full bg-red-600 px-2 py-0.5 text-white">
                          {h.sourceCount} 源
                        </span>
                      )}
                      <a
                        href={h.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-slate-700 hover:underline dark:text-slate-200"
                      >
                        {h.title}
                      </a>
                      <span className="ml-auto shrink-0 text-slate-400 dark:text-slate-500">{h.sourceName}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </article>
        )}
      </div>
    </div>
  )
}
