import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MarketCompanyRow, MarketOverview } from '../types.ts'

/**
 * AI 资产估值看板（v0.38.0）
 *
 * 回答三个问题，按顺序：
 *   1. 这条链上谁在赚钱？      → 营收 / 增速 / 净利率 / ROE
 *   2. 现在贵不贵？            → P/S 及其**自身历史分位**（绝对值没有意义）
 *   3. 贵在哪一层？            → 板块中位数
 *
 * ⚠️ 两条必须写在页面上的边界：
 *   - 估值回答"贵不贵"，不回答"会不会崩"（危机概率是另一个模块的事）
 *   - FMP 免费档只覆盖部分标的，未覆盖的显示"—"并说明原因，不能留空
 */

const fmtB = (v: number | null): string => {
  if (v === null) return '—'
  const abs = Math.abs(v)
  if (abs >= 1e12) return `${(v / 1e12).toFixed(2)}T`
  if (abs >= 1e9) return `${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6) return `${(v / 1e6).toFixed(0)}M`
  return v.toFixed(0)
}
const fmtPct = (v: number | null, digits = 1): string =>
  v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(digits)}%`
const fmtX = (v: number | null): string => (v === null ? '—' : `${v.toFixed(1)}x`)
const fmtPctile = (v: number | null): string => (v === null ? '—' : `${Math.round(v * 100)}%`)

/** 分位越高越贵：≥80% 用警示色，≤30% 用冷静色 */
function percentileTone(p: number | null): string {
  if (p === null) return 'text-slate-400'
  if (p >= 0.8) return 'text-red-600 dark:text-red-400'
  if (p >= 0.6) return 'text-amber-600 dark:text-amber-400'
  if (p <= 0.3) return 'text-emerald-600 dark:text-emerald-400'
  return 'text-slate-600 dark:text-slate-300'
}

function PctBar({ value }: { value: number | null }) {
  if (value === null) return <span className="text-[10px] text-slate-400">—</span>
  const pct = Math.max(2, Math.min(100, value * 100))
  const color = value >= 0.8 ? '#e5484d' : value >= 0.6 ? '#f5a623' : value <= 0.3 ? '#22c55e' : '#64748b'
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1 w-10 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
      </div>
      <span className="num text-[10.5px]" style={{ color }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

export default function MarketPage() {
  const [data, setData] = useState<MarketOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'percentile' | 'ps' | 'growth'>('percentile')

  useEffect(() => {
    let alive = true
    api
      .marketOverview()
      .then((d) => {
        if (alive) {
          setData(d)
          setError(null)
        }
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [])

  const rows = useMemo<MarketCompanyRow[]>(() => {
    if (!data) return []
    const list = [...data.companies]
    if (sortBy === 'percentile') {
      // 分位未知的排最后（不能当成 0 混进"便宜"那一档）
      list.sort((a, b) => (b.psPercentile ?? -1) - (a.psPercentile ?? -1))
    } else if (sortBy === 'ps') {
      list.sort((a, b) => (b.ps ?? -1) - (a.ps ?? -1))
    } else {
      list.sort((a, b) => (b.revenueGrowth ?? -999) - (a.revenueGrowth ?? -999))
    }
    return list
  }, [data, sortBy])

  if (loading) return <div className="card h-48 animate-pulse rounded-xl" />
  if (error) return <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
  if (!data) return null

  const { coverage, segments } = data
  const topExpensive = [...data.companies]
    .filter((c) => c.psPercentile !== null)
    .sort((a, b) => (b.psPercentile ?? 0) - (a.psPercentile ?? 0))
    .slice(0, 3)

  return (
    <div className="space-y-4">
      <header>
        <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
          <span className="inline-block h-4 w-[3px] rounded-full bg-gradient-to-b from-emerald-500 to-teal-500" />
          AI 资产估值
        </h2>
        <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
          三个问题依次回答：<b className="font-medium text-slate-600 dark:text-slate-300">谁在赚钱</b> →{' '}
          <b className="font-medium text-slate-600 dark:text-slate-300">现在贵不贵</b> →{' '}
          <b className="font-medium text-slate-600 dark:text-slate-300">贵在哪一层</b>
          。估值回答"贵不贵"，不回答"会不会崩"。
        </p>
      </header>

      {/* 覆盖度：不足必须显式说明，否则用户以为是"这家没估值" */}
      <section className="card p-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px]">
          <span className="text-slate-500 dark:text-slate-400">
            覆盖 <b className="num text-slate-700 dark:text-slate-200">{coverage.valued}</b>/{coverage.total} 家可算估值
          </span>
          <span className="text-slate-400 dark:text-slate-500">（有价格 {coverage.priced} 家）</span>
          {topExpensive.length > 0 && (
            <span className="text-slate-500 dark:text-slate-400">
              最贵：
              {topExpensive.map((c, i) => (
                <span key={c.symbol} className="ml-1">
                  <b className="text-slate-700 dark:text-slate-200">{c.symbol}</b>
                  <span className="num ml-0.5 text-[10.5px] text-red-600 dark:text-red-400">
                    {Math.round((c.psPercentile ?? 0) * 100)}%
                  </span>
                  {i < topExpensive.length - 1 && <span className="text-slate-400">、</span>}
                </span>
              ))}
            </span>
          )}
        </div>
        {coverage.valued < coverage.total && (
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-amber-600 dark:text-amber-400">⚠️ {coverage.note}</p>
        )}
      </section>

      {/* 板块层 */}
      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[11px] tracking-[0.12em] text-slate-400">按板块看：赚钱能力 vs 估值位置</p>
          <p className="text-[10px] text-slate-500">P/S 与分位都是板块内等权中位数</p>
        </div>
        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {segments.map((s) => (
            <div key={s.segment} className="rounded-xl bg-slate-50/80 p-2.5 dark:bg-white/[0.03]">
              <div className="flex items-baseline justify-between">
                <span className="text-[11.5px] text-slate-700 dark:text-slate-200">{s.label}</span>
                <span className="num text-[9.5px] text-slate-400">
                  {s.valuationCovered}/{s.companies}
                </span>
              </div>
              <div className="mt-1.5 flex items-baseline justify-between">
                <span className="text-[10px] text-slate-400">净利率</span>
                <span className="num text-[12px] font-semibold text-slate-700 dark:text-slate-200">
                  {fmtPct(s.netMargin, 0)}
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between">
                <span className="text-[10px] text-slate-400">营收增速</span>
                <span className="num text-[12px] text-slate-600 dark:text-slate-300">{fmtPct(s.revenueGrowth, 0)}</span>
              </div>
              <div className="mt-0.5 flex items-baseline justify-between">
                <span className="text-[10px] text-slate-400">P/S 中位</span>
                <span className="num text-[12px] text-slate-600 dark:text-slate-300">{fmtX(s.psMedian)}</span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[10px] text-slate-400">估值分位</span>
                <PctBar value={s.percentileMedian} />
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* 公司层 */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] tracking-[0.12em] text-slate-400">逐家公司</p>
          <div className="flex items-center gap-1.5 text-[10.5px]">
            <span className="text-slate-400">排序</span>
            {(
              [
                ['percentile', '估值分位'],
                ['ps', 'P/S'],
                ['growth', '营收增速'],
              ] as [typeof sortBy, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setSortBy(k)}
                className={`rounded-full px-2 py-0.5 transition ${
                  sortBy === k
                    ? 'bg-[var(--accent)] text-white'
                    : 'border border-[var(--line)] text-slate-500 hover:border-slate-400 dark:text-slate-400'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[720px] text-[11px]">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1.5 pr-2 text-left font-normal">公司</th>
                <th className="py-1.5 px-1.5 text-left font-normal">板块</th>
                <th className="py-1.5 px-1.5 text-right font-normal">营收</th>
                <th className="py-1.5 px-1.5 text-right font-normal">增速</th>
                <th className="py-1.5 px-1.5 text-right font-normal">净利率</th>
                <th className="py-1.5 px-1.5 text-right font-normal">市值</th>
                <th className="py-1.5 px-1.5 text-right font-normal">P/S</th>
                <th className="py-1.5 pl-1.5 text-left font-normal">历史分位</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.symbol} className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{c.symbol}</span>
                    <span className="ml-1.5 text-[10px] text-slate-400">{c.name}</span>
                    {c.stale && <span className="ml-1 text-[10px] text-amber-500" title="最新财年超过 2 年">⚠️</span>}
                  </td>
                  <td className="py-1.5 px-1.5 text-[10.5px] text-slate-500">{c.segmentLabel}</td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-600 dark:text-slate-300">{fmtB(c.revenue)}</td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-600 dark:text-slate-300">
                    {fmtPct(c.revenueGrowth, 0)}
                  </td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-600 dark:text-slate-300">
                    {fmtPct(c.netMargin, 0)}
                  </td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-500">{fmtB(c.marketCap)}</td>
                  <td className="num py-1.5 px-1.5 text-right text-slate-700 dark:text-slate-200">{fmtX(c.ps)}</td>
                  <td className="py-1.5 pl-1.5">
                    {c.psPercentile !== null ? (
                      <PctBar value={c.psPercentile} />
                    ) : (
                      <span className="text-[10px] text-slate-400" title={c.missingValuation ?? '样本不足'}>
                        {c.missingValuation ? '未覆盖' : '样本不足'}
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400 dark:text-slate-500">
          口径：P/S = 市值 ÷ 最近一期已披露年报营收；历史分位 = 该值在自身近 5 年日频序列中的位置。
          财报来自 SEC XBRL，价格来自 FMP。分位越高＝相对自己历史越贵，与绝对倍数无关。
        </p>
      </section>
    </div>
  )
}
