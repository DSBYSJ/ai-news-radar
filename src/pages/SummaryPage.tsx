import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import Modal from '../components/Modal.tsx'
import type { SummaryDetail, SummaryListItem } from '../types.ts'
import { CATEGORY_COLORS, CATEGORY_LABELS, formatDateTime } from '../utils/format.ts'

/** 单日简报正文（页面与弹窗共用同一段渲染） */
function SummaryArticle({ detail }: { detail: SummaryDetail }) {
  return (
    <article>
      <div className="flex flex-wrap items-center gap-2 text-xs">
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

      <h2 className="mt-2.5 text-base font-semibold leading-snug text-slate-900 dark:text-slate-100">{detail.title}</h2>

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

      <pre className="mt-3 whitespace-pre-wrap font-sans text-sm leading-relaxed text-slate-700 dark:text-slate-300">
        {detail.content}
      </pre>

      {detail.highlights.length > 0 && (
        <div className="mt-4 border-t border-slate-100 pt-3 dark:border-slate-800">
          <h3 className="mb-2 text-xs font-medium text-slate-700 dark:text-slate-300">当日重点条目</h3>
          <ul className="space-y-1.5">
            {detail.highlights.map((h) => (
              <li key={h.url} className="flex items-start gap-2 text-xs">
                {h.sourceCount && h.sourceCount >= 2 && (
                  <span className="mt-0.5 shrink-0 rounded-full bg-red-600 px-2 py-0.5 text-white">{h.sourceCount} 源</span>
                )}
                <a
                  href={h.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="min-w-0 break-words text-slate-700 hover:underline dark:text-slate-200"
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
  )
}

/**
 * 每日总结：**日期网格 + 点击弹出当天简报**。
 * 之前是"左侧长列表 + 右侧正文"，手机上要滚很久；现在页面只留紧凑的日期卡，
 * 正文放进弹窗按需查看（Esc / 点遮罩 / 关闭按钮均可退出）。
 */
export default function SummaryPage() {
  const [items, setItems] = useState<SummaryListItem[]>([])
  const [open, setOpen] = useState('')
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

  // 打开某个日期时才拉正文（点开即用，避免首屏空转）
  useEffect(() => {
    if (!open) {
      setDetail(null)
      return
    }
    let alive = true
    setDetail(null)
    api
      .summary(open)
      .then((d) => {
        if (alive) setDetail(d)
      })
      .catch(() => {
        if (alive) setDetail(null)
      })
    return () => {
      alive = false
    }
  }, [open])

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
        setOpen(target)
        if (res.summary) setDetail(res.summary)
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setGenerating(false)
    }
  }

  const openItem = items.find((it) => it.date === open)

  return (
    <div className="space-y-4">
      <header>
        <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
          <span className="inline-block h-4 w-[3px] rounded-full bg-gradient-to-b from-violet-500 to-indigo-500" />
          每日简报
        </h2>
        <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
          AI 每天 <b className="text-slate-600 dark:text-slate-300">23:00（北京时间）自动生成当天简报</b>
          （综述 / 分类要点 / 关注方向）。
          <b className="text-slate-600 dark:text-slate-300">点日期卡片</b>即可查看当天简报，历史可回看；缺的日子可手动补生成。
        </p>
      </header>

      <div className="card flex flex-wrap items-end gap-x-3 gap-y-2 p-3.5">
        <label className="flex flex-col gap-1 text-[10.5px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
          指定日期（UTC）
          <input
            type="date"
            className="h-8 rounded-lg border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-700 outline-none transition hover:border-slate-300 focus:border-violet-400 focus:ring-2 focus:ring-violet-500/15 dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
            value={genDate}
            onChange={(e) => setGenDate(e.target.value)}
          />
        </label>
        <button
          type="button"
          onClick={() => void generate()}
          disabled={generating}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-gradient-to-b from-violet-500 to-violet-600 px-3.5 text-[13px] font-medium text-white shadow-[0_6px_16px_-8px_rgba(109,40,217,0.9),inset_0_1px_0_rgba(255,255,255,0.28)] transition hover:from-violet-500 hover:to-violet-500 active:translate-y-px disabled:opacity-50"
        >
          {generating ? '生成中…' : '生成 / 更新'}
        </button>
        <button
          type="button"
          onClick={() => void loadList()}
          className="inline-flex h-8 items-center rounded-lg border border-slate-200 bg-white px-3.5 text-[13px] font-medium text-slate-700 transition hover:-translate-y-0.5 hover:border-slate-300 hover:shadow-sm dark:border-white/10 dark:bg-white/[0.04] dark:text-slate-200"
        >
          刷新
        </button>
        <p className="pb-1.5 text-[11px] text-slate-400 dark:text-slate-500">
          不选日期默认生成<b className="text-slate-600 dark:text-slate-300">当天</b>（每天 23:00 自动生成）
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

      {/* 日期网格：卡片形式，点开弹窗看正文（手机 2 列，桌面 3 列） */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((it) => (
          <button
            key={it.date}
            type="button"
            onClick={() => setOpen(it.date)}
            className="card card-hover min-w-0 p-3 text-left"
          >
            <span className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-slate-900 dark:text-slate-100">{it.date}</span>
              <span
                className={`rounded-full px-1.5 py-0.5 text-[10px] ${
                  it.model === 'statistical'
                    ? 'bg-amber-50 text-amber-600 dark:bg-amber-950/40 dark:text-amber-400'
                    : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-950/40 dark:text-emerald-400'
                }`}
              >
                {it.model === 'statistical' ? '统计版' : 'AI'}
              </span>
              {it.stats && (
                <span className="ml-auto shrink-0 text-[10px] text-slate-400 dark:text-slate-500">{it.stats.total} 条</span>
              )}
            </span>
            <span className="mt-1.5 line-clamp-2 block break-words text-xs leading-snug text-slate-600 dark:text-slate-300">
              {it.title}
            </span>
          </button>
        ))}
      </div>

      {/* 弹窗：当天简报全文 */}
      <Modal
        open={open !== ''}
        onClose={() => setOpen('')}
        title={
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="rounded-full bg-slate-900 px-2.5 py-0.5 text-xs text-white dark:bg-slate-700">{open}</span>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {openItem?.title ?? '每日简报'}
              </h3>
            </div>
          </div>
        }
      >
        {detail ? (
          <SummaryArticle detail={detail} />
        ) : (
          <p className="flex items-center gap-2 py-8 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600" />
            正在加载当天简报…
          </p>
        )}
      </Modal>
    </div>
  )
}
