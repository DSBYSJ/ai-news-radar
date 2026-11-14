import { useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MacroPoint, RiskReport, RiskBacktest } from '../types.ts'
import GaugeArc from '../components/risk/GaugeArc.tsx'
import { NarrativeSignals, NarrativeAttribution, PressureAttribution } from '../components/risk/RiskMeasurements.tsx'
import MacroCard, { type MacroCardData } from '../components/risk/MacroCard.tsx'
import MacroDrawer, { TRANSMISSION } from '../components/risk/MacroDrawer.tsx'
import HistoryLine from '../components/risk/HistoryLine.tsx'
import ScatterMatrix from '../components/risk/ScatterMatrix.tsx'
import EventRiskPanel from '../components/risk/EventRiskPanel.tsx'
import { BacktestCard, QualityBar } from '../components/risk/RiskTrust.tsx'
import { yieldCurvePoint } from '../lib/riskDisplay.ts'

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
  const [drillKey, setDrillKey] = useState<string | null>(null)
  const [backtest, setBacktest] = useState<RiskBacktest | null>(null)

  useEffect(() => {
    let alive = true
    setLoading(true)
    void Promise.all([api.risk(days), api.riskHistoryDetailed(365,days)])
      .then(([r, h]) => {
        if (!alive) return
        setReport(r); setHistory(h.items ?? []); setError(null)
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
          <section className="risk-panel score-panel"><div className="panel-heading"><h3>资本叙事占比</h3><span className="metric-code">NFI · V3</span></div>
            <p className="panel-description">融资/上市或金融追逐措辞，占了多少报道？</p>
            <GaugeArc neutral suffix="%" decimals={1} value={report.nfi?.score ?? null} label="CAPITAL ATTENTION" bandLabel={report.nfi?.score == null ? '计算条件不足' : '出版来源均衡占比'} height={145} />
            <p className="score-footnote">直接测量报道比例，交集只计一次。不是泡沫概率。</p>
            {report.nfi?.sampling&&<p className="measurement-detail-note">本次 {report.nfi.sampling.eligiblePublishers} 个合格出版源 · {report.nfi.sampling.eligibleArticles.toLocaleString()} 条去重报道。{report.nfi.reasons?.join('；')}</p>}
          </section>
          <section className="risk-panel score-panel"><div className="panel-heading"><h3>市场压力位置</h3><span className="metric-code">CRS · V3</span></div>
            <p className="panel-description">信用与股市压力，处在各自历史什么位置？</p>
            <GaugeArc neutral decimals={1} value={report.pressure?.score ?? null} label="MARKET PRESSURE" bandLabel={report.pressure?.score==null?'计算条件不足':'四项平均历史分位'} height={145} />
            <p className="score-footnote">50 是历史中间位置，不是安全线；不含新闻加分。</p>
            <p className="measurement-detail-note">共同观测：{report.pressure?.asOf??'无可用日期'}。各项需至少 252 个既往观测；计算依据见下方。</p>
          </section>
          <section className="risk-panel structure-panel"><div className="panel-heading"><h3>新闻观察项</h3><span className="metric-code">OBSERVATIONS</span></div>
            <p className="panel-description">保留原始单位，分别看事实与变化。</p>
            <NarrativeSignals data={report.nfi} />
            <p className="score-footnote">不同单位不强行叠成风险雷达，观察项不重复加分。</p>
          </section>
        </div>

        <div className="section-heading"><div><span className="section-index">02</span><h3>市场环境</h3></div><span>点击指标查看历史与传导逻辑 ↗</span></div>
        <div className="macro-grid">{macroCards.map(c => <MacroCard key={c.key} data={c} onDrill={() => setDrillKey(c.key)} />)}</div>
        {report.quality && <QualityBar quality={report.quality} />}

        <div className="section-heading"><div><span className="section-index">03</span><h3>理解分数背后的变化</h3></div><span>公式可解释 · 缺失项不补零</span></div>
        <div className="risk-analysis-grid">
          <section className="risk-panel analysis-panel"><div className="panel-heading"><h3>资本叙事，如何避免重复计数</h3><span>互斥部分相加</span></div>
            <NarrativeAttribution data={report.nfi} />
          </section>
          <section className="risk-panel analysis-panel"><div className="panel-heading"><h3>历史观察</h3><span>NFI / CRS</span></div>
            <p className="panel-description">仅展示同一 V3 口径与 {days} 天窗口。NFI 是报道占比，CRS 是平均历史分位，不能直接比较两条线的高低。</p>
            <HistoryLine points={history} height={220} />
          </section>
        </div>
        <PressureAttribution data={report.pressure} />
        {report.vulnerableEntities.length > 0 && <section className="risk-panel analysis-panel"><div className="panel-heading"><h3>实体负面信号</h3><span>{report.vulnerableEntities.length} 个实体 · 独立于宏观分数</span></div>
          <ScatterMatrix items={report.vulnerableEntities} macroPressure={report.crisis?.score ?? null} />
        </section>}
        <details className="risk-panel analysis-panel legacy-risk-archive" onToggle={e=>{
          if(e.currentTarget.open&&!backtest)void api.riskBacktest().then(setBacktest).catch(()=>{})
        }}><summary>V2 旧模型回测存档 · 不适用于当前读数</summary><p className="measurement-detail-note">以下结果来自旧公式和 Baa 信用代理，不能作为 V3 预测有效性的证明。新版当前用于描述性监测，尚无独立预测验证。</p>{backtest&&<BacktestCard data={backtest} />}</details>
        <p className="risk-disclaimer">{report.disclaimer}</p>
      </>}
      <MacroDrawer open={drillKey !== null} onClose={() => setDrillKey(null)} data={macroDrill && macroSeries ? {
        label: macroSeries.label, display: macroDrill.display, raw: macroSeries.value, percentile: macroDrill.percentile,
        asOf: macroSeries.asOf, history: macroSeries.history, yearAgo: macroSeries.yearAgo, avg200: macroSeries.avg200, high52w: macroSeries.high52w,
      } : null} transmission={drillKey === 'yieldCurve' ? '10 年期减 2 年期美债收益率；低于 0 为倒挂。按同一观测日期对齐，不能把 2Y 单独走势当成收益率曲线。倒挂是结构信号，不是确定的衰退预测。' : TRANSMISSION[drillKey ?? ''] ?? '暂无说明'} />
    </div>
  )
}
