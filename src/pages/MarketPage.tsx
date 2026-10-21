import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MarketCompanyRow, MarketOverview } from '../types.ts'
import LinkageCard from '../components/market/LinkageCard.tsx'

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
          {coverage.windowFrom && (
            <span className="text-slate-400 dark:text-slate-500">
              分位窗口 {coverage.windowFrom} ~ {coverage.windowTo}
              {coverage.windowYears !== null && `（约 ${coverage.windowYears} 年日频）`}
            </span>
          )}
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
                <span className="num text-[12px] text-slate-600 dark:text-slate-300">
                  {fmtX(s.psMedian)}
                  {/* 样本数必须跟着数字走：N=1 的"中位数"其实就是单家公司的值 */}
                  <span
                    className="ml-1 text-[9.5px] text-slate-400"
                    title={`该板块有 ${s.valuationCovered}/${s.companies} 家能算估值，中位数基于 ${s.valuationCovered} 个样本`}
                  >
                    (N={s.valuationCovered})
                  </span>
                </span>
              </div>
              <div className="mt-1 flex items-center justify-between">
                <span className="text-[10px] text-slate-400">估值分位</span>
                <span className="flex items-center gap-1">
                  <PctBar value={s.percentileMedian} />
                  <span className="text-[9.5px] text-slate-400">(N={s.valuationCovered})</span>
                </span>
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
                <th className="py-1.5 pl-1.5 text-left font-normal">
                  <span
                    className="inline-flex cursor-help items-center gap-0.5"
                    title={
                      coverage.windowFrom && coverage.windowTo
                        ? `分位 = 当前 P/S 在该标的自身历史中的位置。\n历史窗口：${coverage.windowFrom} ~ ${coverage.windowTo}（约 ${coverage.windowYears} 年日频数据，约 ${Math.round((coverage.windowYears ?? 0) * 250)} 个交易日）。\n样本不足 60 个交易日时不计算分位。`
                        : '分位 = 当前 P/S 在该标的自身历史中的位置（需 ≥60 个交易日）'
                    }
                  >
                    历史分位
                    <span className="text-[9px] text-slate-400">ⓘ</span>
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.symbol} className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2">
                    <span className="font-medium text-slate-800 dark:text-slate-100">{c.symbol}</span>
                    <span className="ml-1.5 text-[10px] text-slate-400">{c.name}</span>
                    {c.stale && <span className="ml-1 text-[10px] text-amber-500" title="最新财年超过 2 年">⚠️</span>}
                    {c.manualPrice && (
                      <span
                        className="ml-1 rounded bg-sky-100 px-1 text-[9px] text-sky-700 dark:bg-sky-500/15 dark:text-sky-300"
                        title="该价格由手工补录，不是接口数据"
                      >
                        补录
                      </span>
                    )}
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
                      <span
                        className="cursor-help text-[10px] text-slate-400 underline decoration-dotted"
                        title={c.missingValuation ?? '历史样本不足 60 个交易日，暂不计算分位'}
                      >
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
          口径：P/S = 市值 ÷ 最近一期已披露年报营收；历史分位 = 该值在自身历史日频序列中的位置
          {coverage.windowYears !== null && `（当前窗口约 ${coverage.windowYears} 年）`}。
          财报来自 SEC XBRL，价格来自 FMP。分位越高＝相对自己历史越贵，与绝对倍数无关。
        </p>
      </section>

      {/* 新闻热度 × 股价联动 */}
      <LinkageCard />

      {/* 指标选择说明：统一用 P/S 是权宜之计，必须说清它的局限 */}
      <details className="card p-4">
        <summary className="cursor-pointer text-[11px] tracking-[0.12em] text-slate-400">
          指标选择说明：为什么这里统一用 P/S，以及它的局限
        </summary>
        <div className="mt-2.5 space-y-2 text-[11px] leading-relaxed text-slate-600 dark:text-slate-300">
          <p className="text-[10.5px] text-slate-400 dark:text-slate-500">
            不同商业模式适合不同估值指标。本页统一用 P/S，是为了「同一把尺子横向比」，
            <b className="text-slate-600 dark:text-slate-300">代价是牺牲了各行业的适配性</b>：
          </p>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-[10.5px]">
              <thead>
                <tr className="text-slate-500">
                  <th className="py-1 pr-2 text-left font-normal">层级</th>
                  <th className="py-1 px-2 text-left font-normal">更合适的指标</th>
                  <th className="py-1 pl-2 text-left font-normal">为什么</th>
                </tr>
              </thead>
              <tbody>
                <tr className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-700 dark:text-slate-200">算力芯片</td>
                  <td className="py-1.5 px-2 font-medium">P/S</td>
                  <td className="py-1.5 pl-2 text-slate-500">
                    周期性强，盈利在周期底部可能接近 0，P/E 会失真甚至为负；营收更稳定
                  </td>
                </tr>
                <tr className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-700 dark:text-slate-200">云与平台</td>
                  <td className="py-1.5 px-2 font-medium">P/E 或 EV/EBITDA</td>
                  <td className="py-1.5 pl-2 text-slate-500">
                    利润稳定、资本结构复杂（大量债务与折旧），EBITDA 能剔除折旧与杠杆差异
                  </td>
                </tr>
                <tr className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-700 dark:text-slate-200">模型与应用</td>
                  <td className="py-1.5 px-2 font-medium">ARR 倍数</td>
                  <td className="py-1.5 pl-2 text-slate-500">
                    订阅制、当期常亏损（P/E 无意义），ARR 比会计营收更贴近真实增长
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[10.5px] text-amber-700 dark:text-amber-400">
            ⚠️ 因此：<b>跨板块比较 P/S 没有意义</b>（芯片的 25x 和应用的 100x 不是同一件事），
            板块内部的相对位置才有参考价值。本系统没有 ARR 数据，也没有 EV/EBITDA ——
            这两项需要更细的财报拆分，目前不做。
          </p>
          <p className="text-[10px] text-slate-400 dark:text-slate-500">
            另：P/S 高不一定贵 —— 如果毛利率与增速足够高，高 P/S 是合理的。
            这也是为什么本页把「净利率」「营收增速」和「估值分位」放在一起看，而不是单看倍数。
          </p>
        </div>
      </details>
    </div>
  )
}
