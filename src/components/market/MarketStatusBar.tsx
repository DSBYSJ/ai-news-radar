import { useState } from 'react'
import { api } from '../../api.ts'
import type { MarketOverview } from '../../types.ts'

/**
 * 估值页数据状态条（v0.45.0）
 *
 * 这个组件存在的理由：估值页之前最大的问题是**"看着像实时，其实行情停在三周前"**。
 * 所以把「行情截至哪天 / 落后几天 / 上次同步时间」放在最显眼的位置，
 * 并提供"立即刷新"（异步任务 + 轮询）。数据旧了就显式变黄/变红，不装没事。
 */

const STATUS_STYLE = {
  ok: { dot: 'bg-emerald-500', text: 'text-emerald-600 dark:text-emerald-400', label: '最新' },
  lag: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', label: '略有滞后' },
  stale: { dot: 'bg-red-500', text: 'text-red-600 dark:text-red-400', label: '数据过期' },
  unknown: { dot: 'bg-slate-400', text: 'text-slate-500', label: '未知' },
} as const

export default function MarketStatusBar({
  data,
  onRefreshed,
}: {
  data: MarketOverview
  onRefreshed: () => Promise<void> | void
}) {
  const [syncing, setSyncing] = useState(false)
  const [msg, setMsg] = useState('')
  const f = data.freshness
  const style = STATUS_STYLE[f.status]

  const refresh = async (): Promise<void> => {
    if (syncing) return
    setSyncing(true)
    setMsg('正在同步行情与比率…')
    try {
      const r = await api.marketSync()
      if (!r.ok || !r.jobId) {
        setMsg(r.error ?? '同步未启动')
        return
      }
      // 轮询（每个标的 5 年日线，通常 20–60 秒）
      for (let i = 0; i < 60; i++) {
        await new Promise((res) => setTimeout(res, 2000))
        const st = await api.marketSyncStatus(r.jobId)
        if (st.status === 'done') {
          setMsg('同步完成，正在刷新…')
          await onRefreshed()
          setMsg('已是最新')
          return
        }
        if (st.status === 'error') {
          setMsg(`同步失败：${st.error ?? '未知原因'}`)
          return
        }
      }
      setMsg('同步耗时较长，请稍后手动刷新')
    } catch (e) {
      setMsg(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  return (
    <section className="card p-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {/* 新鲜度 */}
        <span className="flex items-center gap-1.5">
          <span className={`inline-block h-2 w-2 rounded-full ${style.dot}`} />
          <span className={`text-[11.5px] font-medium ${style.text}`}>
            行情截至 {f.priceUntil ?? '—'}
          </span>
          {f.daysBehind !== null && f.daysBehind > 0 && (
            <span className="num text-[10.5px] text-slate-400">（落后 {f.daysBehind} 天 · {style.label}）</span>
          )}
        </span>

        {/* 覆盖：财务面 / 估值面分开说，避免"大半是空的"的错觉 */}
        <span className="text-[10.5px] text-slate-500 dark:text-slate-400">
          财务面{' '}
          <b className="num text-slate-700 dark:text-slate-200">
            {data.companies.filter((c) => c.revenue !== null).length}
          </b>
          /{data.coverage.total} · 估值面{' '}
          <b className="num text-slate-700 dark:text-slate-200">{data.coverage.valued}</b>/
          {data.coverage.total}
        </span>

        {/* 窗口 */}
        {data.coverage.windowFrom && (
          <span className="num text-[10.5px] text-slate-400">
            分位窗口 {data.coverage.windowFrom} ~ {data.coverage.windowTo}
            {data.coverage.windowYears !== null && `（${data.coverage.windowYears} 年）`}
          </span>
        )}

        {/* 刷新 */}
        <span className="ml-auto flex items-center gap-2">
          {msg && <span className="text-[10.5px] text-slate-500 dark:text-slate-400">{msg}</span>}
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={syncing}
            className="rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[11px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
          >
            {syncing ? '同步中…' : '立即刷新'}
          </button>
        </span>
      </div>

      {data.coverage.valued < data.coverage.total && (
        <p className="mt-2 text-[10px] leading-relaxed text-amber-600 dark:text-amber-400">⚠️ {data.coverage.note}</p>
      )}
    </section>
  )
}
