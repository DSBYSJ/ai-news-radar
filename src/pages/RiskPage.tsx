import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { RiskReport } from '../types.ts'
import GaugeArc from '../components/risk/GaugeArc.tsx'
import NfiWaterfall from '../components/risk/NfiWaterfall.tsx'
import FactorRadar from '../components/risk/FactorRadar.tsx'
import MacroCard, { type MacroCardData } from '../components/risk/MacroCard.tsx'
import MacroDrawer, { TRANSMISSION } from '../components/risk/MacroDrawer.tsx'
import HistoryLine from '../components/risk/HistoryLine.tsx'
import ScatterMatrix from '../components/risk/ScatterMatrix.tsx'
import RiskTicker from '../components/risk/RiskTicker.tsx'
import CountUp from '../components/risk/CountUp.tsx'
import { bandOf, DISASTER_MARKS, RISK_LABEL, semanticColor } from '../components/risk/riskColors.ts'

/**
 * 风险看板（v0.27.0 展示层重构）
 *
 * 布局（宽屏三栏 → 窄屏单列）：
 *   顶部：背离跑马灯 + 4 个宏观卡片（迷你趋势 + 下钻）
 *   左侧主区：NFI 仪表盘 + CRS 仪表盘 + NFI 归因瀑布图
 *   右侧辅区：多因子雷达图 + 历史时间序列（十字准星）
 *   底部：宏观-微观交叉矩阵
 *
 * 交互：hover 瀑布/雷达的因子 → 历史折线叠加该因子的分数曲线（cross-filtering）
 */

interface HistoryPoint {
  date: string
  nfi: number | null
  crs: number | null
  factors?: Record<string, number | null>
}

/** 分位数（本地计算，避免额外请求） */
function percentileOf(value: number, history: number[]): number | null {
  const clean = history.filter((h) => Number.isFinite(h))
  if (clean.length < 30) return null
  let below = 0
  let equal = 0
  for (const h of clean) {
    if (h < value) below += 1
    else if (h === value) equal += 1
  }
  return (below + equal / 2) / clean.length
}

export default function RiskPage() {
  const [days, setDays] = useState(30)
  const [report, setReport] = useState<RiskReport | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoverFactor, setHoverFactor] = useState<string | null>(null)
  const [drillKey, setDrillKey] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([api.risk(days), api.riskHistoryDetailed(365)])
      .then(([r, h]) => {
        if (!alive) return
        setReport(r)
        setHistory((h.items ?? []) as HistoryPoint[])
        setError(null)
      })
      .catch((e) => {
        if (alive) setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [days])

  const macroCards = useMemo<MacroCardData[]>(() => {
    if (!report) return []
    const s = report.macro.series
    const mk = (
      key: string,
      label: string,
      display: string,
      spark: number[],
      raw: number,
      colorOverride?: string,
    ): MacroCardData => ({
      key,
      label,
      display,
      percentile: s[key]?.history?.length ? percentileOf(raw, s[key].history) : null,
      yearAgo: s[key]?.yearAgo ?? null,
      spark,
      raw,
      colorOverride,
    })
    return [
      mk('rates10y', '10Y 美债', `${s.rates10y?.value.toFixed(2) ?? '—'}%`, s.rates10y?.history.slice(-30) ?? [], s.rates10y?.value ?? 0),
      mk('creditSpread', '高收益 OAS', `${s.creditSpread?.value.toFixed(2) ?? '—'}%`, s.creditSpread?.history.slice(-30) ?? [], s.creditSpread?.value ?? 0),
      mk('nasdaq', '纳斯达克', s.nasdaq?.value.toFixed(0) ?? '—', s.nasdaq?.history.slice(-30) ?? [], s.nasdaq?.value ?? 0),
      mk(
        'rates2y',
        '收益率曲线',
        report.macro.inversion === null ? '—' : report.macro.inversion ? '倒挂' : '正常',
        s.rates2y?.history.slice(-30) ?? [],
        s.rates2y?.value ?? 0,
        // 语义型指标：正常=绿、倒挂=红（不按分位着色）
        semanticColor(report.macro.inversion !== true),
      ),
    ]
  }, [report])

  // 跨图联动：hover 因子 → 历史折线叠加该因子的分数曲线
  const overlay = useMemo(() => {
    if (!hoverFactor || history.length === 0) return null
    const label = report?.nfi?.factors.find((f) => f.key === hoverFactor)?.label ?? hoverFactor
    const values = history.map((h) => h.factors?.[hoverFactor] ?? null)
    if (values.every((v) => v === null || v === undefined)) return null
    return { name: `${label}（历史分）`, values, color: '#8b7cf6' }
  }, [hoverFactor, history, report])

  const macroDrill = drillKey ? macroCards.find((c) => c.key === drillKey) : null
  const macroSeries = report?.macro.series[drillKey ?? '']

  return (
    <div className="risk-page space-y-4">
      <header className="flex flex-wrap items-end justify-between gap-2">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[10px] font-medium tracking-[0.14em] text-[var(--accent)]">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--accent)]" />
            SONAR RISK TERMINAL
          </p>
          <h2 className="mt-1.5 text-[21px] font-semibold tracking-tight text-slate-900 dark:text-slate-100">
            AI 估值与危机风险
          </h2>
          <p className="mt-0.5 text-[11.5px] text-slate-500 dark:text-slate-400">
            叙事泡沫指数（NFI）用站内新闻；危机风险分（CRS）须接利率 / 信用利差 / 指数
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {[30, 60, 90].map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`rounded-lg px-2.5 py-1 text-[11px] transition ${
                days === d ? 'bg-[var(--accent)] text-white' : 'border border-white/10 text-slate-400 hover:border-white/25'
              }`}
            >
              {d} 天
            </button>
          ))}
        </div>
      </header>

      {loading && <div className="risk-panel h-48 animate-pulse rounded-xl" />}
      {error && <p className="rounded-lg bg-red-500/10 p-3 text-[12px] text-red-400">{error}</p>}

      {report && (
        <>
          <RiskTicker items={report.divergences} />

          <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
            {macroCards.map((c) => (
              <MacroCard key={c.key} data={c} onDrill={() => setDrillKey(c.key)} />
            ))}
          </div>

          <div className="grid gap-4 lg:grid-cols-3">
            {/* 左侧主区 */}
            <div className="space-y-4 lg:col-span-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <section className="risk-panel rounded-2xl p-4">
                  <p className="text-center text-[10px] tracking-[0.14em] text-slate-500">叙事泡沫指数</p>
                  <GaugeArc
                    value={report.nfi?.score ?? null}
                    label="NFI"
                    bandLabel={report.nfi ? RISK_LABEL[bandOf(report.nfi.score)] : '样本不足'}
                    sub={report.nfi ? `${report.narrative.articles.toLocaleString('en-US')} 条入库` : undefined}
                  />
                </section>

                <section className="risk-panel rounded-2xl p-4">
                  <p className="text-center text-[10px] tracking-[0.14em] text-slate-500">危机风险分</p>
                  <GaugeArc
                    value={report.crisis?.score ?? null}
                    label="CRS"
                    bandLabel={report.crisis ? RISK_LABEL[bandOf(report.crisis.score)] : '未计算'}
                    marks={DISASTER_MARKS}
                    probability={
                      report.crisis?.probability12m
                        ? { low: report.crisis.probability12m.low, high: report.crisis.probability12m.high }
                        : null
                    }
                  />
                </section>
              </div>

              <section className="risk-panel rounded-2xl p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-[11px] tracking-[0.12em] text-slate-400">NFI 归因拆解</p>
                  <p className="text-[10px] text-slate-500">hover 柱子看公式明细 · 满格柱呼吸警示</p>
                </div>
                {report.nfi && (
                  <div className="mt-2">
                    <NfiWaterfall
                      factors={report.nfi.factors.map((f) => ({
                        key: f.key,
                        label: f.label,
                        value: f.value,
                        score: f.score,
                        weight: f.weight,
                        contribution: f.score === null ? 0 : (f.score * f.weight) / 100,
                        note: f.note,
                      }))}
                      total={report.nfi.score}
                      onFactorHover={setHoverFactor}
                    />
                    <p className="num mt-1 text-[9.5px] text-slate-500">
                      各项求和{' '}
                      {(report.nfi.factors ?? [])
                        .reduce((s, f) => s + (f.score === null ? 0 : (f.score * f.weight) / 100), 0)
                        .toFixed(1)}{' '}
                      vs 总分 {report.nfi.score}
                    </p>
                  </div>
                )}
              </section>
            </div>

            {/* 右侧辅区 */}
            <div className="space-y-4">
              <section className="risk-panel rounded-2xl p-4">
                <p className="text-[11px] tracking-[0.12em] text-slate-400">多因子结构</p>
                <p className="mt-0.5 text-[10px] text-slate-500">顶破边缘 = 该因子满格，风险结构畸形</p>
                {report.nfi && (
                  <div className="mt-1">
                    <FactorRadar
                      factors={report.nfi.factors.map((f) => ({ key: f.key, label: f.label, score: f.score }))}
                      onFactorHover={setHoverFactor}
                    />
                  </div>
                )}
              </section>

              <section className="risk-panel rounded-2xl p-4">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[11px] tracking-[0.12em] text-slate-400">历史回溯</p>
                  <p className="text-[10px] text-slate-500">十字准星</p>
                </div>
                <div className="mt-2">
                  <HistoryLine
                    points={history}
                    overlay={overlay}
                    height={200}
                    events={[
                      { date: '2026-10-13', label: '项目上线' },
                      { date: '2026-10-19', label: '加源扩面' },
                    ]}
                  />
                </div>
              </section>
            </div>
          </div>

          {report.vulnerableEntities.length > 0 && (
            <section className="risk-panel rounded-2xl p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[11px] tracking-[0.12em] text-slate-400">宏观-微观风险交叉矩阵</p>
                <p className="num text-[10px] text-slate-500">
                  宏观压力 <CountUp value={report.crisis?.score ?? null} /> · {report.vulnerableEntities.length} 个实体
                </p>
              </div>
              <div className="mt-2">
                <ScatterMatrix
                  items={report.vulnerableEntities.map((v) => ({
                    entity: v.entity,
                    score: v.score,
                    mentions: v.mentions,
                    negativeShare: v.negativeShare,
                    heatChange: v.heatChange,
                    funding: v.funding,
                  }))}
                  macroPressure={report.crisis?.score ?? null}
                />
              </div>
            </section>
          )}

          <p className="border-t border-white/[0.06] pt-2.5 text-[10px] leading-relaxed text-slate-500">
            {report.disclaimer}
          </p>
        </>
      )}

      <MacroDrawer
        open={drillKey !== null}
        onClose={() => setDrillKey(null)}
        data={
          macroDrill && macroSeries
            ? {
                label: macroSeries.label,
                display: macroDrill.display,
                raw: macroSeries.value,
                percentile: macroDrill.percentile,
                asOf: macroSeries.asOf,
                history: macroSeries.history,
                yearAgo: macroSeries.yearAgo,
                avg200: macroSeries.avg200,
                high52w: macroSeries.high52w,
              }
            : null
        }
        transmission={TRANSMISSION[drillKey ?? ''] ?? '暂无该指标的传导说明。'}
      />
    </div>
  )
}
