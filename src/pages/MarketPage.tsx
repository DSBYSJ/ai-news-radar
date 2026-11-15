import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MarketCompanyRow, MarketOverview } from '../types.ts'
import MarketStatusBar from '../components/market/MarketStatusBar.tsx'
import LinkageCard from '../components/market/LinkageCard.tsx'

const multiple = (v: number | null) => v === null ? '—' : `${v.toFixed(1)}×`
const percent = (v: number | null) => v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
const rank = (v: number | null) => v === null ? '—' : `${Math.round(v*100)}%`
const money = (v: number | null) => v === null ? '—' : Math.abs(v)>=1e12 ? `${(v/1e12).toFixed(2)}T` : `${(v/1e9).toFixed(1)}B`
const STATE = { ready:'可核对参照', limited:'有限参照', blocked:'待核验', unavailable:'暂无行情' }

function PositionBar({ value }: { value: number | null }) {
  return <span className="valuation-position" data-band={value === null ? 'unknown' : value >= 80 ? 'high' : value <= 20 ? 'low' : 'middle'}>
    <span className="valuation-position-track"><span style={{width:`${value??0}%`}} /><i /></span>
    <strong className="num">{value === null ? '—' : value}<small>分位</small></strong>
  </span>
}
function CompanyDetail({ c }: { c: MarketCompanyRow }) {
  return <div className="valuation-detail" role="region" aria-label={`${c.symbol} 计算依据`}>
    <div><h4>当前倍数，用了什么资料</h4><dl className="valuation-basis">
      <div><dt>价格 / 日期</dt><dd className="num">{c.close===null?'—':`$${c.close.toFixed(2)}`} · {c.priceDate??'无行情'}{c.manualPrice?' · 手工补录':''}</dd></div>
      <div><dt>期间截至 / 申报日</dt><dd className="num">{c.fiscalEnd??'—'} / {c.filedAt??'—'}</dd></div>
      <div><dt>股本观测 / 拆股因子</dt><dd className="num">{c.basis?.sharesAsOf??'待核验'} / {c.basis?.splitFactor.toFixed(2)??'—'}×</dd></div>
      <div><dt>估算市值</dt><dd className="num">{money(c.marketCap)} USD</dd></div>
    </dl><p className="valuation-formula">P/S = 同口径估算市值 ÷ 期间营收；P/E = 同一市值 ÷ 期间净利润。当前口径：{c.financial?.kind==='ttm'?'近十二个月 TTM':'已披露年报'}。</p></div>
    <div><h4>相对位置，为什么是这个结果</h4><dl className="valuation-basis">
      <div><dt>P/S 月末历史分位</dt><dd className="num">{rank(c.psPercentile)} · {c.historyMonths} 个月</dd></div>
      <div><dt>P/E 月末历史分位</dt><dd className="num">{c.netIncome!==null&&c.netIncome<=0?'亏损，不适用':`${rank(c.pePercentile)} · ${c.peMonths} 个月`}</dd></div>
      <div><dt>P/S 参考区间</dt><dd className="num">{c.historyFrom??'—'} ~ {c.historyUntil??'—'}</dd></div>
      <div><dt>P/E 参考区间</dt><dd className="num">{c.peHistoryFrom??'—'} ~ {c.peHistoryUntil??'—'}</dd></div>
      <div><dt>P/S 中间 50% 历史区间</dt><dd className="num">{c.psRange?c.psRange.map(multiple).join(' – '):'—'}</dd></div>
      <div><dt>P/E 中间 50% 历史区间</dt><dd className="num">{c.peRange?c.peRange.map(multiple).join(' – '):'—'}</dd></div>
      <div><dt>同层 P/S 参照</dt><dd>{c.peerPercentile===null?`样本不足 · 另有 ${c.peerCount} 家`:`${rank(c.peerPercentile)} 分位 · 另有 ${c.peerCount} 家`}</dd></div>
    </dl><p className="valuation-formula">两项分位分别衡量，不再混成总分。历史仅比较相同 TTM / 年报口径；亏损月份不进入 P/E 分布，低分位不等于低估。</p></div>
    {c.financial&&<div className="filing-ledger"><h4>从原始申报，复算当前分母 <span>{c.financial.kind==='ttm'?'TTM':'年报'} · USD</span></h4>
      <div className="filing-totals"><span>期间营收 <strong className="num">{money(c.revenue)}</strong></span><span>期间净利润 <strong className="num">{money(c.netIncome)}</strong></span></div>
      {c.financial.components.map(part=><div className="filing-source" key={part.operation}>
        <span className="filing-operation">{part.operation==='annual'?'全年':part.operation==='add'?'+ 本期累计':'− 上年同期'}</span>
        <div><a href={part.revenue.url} target="_blank" rel="noreferrer">{part.revenue.form} · {part.revenue.start} — {part.revenue.end} ↗</a><small>申报 {part.revenue.filed} · {part.revenue.tag}</small></div>
        <span className="num">营收 {money(part.revenue.value)}<small>净利 {money(part.netIncome?.value??null)}</small></span>
      </div>)}
      {c.financial.shares&&<p className="filing-share-source">股本来源：<a href={c.financial.shares.url} target="_blank" rel="noreferrer">{c.financial.shares.form} · 观测 {c.financial.shares.end} ↗</a> · {c.financial.shares.value.toLocaleString()} 股。报价来自 FMP，股本调整后与其拆股复权基准配对。</p>}
    </div>}
    <div className="valuation-detail-notes"><h4>资料与边界</h4>{c.reasons.length ? c.reasons.map(reason=><p key={reason}>· {reason}</p>) : <p>当前资料通过口径核验；历史参考不保证未来均值回归。</p>}<p>拆股核验：{c.splitCheckedAt?.slice(0,10)??'尚未核验'}。不同商业模式、利润率和增长阶段仍需单独判断。</p></div>
  </div>
}

export default function MarketPage() {
  const [data,setData]=useState<MarketOverview|null>(null), [error,setError]=useState<string|null>(null)
  const [loading,setLoading]=useState(true), [segment,setSegment]=useState('all')
  const [sort,setSort]=useState<'psPercentile'|'pePercentile'|'revenueGrowth'|'netMargin'>('psPercentile')
  const [metric,setMetric]=useState<'ps'|'pe'>('ps'),[query,setQuery]=useState('')
  const [onlyValued,setOnlyValued]=useState(false), [expanded,setExpanded]=useState<string|null>(null)
  const load=useCallback(async()=>{const value=await api.marketOverview();setData(value);setError(null)},[])
  useEffect(()=>{let alive=true;void api.marketOverview().then(value=>{if(alive)setData(value)}).catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[])
  const companies=useMemo(()=>data?.companies.filter(c=>(segment==='all'||c.segment===segment)&&(!onlyValued||c[metric]!==null)&&(!query||`${c.symbol} ${c.name}`.toLowerCase().includes(query.toLowerCase())))
    .sort((a,b)=>(b[sort]??-Infinity)-(a[sort]??-Infinity)||a.symbol.localeCompare(b.symbol))??[],[data,segment,onlyValued,sort,metric,query])
  if(loading)return <div className="card h-72 animate-pulse" />
  if(error)return <p className="risk-error" role="alert">{error}</p>
  if(!data)return null
  const high=data.companies.filter(c=>c[metric==='ps'?'psPercentile':'pePercentile']!==null&&c[metric==='ps'?'psPercentile':'pePercentile']!>=.8).length
  return <div className="market-page">
    <header className="risk-page-header"><div><p className="eyebrow">VALUATION INTELLIGENCE <span className="eyebrow-rule" /></p><h2>从财报出发，读懂价格<span className="heading-dot">.</span></h2>
      <p className="page-description">每一个倍数，都有期间与来源。以可复算的事实，观察价格背后的预期。</p></div><span className="market-model-badge">财报证据模型 · V3</span></header>
    <MarketStatusBar data={data} onRefreshed={load} />
    <div className="valuation-summary-grid">{[
      {label:'当前可计算',value:`${data.coverage.valued}/${data.coverage.total}`,note:'已检查股本、拆股与资料时效'},
      {label:'具备历史参照',value:String(data.coverage.referenced),note:'至少 24 个有效月末样本'},
      {label:'处于自身历史高位',value:String(high),note:`${metric.toUpperCase().replace('P','P/')} 分位 ≥80%；不是买卖信号`},
      {label:'资料需要补齐',value:String(data.coverage.total-data.coverage.valued),note:'保留空值与原因，不以零替代'},
    ].map(item=><section className="card valuation-summary" key={item.label}><p>{item.label}</p><strong className="num">{item.value}</strong><span>{item.note}</span></section>)}</div>
    <section className="valuation-context"><div className="eyebrow">READ THE CONTEXT</div><h3>相对位置，是参照，不是公允价值。</h3><p>优先使用近十二个月财务数据；无法配齐时明确使用年报。P/S 看收入定价，P/E 看盈利定价，分别展示自身历史分布。亏损或资料缺失保留空白。</p></section>
    <section className="card valuation-workspace">
      <div className="valuation-workspace-heading"><div><p className="eyebrow">COMPANY WORKSPACE</p><h3>逐家公司，看清估值依据</h3></div><span>{companies.length} 家 · 点击行展开口径</span></div>
      <div className="valuation-focus-controls"><div className="range-switch" aria-label="估值观察指标"><button type="button" aria-pressed={metric==='ps'} onClick={()=>{setMetric('ps');setSort('psPercentile')}}>P/S · 收入定价</button><button type="button" aria-pressed={metric==='pe'} onClick={()=>{setMetric('pe');setSort('pePercentile')}}>P/E · 盈利定价</button></div><input aria-label="搜索估值公司" placeholder="搜索公司或代码…" value={query} onChange={e=>setQuery(e.target.value)} /></div>
      <div className="valuation-controls"><div className="valuation-segments"><button type="button" aria-pressed={segment==='all'} onClick={()=>setSegment('all')}>全部板块</button>{data.segments.map(s=><button key={s.segment} type="button" aria-pressed={segment===s.segment} onClick={()=>setSegment(s.segment)}>{s.label}<small>{s.valuationCovered}/{s.companies}</small></button>)}</div>
        <div className="valuation-secondary-controls"><label><input type="checkbox" checked={onlyValued} onChange={e=>setOnlyValued(e.target.checked)} />只看可估值</label><label>排序<select value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="psPercentile">P/S 历史分位</option><option value="pePercentile">P/E 历史分位</option><option value="revenueGrowth">营收增长</option><option value="netMargin">净利率</option></select></label></div>
      </div>
      <div className="valuation-list-heading"><span>公司 / 产业位置</span><span>当前财报倍数</span><span>{metric==='ps'?'P/S':'P/E'} 自身历史位置</span><span>增长 / 盈利质量</span><span>资料状态</span><span /></div>
      <div className="valuation-company-list">{companies.map(c=><div key={c.symbol} className="valuation-company" data-expanded={expanded===c.symbol}>
        <button type="button" className="valuation-company-row" aria-expanded={expanded===c.symbol} onClick={()=>setExpanded(expanded===c.symbol?null:c.symbol)}>
          <span className="valuation-company-name"><strong>{c.symbol}<small>{c.name}</small></strong><span>{c.role}</span><em className="financial-period-tag">{c.financial?`${c.financial.kind==='ttm'?'TTM':'年报'} · ${c.financial.periodEnd}`:'财报待溯源'}</em></span>
          <span className="valuation-multiples" data-label="当前倍数"><strong className="num">{multiple(c.ps)}<small>P/S</small></strong><span className="num">{multiple(c.pe)}<small>P/E</small></span></span>
          <span className="valuation-history" data-label={`${metric==='ps'?'P/S':'P/E'} 历史位置`}><PositionBar value={c[metric==='ps'?'psPercentile':'pePercentile']===null?null:Math.round(c[metric==='ps'?'psPercentile':'pePercentile']!*100)} /><span>{metric==='pe'&&c.netIncome!==null&&c.netIncome<=0?'亏损 / 零利润，P/E 不适用':`${metric==='ps'?c.historyMonths:c.peMonths} 个有效月末 · 中位 ${multiple(metric==='ps'?c.historicalPsMedian:c.historicalPeMedian)}`}</span></span>
          <span className="valuation-fundamentals" data-label="增长与盈利"><strong className="num">{percent(c.revenueGrowth)}<small>营收同比</small></strong><span className="num">{percent(c.netMargin)}<small>净利率</small></span></span>
          <span className="valuation-state"><span data-state={c.valuationState}>{STATE[c.valuationState]}</span><small>{c.priceDate?`行情 ${c.priceDate.slice(5)}`:'待补行情'}</small></span><span className="valuation-chevron" aria-hidden="true">{expanded===c.symbol?'−':'+'}</span>
        </button>
        {expanded===c.symbol&&<CompanyDetail c={c} />}
      </div>)}</div>
      {!companies.length&&<p className="entity-signals-empty">当前筛选下没有符合条件的公司。</p>}
    </section>
    <details className="card valuation-methodology"><summary>计算方法与资料边界 <span>{data.model}</span></summary><ol>{data.methodology.map(item=><li key={item}>{item}</li>)}</ol></details>
    <details className="card valuation-methodology"><summary>历史新闻与行情关联 · 探索性统计</summary><p className="measurement-detail-note">关联不等于因果，也不用于本页估值计算。</p><LinkageCard /></details>
  </div>
}
