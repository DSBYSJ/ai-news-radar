import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MacroPoint, RiskReport, RiskBacktest } from '../types.ts'
import GaugeArc from '../components/risk/GaugeArc.tsx'
import NfiWaterfall from '../components/risk/NfiWaterfall.tsx'
import FactorRadar from '../components/risk/FactorRadar.tsx'
import MacroCard, { type MacroCardData } from '../components/risk/MacroCard.tsx'
import MacroDrawer, { TRANSMISSION } from '../components/risk/MacroDrawer.tsx'
import HistoryLine from '../components/risk/HistoryLine.tsx'
import ScatterMatrix from '../components/risk/ScatterMatrix.tsx'
import RiskTicker from '../components/risk/RiskTicker.tsx'
import EventRiskPanel from '../components/risk/EventRiskPanel.tsx'
import { BacktestCard, QualityBar, SubIndexRow } from '../components/risk/RiskTrust.tsx'
import { bandOf, RISK_LABEL } from '../components/risk/riskColors.ts'
import { nfiContributions, yieldCurvePoint } from '../lib/riskDisplay.ts'

interface HistoryPoint { date: string; nfi: number | null; crs: number | null; factors?: Record<string, number | null> }
function percentileOf(value: number, history: number[]): number | null {
  const clean = history.filter(Number.isFinite)
  if (clean.length < 30) return null
  return (clean.filter(x => x < value).length + clean.filter(x => x === value).length / 2) / clean.length
}

export default function RiskPage() {
  const [days, setDays] = useState(30)
  const [revision, setRevision] = useState(0)
  const [report, setReport] = useState<RiskReport | null>(null)
  const [history, setHistory] = useState<HistoryPoint[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [hoverFactor, setHoverFactor] = useState<string | null>(null)
  const [drillKey, setDrillKey] = useState<string | null>(null)
  const [backtest, setBacktest] = useState<RiskBacktest | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([api.risk(days), api.riskHistoryDetailed(365), api.riskBacktest().catch(() => null)])
      .then(([r, h, bt]) => {
        if (!alive) return
        setReport(r); setHistory(h.items ?? []); setBacktest(bt); setError(null)
      }).catch(e => { if (alive) setError(e instanceof Error ? e.message : String(e)) })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
  }, [days, revision])

  const curve = useMemo(() => report ? yieldCurvePoint(report.macro.series.rates10y, report.macro.series.rates2y) : null, [report])
  const macroCards = useMemo<MacroCardData[]>(() => {
    if (!report) return []
    const series = report.macro.series
    const mk = (key: string, label: string, p?: MacroPoint, isIndex = false): MacroCardData => ({
      key, label, display: p ? isIndex ? p.value.toLocaleString('en-US', { maximumFractionDigits: 0 }) : `${p.value.toFixed(2)}%` : '—',
      percentile: p ? percentileOf(p.value, p.history) : null,
      yearAgo: p?.yearAgo ?? null, spark: p?.history.slice(-30) ?? [], raw: p?.value ?? 0,
      asOf: p?.asOf, unit: isIndex ? 'percent' : 'pp', colorOverride: isIndex ? 'var(--accent)' : undefined,
    })
    return [mk('rates10y', '10Y 美债收益率', series.rates10y), mk('creditSpread', '高收益债信用利差', series.creditSpread),
      mk('nasdaq', '纳斯达克综合指数', series.nasdaq, true), {
        key: 'yieldCurve', label: '收益率曲线 · 10Y − 2Y', display: curve ? `${curve.value >= 0 ? '+' : ''}${curve.value.toFixed(2)}pp` : '—',
        percentile: null, yearAgo: curve?.yearAgo ?? null, spark: curve?.history.slice(-30) ?? [], raw: curve?.value ?? 0,
        colorOverride: curve ? curve.value >= 0 ? 'var(--risk-calm)' : 'var(--risk-critical)' : 'var(--ink-muted)', asOf: curve?.asOf, unit: 'pp',
      }]
  }, [report, curve])
  const overlay = useMemo(() => {
    if (!hoverFactor || history.length === 0) return null
    const values = history.map(h => h.factors?.[hoverFactor] ?? null)
    if (values.every(v => v === null)) return null
    return { name: report?.nfi?.factors.find(f => f.key === hoverFactor)?.label ?? hoverFactor, values, color: '#9b8cde' }
  }, [hoverFactor, history, report])
  const contributions = report?.nfi ? nfiContributions(report.nfi.factors) : []
  const macroDrill = macroCards.find(c => c.key === drillKey)
  const macroSeries = drillKey === 'yieldCurve' ? curve : report?.macro.series[drillKey ?? '']

  return (
    <div className="risk-page">
      <header className="risk-page-header">
        <div><p className="eyebrow">RISK INTELLIGENCE <span className="eyebrow-rule" /></p><h2>把风险，看得更清楚<span className="heading-dot">.</span></h2>
          <p className="page-description">先识别事件，再观察叙事与市场。让每一条预警，都有依据可循。</p></div>
        <div className="risk-header-tools">
          <div className="range-switch" aria-label="叙事观察窗口">{[30, 60, 90].map(d => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{d} 天</button>)}</div>
          <button className="risk-refresh" type="button" aria-label="刷新风险数据" disabled={loading} onClick={() => setRevision(r => r + 1)}><span className={loading ? 'animate-spin' : ''}>↻</span></button>
        </div>
      </header>
      {loading && !report && <div className="risk-panel risk-loading animate-pulse" aria-label="正在读取风险数据" />}
      {error && <p className="risk-error" role="alert">读取失败：{error}{report ? '。下方保留上次结果，请刷新后再判断。' : ''}</p>}
      {report && <>
        {report.eventRisk && <EventRiskPanel data={report.eventRisk} assessment={report.assessment} />}

        <div className="section-heading"><div><span className="section-index">01</span><h3>叙事与市场，分开解读</h3></div><span>叙事窗口 {days} 天 · 事件窗口固定 7 天</span></div>
        <div className="risk-score-grid">
          <section className="risk-panel score-panel"><div className="panel-heading"><h3>叙事泡沫</h3><span className="metric-code">NFI</span></div>
            <p className="panel-description">融资与追高情绪，是否正在升温？</p>
            <GaugeArc value={report.nfi?.score ?? null} label="NARRATIVE FROTH" bandLabel={report.nfi?.score == null ? '样本不足' : RISK_LABEL[bandOf(report.nfi.score)]} height={145} />
            <p className="score-footnote">负面事件可能使泡沫分下降，低分不代表公司安全。</p>
          </section>
          <section className="risk-panel score-panel"><div className="panel-heading"><h3>宏观压力</h3><span className="metric-code">CRS</span></div>
            <p className="panel-description">信用环境与市场走势，是否承压？</p>
            <GaugeArc value={report.crisis?.score ?? null} label="MACRO PRESSURE" bandLabel={report.crisis ? RISK_LABEL[bandOf(report.crisis.score)] : '核心数据不足'} height={145} />
            <p className="score-footnote">宏观数据存在发布滞后，不能替代公司事件预警。</p>
          </section>
          <section className="risk-panel structure-panel"><div className="panel-heading"><h3>信号结构</h3><span className="metric-code">FACTORS</span></div>
            <p className="panel-description">哪些因子正在推动叙事温度？</p>
            {report.nfi && <FactorRadar factors={report.nfi.factors.map(f => ({ key: f.key, label: f.label, score: f.score }))} onFactorHover={setHoverFactor} />}
            <p className="score-footnote">结构分布用于解释，不作为独立预测结论。</p>
          </section>
        </div>

        <div className="section-heading"><div><span className="section-index">02</span><h3>市场环境</h3></div><span>点击指标查看历史与传导逻辑 ↗</span></div>
        <div className="macro-grid">{macroCards.map(c => <MacroCard key={c.key} data={c} onDrill={() => setDrillKey(c.key)} />)}</div>
        <RiskTicker items={report.divergences} />
        {report.quality && <QualityBar quality={report.quality} />}

        <div className="section-heading"><div><span className="section-index">03</span><h3>理解分数背后的变化</h3></div><span>公式可解释 · 缺失项不补零</span></div>
        <div className="risk-analysis-grid">
          <section className="risk-panel analysis-panel"><div className="panel-heading"><h3>叙事归因</h3><span>按有效权重归一</span></div>
            <p className="panel-description">悬停因子，查看贡献与计算口径。</p>
            {report.nfi && <NfiWaterfall factors={contributions} total={report.nfi.score} onFactorHover={setHoverFactor} />}
          </section>
          <section className="risk-panel analysis-panel"><div className="panel-heading"><h3>历史观察</h3><span>NFI / CRS</span></div>
            <p className="panel-description">历史曲线保留各自含义，事件冲击单独观察。</p>
            <HistoryLine points={history} overlay={overlay} height={220} />
          </section>
        </div>
        {report.subIndices && <SubIndexRow subIndices={report.subIndices} />}
        {report.vulnerableEntities.length > 0 && <section className="risk-panel analysis-panel"><div className="panel-heading"><h3>实体负面信号</h3><span>{report.vulnerableEntities.length} 个实体 · 独立于宏观分数</span></div>
          <ScatterMatrix items={report.vulnerableEntities} macroPressure={report.crisis?.score ?? null} />
        </section>}
        {backtest && <BacktestCard data={backtest} />}
        <p className="risk-disclaimer">{report.disclaimer}</p>
      </>}
      <MacroDrawer open={drillKey !== null} onClose={() => setDrillKey(null)} data={macroDrill && macroSeries ? {
        label: macroSeries.label, display: macroDrill.display, raw: macroSeries.value, percentile: macroDrill.percentile,
        asOf: macroSeries.asOf, history: macroSeries.history, yearAgo: macroSeries.yearAgo, avg200: macroSeries.avg200, high52w: macroSeries.high52w,
      } : null} transmission={drillKey === 'yieldCurve' ? '10 年期减 2 年期美债收益率；低于 0 为倒挂。按同一观测日期对齐，不能把 2Y 单独走势当成收益率曲线。倒挂是结构信号，不是确定的衰退预测。' : TRANSMISSION[drillKey ?? ''] ?? '暂无说明'} />
    </div>
  )
}
