import { useCallback, useEffect, useState } from 'react'
import { api } from '../api.ts'
import { exportEditionMarkdown } from '../lib/exporters.ts'
import EditionView from '../components/EditionView.tsx'
import PeriodView from '../components/PeriodView.tsx'
import Modal from '../components/Modal.tsx'
import type { Edition, PeriodReport, SummaryListItem } from '../types.ts'

/**
 * 每日简报：日期网格 + 点击看当天**结构化日报**（头条 / 分类分区 / 快讯）。
 * 版式思路参考 AIHOT（MIT）：一件事只出现一次，每条给来源与原文链接。
 */
/** UTC 日期加减（周报上一期 = 减 7 天） */
function shiftDays(dateIso: string, days: number): string {
  const d = new Date(`${dateIso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 上个月 1 号（月报上一期） */
function prevMonthStart(dateIso: string): string {
  const [y, m] = dateIso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10)
}

export default function SummaryPage() {
  const [items, setItems] = useState<SummaryListItem[]>([])
  const [open, setOpen] = useState('')
  const [edition, setEdition] = useState<Edition | null>(null)
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [genDate, setGenDate] = useState('')
  const [message, setMessage] = useState('')
  const [error, setError] = useState<string | null>(null)
  /** 日 / 周 / 月：周报月报是确定性统计汇编，不额外调模型 */
  const [view, setView] = useState<'day' | 'week' | 'month'>('day')
  const [period, setPeriod] = useState<PeriodReport | null>(null)
  const [anchor, setAnchor] = useState('')

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

  // 打开某天时才拉版面数据（点开即用，首屏不空转）
  useEffect(() => {
    if (!open) {
      setEdition(null)
      return
    }
    let alive = true
    setEdition(null)
    api
      .edition(open)
      .then((d) => {
        if (alive) setEdition(d)
      })
      .catch(() => {
        if (alive) setEdition(null)
      })
    return () => {
      alive = false
    }
  }, [open])

  useEffect(() => {
    if (view === 'day') {
      setPeriod(null)
      return
    }
    let alive = true
    setPeriod(null)
    api
      .period(view, anchor || undefined)
      .then((r) => {
        if (alive) setPeriod(r)
      })
      .catch(() => {
        if (alive) setPeriod(null)
      })
    return () => {
      alive = false
    }
  }, [view, anchor])

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
      const target = res.ok && res.summary ? res.date : list[0]?.date
      if (target) setOpen(target)
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
        <h2 className="text-base font-semibold text-slate-900 dark:text-slate-100">每日简报</h2>
        <p className="mt-0.5 text-xs text-slate-500 dark:text-slate-400">
          每天 <b className="text-slate-600 dark:text-slate-300">23:00（北京时间）</b>
          自动生成当天日报：头条 / 分类分区 / 快讯。<b className="text-slate-600 dark:text-slate-300">点日期卡片</b>
          查看当天版面；缺的日子可手动补生成。
        </p>
      </header>

      {/* 日 / 周 / 月 */}
      <div className="inline-flex rounded-xl border border-[var(--line)] bg-slate-100/70 p-1 dark:bg-white/5">
        {(
          [
            ['day', '日报'],
            ['week', '周报'],
            ['month', '月报'],
          ] as ['day' | 'week' | 'month', string][]
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => {
              setView(key)
              setAnchor('')
            }}
            className={`rounded-lg px-3 py-1 text-xs transition ${
              view === key
                ? 'bg-white font-medium text-slate-900 shadow-sm dark:bg-white/10 dark:text-white'
                : 'text-slate-500 hover:text-slate-800 dark:text-slate-400 dark:hover:text-slate-100'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {view !== 'day' && (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (!period) return
                setAnchor(view === 'week' ? shiftDays(period.start, -7) : prevMonthStart(period.start))
              }}
              className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300"
            >
              ‹ 上一期
            </button>
            <button
              type="button"
              onClick={() => setAnchor('')}
              className="rounded-lg border border-[var(--line)] px-2.5 py-1 text-xs text-slate-600 dark:text-slate-300"
            >
              最近一期
            </button>
            <span className="text-[11px] text-slate-400 dark:text-slate-500">
              {view === 'week' ? '按周一至周日统计（UTC）' : '按自然月统计（UTC）'}
            </span>
          </div>
          <div className="card p-4">
            {period ? (
              <PeriodView report={period} />
            ) : (
              <p className="flex items-center gap-2 py-6 text-xs text-slate-500 dark:text-slate-400">
                <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600" />
                正在汇总本期数据…
              </p>
            )}
          </div>
        </div>
      )}

      {view === 'day' && (
        <>
      <div className="card flex flex-wrap items-end gap-3 p-4">
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
              onClick={() => edition && exportEditionMarkdown(edition)}
              disabled={!edition}
              className="rounded-lg border border-[var(--line)] px-3 py-1.5 text-xs text-slate-600 transition hover:border-slate-400 disabled:opacity-40 dark:text-slate-300"
              title="导出当天日报为 Markdown（Obsidian / Notion 语法，含表格与图表占位符）"
            >
              导出 Markdown
            </button>
        <button
          type="button"
          onClick={() => void loadList()}
          className="rounded-full border border-slate-300 px-4 py-1.5 text-sm text-slate-700 transition hover:-translate-y-0.5 hover:shadow-sm dark:border-slate-700 dark:text-slate-200 dark:hover:border-slate-500"
        >
          刷新
        </button>
        <p className="text-xs text-slate-500 dark:text-slate-400">
          不选日期默认生成<b>当天</b>（每天 23:00 自动生成，无需手动）
        </p>
        {message && <p className="w-full text-xs text-slate-600 dark:text-slate-300">{message}</p>}
      </div>

      {error && (
        <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
      )}

      {!loading && items.length === 0 && (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-6 text-center text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400">
          还没有每日简报 —— 点上面的「生成 / 更新」先来一份
        </p>
      )}

      {/* 日期网格：手机 2 列，桌面 3~4 列 */}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
        {items.map((it) => (
          <button
            key={it.date}
            type="button"
            onClick={() => setOpen(it.date)}
            className="card min-w-0 p-3 text-left transition hover:-translate-y-0.5 hover:border-violet-400 hover:shadow-md dark:hover:border-violet-500"
          >
            <span className="flex items-center gap-1.5">
              <span className="num text-sm font-semibold text-slate-900 dark:text-slate-100">{it.date}</span>
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
                <span className="num ml-auto shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
                  {it.stats.total} 条
                </span>
              )}
            </span>
            <span className="mt-1.5 line-clamp-2 block break-words text-xs leading-snug text-slate-600 dark:text-slate-300">
              {it.title}
            </span>
          </button>
        ))}
      </div>

      {/* 弹窗：当天结构化日报 */}
      <Modal
        open={open !== ''}
        onClose={() => setOpen('')}
        title={
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="num rounded-full bg-slate-900 px-2.5 py-0.5 text-xs text-white dark:bg-slate-700">
                {open}
              </span>
              <h3 className="text-base font-semibold text-slate-900 dark:text-slate-100">
                {openItem?.title ?? '每日日报'}
              </h3>
            </div>
          </div>
        }
      >
        {edition ? (
          <EditionView edition={edition} />
        ) : (
          <p className="flex items-center gap-2 py-8 text-xs text-slate-500 dark:text-slate-400">
            <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-slate-300 border-t-violet-600" />
            正在编排当天版面…
          </p>
        )}
      </Modal>
        </>
      )}
    </div>
  )
}
