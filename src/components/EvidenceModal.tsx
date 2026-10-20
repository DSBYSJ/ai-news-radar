import { useEffect, useState } from 'react'
import { api } from '../api.ts'

/**
 * 判定依据弹窗（item 7）
 * 用于「负面情绪预警」与「突发检测」卡片旁的「查看判定依据」按钮：
 * 展示触发该判断的原始新闻片段，以及判定规则（AI 提示词 / 关键词 / z 分数公式）。
 */

type Evidence =
  | {
      kind: 'sentiment'
      date: string
      rule: string
      items: { id: number; title: string; url: string; sentiment: string; sentiment_keywords: string | null; source_name: string }[]
    }
  | {
      kind: 'burst'
      date: string
      category: string
      rule: string
      baseline: number | null
      actual: number | null
      z: number | null
      items: { id: number; title: string; url: string; published_at: string; source_name: string }[]
    }

interface Props {
  open: boolean
  onClose: () => void
  kind: 'sentiment' | 'burst'
  date: string
  category?: string
}

export default function EvidenceModal({ open, onClose, kind, date, category }: Props) {
  const [data, setData] = useState<Evidence | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open || !date) return
    let alive = true
    setLoading(true)
    setError(null)
    void (async () => {
      try {
        const res = await fetch(
          `/api/news/debug/evidence?kind=${kind}&date=${date}${category ? `&category=${encodeURIComponent(category)}` : ''}`,
          { credentials: 'include' },
        )
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const json = (await res.json()) as Evidence & { error?: string }
        if (!alive) return
        if (json.error) setError(json.error)
        else setData(json)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => {
      alive = false
    }
  }, [open, kind, date, category])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[70] flex items-start justify-center bg-slate-900/50 px-4 pt-[10vh] pb-8"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-full max-w-2xl overflow-hidden rounded-2xl border border-[var(--line)] bg-white shadow-2xl dark:bg-[#141821]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3 border-b border-[var(--line)] px-4 py-3">
          <div className="min-w-0">
            <p className="text-[13px] font-semibold text-slate-800 dark:text-slate-100">
              判定依据 · {kind === 'sentiment' ? '负面情绪' : '突发检测'}
            </p>
            <p className="num mt-0.5 text-[11px] text-slate-400">
              {date}
              {kind === 'burst' && category ? ` · ${category}` : ''}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded-full border border-[var(--line)] px-3 py-1 text-[11px] text-slate-500 transition hover:border-slate-400"
          >
            关闭
          </button>
        </header>

        <div className="max-h-[64vh] overflow-y-auto px-4 py-3">
          {loading && <p className="py-6 text-center text-[12px] text-slate-400">加载中…</p>}
          {error && <p className="py-6 text-center text-[12px] text-red-600 dark:text-red-400">{error}</p>}

          {!loading && !error && data && (
            <>
              <div className="rounded-lg bg-slate-50 px-3 py-2 dark:bg-white/[0.04]">
                <p className="text-[10.5px] font-medium text-slate-500 dark:text-slate-400">判定规则</p>
                <p className="mt-1 text-[11.5px] leading-relaxed text-slate-700 dark:text-slate-300">{data.rule}</p>
                {data.kind === 'burst' && (
                  <p className="num mt-1.5 text-[11.5px] text-slate-600 dark:text-slate-300">
                    当日 {data.actual ?? '—'} 条 · 基线 {data.baseline ?? '—'} 条 · z = {data.z ?? '—'}（阈值 2.5）
                  </p>
                )}
              </div>

              <p className="mt-3 text-[10.5px] font-medium text-slate-500 dark:text-slate-400">
                触发该判断的原始条目（{data.items.length}）
              </p>
              <ul className="mt-1.5 divide-y divide-slate-100 dark:divide-white/[0.06]">
                {data.items.map((it) => (
                  <li key={it.id} className="py-2">
                    <a
                      href={it.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[12.5px] leading-snug text-slate-700 hover:text-[var(--accent)] hover:underline dark:text-slate-200"
                    >
                      {it.title}
                    </a>
                    <p className="num mt-0.5 text-[10.5px] text-slate-400">
                      {it.source_name}
                      {'sentiment_keywords' in it && it.sentiment_keywords ? ` · 依据：${it.sentiment_keywords}` : ''}
                    </p>
                  </li>
                ))}
              </ul>
              {data.items.length === 0 && (
                <p className="py-4 text-center text-[12px] text-slate-400">该日期没有触发条目</p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
