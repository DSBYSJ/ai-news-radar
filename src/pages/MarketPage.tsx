import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MarketCompanyRow, MarketOverview } from '../types.ts'
import LinkageCard from '../components/market/LinkageCard.tsx'
import MarketStatusBar from '../components/market/MarketStatusBar.tsx'
import { PsTrendCell } from '../components/market/PsSparkline.tsx'

/**
 * AI 资产估值看板（v0.45.0 重做）
 *
 * 之前的问题：① 行情停在三周前却毫无提示 ② 没有刷新入口
 * ③ 满屏灰底表格，看不出"结论"，只能自己一行行读。
 *
 * 现在的顺序：**先给结论 → 再给板块 → 最后给明细**
 *   1. 数据新不新（状态条 + 立即刷新）
 *   2. 现在贵不贵（四个结论数：中位 / 最贵 / 最便宜 / 板块分化）
 *   3. 贵在哪一层（板块卡，可点击筛选）
 *   4. 具体是谁（明细表 + 每家的 P/S 历史走向）
 *
 * 两条边界仍写在页面上：
 *   · 估值回答"贵不贵"，不回答"会不会崩"（危机概率在风险模块）
 *   · FMP 免费档只覆盖部分标的，未覆盖的显式标注原因
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

/** 分位越高越贵：≥80 红、60–80 橙、≤30 绿 */
function tone(p: number | null): { color: string; label: string } {
  if (p === null) return { color: '#94a3b8', label: '—' }
  if (p >= 0.8) return { color: '#e5484d', label: '偏贵' }
  if (p >= 0.6) return { color: '#f5a623', label: '中上' }
  if (p <= 0.3) return { color: '#22c55e', label: '便宜' }
  return { color: '#64748b', label: '中位' }
}

/** 分位条（比原来宽一点，带刻度感） */
function PctBar({ value, width = 64 }: { value: number | null; width?: number }) {
  if (value === null) return <span className="text-[10px] text-slate-400">—</span>
  const { color } = tone(value)
  return (
    <div className="flex items-center gap-1.5">
      <div className="relative h-1.5 overflow-hidden rounded-full bg-slate-200 dark:bg-white/10" style={{ width }}>
        <div className="h-full rounded-full" style={{ width: `${Math.max(3, value * 100)}%`, background: color }} />
        {/* 50% 刻度：让"高于/低于历史中位"一眼可辨 */}
        <span className="absolute inset-y-0 left-1/2 w-px bg-white/60 dark:bg-black/30" />
      </div>
      <span className="num text-[10.5px] font-medium" style={{ color }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null
  const s = [...values].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid]
}

export default function MarketPage() {
  const [data, setData] = useState<MarketOverview | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [sortBy, setSortBy] = useState<'percentile' | 'ps' | 'growth'>('percentile')
  const [segment, setSegment] = useState<string | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const d = await api.marketOverview()
    setData(d)
    setError(null)
  }, [])

  useEffect(() => {
    let alive = true
    void api
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
    const list = data.companies.filter((c) => !segment || c.segment === segment)
    if (sortBy === 'percentile') {
      // 分位未知的排最后（不能当成 0 混进"便宜"那一档）
      list.sort((a, b) => (b.psPercentile ?? -1) - (a.psPercentile ?? -1))
    } else if (sortBy === 'ps') {
      list.sort((a, b) => (b.ps ?? -1) - (a.ps ?? -1))
    } else {
      list.sort((a, b) => (b.revenueGrowth ?? -999) - (a.revenueGrowth ?? -999))
    }
    return list
  }, [data, sortBy, segment])

  if (loading) return <div className="card h-48 animate-pulse rounded-xl" />
  if (error) return <p className="rounded-lg bg-red-50 p-3 text-sm text-red-600 dark:bg-red-950/40 dark:text-red-400">{error}</p>
  if (!data) return null

  const { coverage, segments, companies } = data

  // ---- 四个结论数 ----
  const valued = companies.filter((c) => c.ps !== null)
  const psMedian = medianOf(valued.map((c) => c.ps as number))
  const pctileMedian = medianOf(valued.map((c) => c.psPercentile).filter((v): v is number => v !== null))
  const ranked = valued
    .filter((c) => c.psPercentile !== null)
    .sort((a, b) => (b.psPercentile ?? 0) - (a.psPercentile ?? 0))
  const topExpensive = ranked.slice(0, 2)
  const cheapest = [...ranked].reverse().slice(0, 2)
  const segMedians = segments.map((s) => s.psMedian).filter((v): v is number => v !== null)
  const spread = segMedians.length >= 2 ? Math.max(...segMedians) / Math.min(...segMedians) : null

  return (
    <div className="space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-[19px] font-semibold tracking-[-0.02em] text-slate-900 dark:text-slate-50">
            <span className="inline-block h-4 w-[3px] rounded-full bg-gradient-to-b from-emerald-500 to-teal-500" />
            AI 资产估值
          </h2>
          <p className="mt-1 text-[12px] text-slate-500 dark:text-slate-400">
            用 P/S 的<b className="font-medium text-slate-600 dark:text-slate-300">自身历史分位</b>
            回答"现在贵不贵"——绝对倍数没有意义，位置才有。
          </p>
        </div>
      </header>

      {/* 数据状态 + 刷新 */}
      <MarketStatusBar data={data} onRefreshed={load} />

      {/* 四个结论数 */}
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <div className="card p-3">
          <p className="text-[10px] tracking-[0.1em] text-slate-400">全样本 P/S 中位</p>
          <p className="num mt-1 text-[24px] font-semibold leading-none text-slate-800 dark:text-slate-100">
            {fmtX(psMedian)}
          </p>
          <p className="num mt-1 text-[10px] text-slate-400">
            分位中位 {pctileMedian === null ? '—' : `${Math.round(pctileMedian * 100)}%`} · N={valued.length}
          </p>
        </div>

        <div className="card p-3">
          <p className="text-[10px] tracking-[0.1em] text-slate-400">最贵</p>
          <p className="mt-1 text-[15px] font-semibold leading-tight text-slate-800 dark:text-slate-100">
            {topExpensive.map((c) => c.symbol).join(' · ') || '—'}
          </p>
          <p className="num mt-1 text-[10px]" style={{ color: tone(topExpensive[0]?.psPercentile ?? null).color }}>
            {topExpensive.length > 0
              ? `${fmtX(topExpensive[0].ps)} · 历史 ${Math.round((topExpensive[0].psPercentile ?? 0) * 100)}% 分位`
              : '样本不足'}
          </p>
        </div>

        <div className="card p-3">
          <p className="text-[10px] tracking-[0.1em] text-slate-400">最便宜</p>
          <p className="mt-1 text-[15px] font-semibold leading-tight text-slate-800 dark:text-slate-100">
            {cheapest.map((c) => c.symbol).join(' · ') || '—'}
          </p>
          <p className="num mt-1 text-[10px]" style={{ color: tone(cheapest[0]?.psPercentile ?? null).color }}>
            {cheapest.length > 0
              ? `${fmtX(cheapest[0].ps)} · 历史 ${Math.round((cheapest[0].psPercentile ?? 0) * 100)}% 分位`
              : '样本不足'}
          </p>
        </div>

        <div className="card p-3">
          <p className="text-[10px] tracking-[0.1em] text-slate-400">板块分化</p>
          <p className="num mt-1 text-[24px] font-semibold leading-none text-slate-800 dark:text-slate-100">
            {spread === null ? '—' : `${spread.toFixed(1)}×`}
          </p>
          <p className="mt-1 text-[10px] text-slate-400">
            {spread === null ? '板块样本不足' : '最贵板块中位 ÷ 最便宜板块中位'}
          </p>
        </div>
      </div>

      {/* 板块层（可点击筛选） */}
      <section className="card p-4">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="text-[11px] tracking-[0.12em] text-slate-400">按板块看：贵在哪一层</p>
          <p className="text-[10px] text-slate-500">
            点卡片筛选下方明细 · 板块内等权中位数
            {segment && (
              <button
                type="button"
                onClick={() => setSegment(null)}
                className="ml-2 rounded-full border border-[var(--line)] px-1.5 py-0.5 text-[9.5px] text-slate-500 hover:border-slate-400"
              >
                ✕ 清除筛选
              </button>
            )}
          </p>
        </div>

        <div className="mt-2.5 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
          {segments.map((s) => {
            const active = segment === s.segment
            const t = tone(s.percentileMedian)
            return (
              <button
                key={s.segment}
                type="button"
                onClick={() => setSegment(active ? null : s.segment)}
                className={`rounded-xl border p-3 text-left transition ${
                  active
                    ? 'border-[var(--accent)] bg-[var(--accent)]/[0.06]'
                    : 'border-transparent bg-slate-50/80 hover:bg-slate-100/80 dark:bg-white/[0.03] dark:hover:bg-white/[0.06]'
                }`}
              >
                <div className="flex items-baseline justify-between">
                  <span className="text-[11.5px] font-medium text-slate-700 dark:text-slate-200">{s.label}</span>
                  <span className="num text-[9.5px] text-slate-400">
                    {s.valuationCovered}/{s.companies}
                  </span>
                </div>

                <div className="mt-1.5 flex items-baseline gap-1.5">
                  <span className="num text-[20px] font-semibold leading-none" style={{ color: t.color }}>
                    {fmtX(s.psMedian)}
                  </span>
                  <span className="text-[9.5px] text-slate-400">P/S 中位</span>
                </div>

                <div className="mt-2">
                  <PctBar value={s.percentileMedian} width={78} />
                </div>

                <div className="num mt-2 flex items-center gap-2.5 text-[10px] text-slate-500">
                  <span>净利率 {fmtPct(s.netMargin, 0)}</span>
                  <span>增速 {fmtPct(s.revenueGrowth, 0)}</span>
                </div>
              </button>
            )
          })}
        </div>
      </section>

      {/* 公司层 */}
      <section className="card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-[11px] tracking-[0.12em] text-slate-400">
            逐家公司
            {segment && (
              <span className="ml-2 rounded-full bg-[var(--accent)]/10 px-2 py-0.5 text-[10px] text-[var(--accent)]">
                {segments.find((s) => s.segment === segment)?.label ?? segment}
              </span>
            )}
          </p>
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
          <table className="w-full min-w-[880px] text-[11px]">
            <thead>
              <tr className="text-slate-500">
                <th className="py-1.5 pr-2 text-left font-normal">公司</th>
                <th className="py-1.5 px-1.5 text-left font-normal">板块</th>
                <th className="py-1.5 px-1.5 text-right font-normal">营收</th>
                <th className="py-1.5 px-1.5 text-right font-normal">增速</th>
                <th className="py-1.5 px-1.5 text-right font-normal">净利率</th>
                <th className="py-1.5 px-1.5 text-right font-normal">市值</th>
                <th className="py-1.5 px-1.5 text-right font-normal">P/S</th>
                <th className="py-1.5 px-1.5 text-left font-normal">
                  <span
                    className="inline-flex cursor-help items-center gap-0.5"
                    title={
                      coverage.windowFrom && coverage.windowTo
                        ? `分位 = 当前 P/S 在该标的自身历史中的位置。\n历史窗口：${coverage.windowFrom} ~ ${coverage.windowTo}（约 ${coverage.windowYears} 年日频，约 ${Math.round((coverage.windowYears ?? 0) * 250)} 个交易日）。\n样本不足 60 个交易日时不计算分位。`
                        : '分位 = 当前 P/S 在该标的自身历史中的位置（需 ≥60 个交易日）'
                    }
                  >
                    历史分位 <span className="text-[9px] text-slate-400">ⓘ</span>
                  </span>
                </th>
                <th className="py-1.5 pl-1.5 text-right font-normal">倍数走势（财年）</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => {
                const noPrice = c.points === 0
                return (
                  <tr
                    key={c.symbol}
                    className={`border-t border-slate-100 dark:border-white/[0.06] ${noPrice ? 'opacity-60' : ''}`}
                  >
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
                    <td className="py-1.5 px-1.5">
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
                    <td className="py-1.5 pl-1.5">
                      <div className="flex justify-end">
                        <PsTrendCell points={c.psHistory} />
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <p className="mt-2.5 text-[10px] leading-relaxed text-slate-400 dark:text-slate-500">
          口径：P/S = 市值 ÷ 最近一期已披露年报营收；历史分位 = 该值在自身历史日频序列中的位置
          {coverage.windowYears !== null && `（当前窗口约 ${coverage.windowYears} 年）`}。
          财报来自 SEC XBRL，价格来自 FMP；「倍数走势」按财年（2–8 个点）。分位越高＝相对自己历史越贵。
        </p>
      </section>

      <LinkageCard />

      <details className="card p-4">
        <summary className="cursor-pointer text-[11px] tracking-[0.12em] text-slate-400">
          指标选择说明：为什么统一用 P/S，以及它的局限
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
                  <td className="py-1.5 pl-2 text-slate-500">周期性强，盈利在周期底部可能接近 0，P/E 会失真甚至为负</td>
                </tr>
                <tr className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-700 dark:text-slate-200">云与平台</td>
                  <td className="py-1.5 px-2 font-medium">P/E 或 EV/EBITDA</td>
                  <td className="py-1.5 pl-2 text-slate-500">利润稳定、资本结构复杂，EBITDA 能剔除折旧与杠杆差异</td>
                </tr>
                <tr className="border-t border-slate-100 dark:border-white/[0.06]">
                  <td className="py-1.5 pr-2 text-slate-700 dark:text-slate-200">模型与应用</td>
                  <td className="py-1.5 px-2 font-medium">ARR 倍数</td>
                  <td className="py-1.5 pl-2 text-slate-500">订阅制、当期常亏损，ARR 比会计营收更贴近真实增长</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p className="text-[10.5px] text-amber-700 dark:text-amber-400">
            ⚠️ 因此：<b>跨板块比较 P/S 没有意义</b>（芯片的 25x 和应用的 100x 不是同一件事），
            板块内部的相对位置才有参考价值。本系统没有 ARR 数据，也没有 EV/EBITDA。
          </p>
          <p className="text-[10px] text-slate-400 dark:text-slate-500">
            另：P/S 高不一定贵 —— 如果毛利率与增速足够高，高 P/S 是合理的。
            这也是为什么本页把「净利率」「营收增速」和「估值分位」放在一起看。
          </p>
        </div>
      </details>
    </div>
  )
}
