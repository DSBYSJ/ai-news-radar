import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api.ts'
import type { MarketCompanyRow, MarketOverview } from '../types.ts'
import MarketStatusBar from '../components/market/MarketStatusBar.tsx'
import LinkageCard from '../components/market/LinkageCard.tsx'

const multiple = (v: number | null) => v === null ? '—' : `${v.toFixed(1)}×`
const percent = (v: number | null) => v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}%`
const rank = (v: number | null) => v === null ? '—' : `${Math.round(v*100)}%`
const money = (v: number | null) => v === null ? '—' : Math.abs(v)>=1e12 ? `${(v/1e12).toFixed(2)}T` : `${(v/1e9).toFixed(1)}B`
const STATE = { ready:'双因子参照', limited:'有限参照', blocked:'待核验', unavailable:'暂无行情' }

function PositionBar({ value }: { value: number | null }) {
  return <span className="valuation-position" data-band={value === null ? 'unknown' : value >= 80 ? 'high' : value <= 20 ? 'low' : 'middle'}>
    <span className="valuation-position-track"><span style={{width:`${value??0}%`}} /><i /></span>
    <strong className="num">{value === null ? '—' : value}<small>/100</small></strong>
  </span>
}
function CompanyDetail({ c }: { c: MarketCompanyRow }) {
  return <div className="valuation-detail" role="region" aria-label={`${c.symbol} 计算依据`}>
    <div><h4>当前倍数，用了什么资料</h4><dl className="valuation-basis">
      <div><dt>价格 / 日期</dt><dd className="num">{c.close===null?'—':`$${c.close.toFixed(2)}`} · {c.priceDate??'无行情'}{c.manualPrice?' · 手工补录':''}</dd></div>
      <div><dt>财年 / 申报日</dt><dd className="num">{c.fiscalEnd??'—'} / {c.filedAt??'—'}</dd></div>
      <div><dt>股本观测 / 拆股因子</dt><dd className="num">{c.basis?.sharesAsOf??'待核验'} / {c.basis?.splitFactor.toFixed(2)??'—'}×</dd></div>
      <div><dt>估算市值</dt><dd className="num">{money(c.marketCap)} USD</dd></div>
    </dl><p className="valuation-formula">P/S = 同口径估算市值 ÷ 年报营收；P/E = 同一市值 ÷ 年报净利润。采用年报口径，不冒充 TTM。</p></div>
    <div><h4>相对位置，为什么是这个结果</h4><dl className="valuation-basis">
      <div><dt>P/S 月末历史分位</dt><dd className="num">{rank(c.psPercentile)} · {c.historyMonths} 个月</dd></div>
      <div><dt>P/E 月末历史分位</dt><dd className="num">{c.netIncome!==null&&c.netIncome<=0?'亏损，不适用':`${rank(c.pePercentile)} · ${c.peMonths} 个月`}</dd></div>
      <div><dt>实际参考区间</dt><dd className="num">{c.historyFrom??'—'} ~ {c.historyUntil??'—'}</dd></div>
      <div><dt>同层 P/S 参照</dt><dd>{c.peerPercentile===null?`样本不足 · 另有 ${c.peerCount} 家`:`${rank(c.peerPercentile)} 分位 · 另有 ${c.peerCount} 家`}</dd></div>
    </dl><p className="valuation-formula">有效因子：{c.metricsUsed.join(' + ')||'暂无'}。两项齐全时 P/S 60%、P/E 40%；缺项按有效权重归一。低位置不等于低估。</p></div>
    <div className="valuation-detail-notes"><h4>资料与边界</h4>{c.reasons.length ? c.reasons.map(reason=><p key={reason}>· {reason}</p>) : <p>当前资料通过口径核验；历史参考不保证未来均值回归。</p>}<p>拆股核验：{c.splitCheckedAt?.slice(0,10)??'尚未核验'}。不同商业模式、利润率和增长阶段仍需单独判断。</p></div>
  </div>
}

export default function MarketPage() {
  const [data,setData]=useState<MarketOverview|null>(null), [error,setError]=useState<string|null>(null)
  const [loading,setLoading]=useState(true), [segment,setSegment]=useState('all')
  const [sort,setSort]=useState<'relativeScore'|'revenueGrowth'|'netMargin'>('relativeScore')
  const [onlyValued,setOnlyValued]=useState(false), [expanded,setExpanded]=useState<string|null>(null)
  const load=useCallback(async()=>{const value=await api.marketOverview();setData(value);setError(null)},[])
  useEffect(()=>{let alive=true;void api.marketOverview().then(value=>{if(alive)setData(value)}).catch(e=>{if(alive)setError(e instanceof Error?e.message:String(e))}).finally(()=>{if(alive)setLoading(false)});return()=>{alive=false}},[])
  const companies=useMemo(()=>data?.companies.filter(c=>(segment==='all'||c.segment===segment)&&(!onlyValued||c.ps!==null))
    .sort((a,b)=>(b[sort]??-Infinity)-(a[sort]??-Infinity)||a.symbol.localeCompare(b.symbol))??[],[data,segment,onlyValued,sort])
  if(loading)return <div className="card h-72 animate-pulse" />
  if(error)return <p className="risk-error" role="alert">{error}</p>
  if(!data)return null
  const high=data.companies.filter(c=>c.relativeScore!==null&&c.relativeScore>=80).length
  return <div className="market-page">
    <header className="risk-page-header"><div><p className="eyebrow">VALUATION INTELLIGENCE <span className="eyebrow-rule" /></p><h2>估值，不只看一个倍数<span className="heading-dot">.</span></h2>
      <p className="page-description">把价格、盈利与增长放在一起。先核验资料，再观察相对位置。</p></div><span className="market-model-badge">年度相对估值 · V2</span></header>
    <MarketStatusBar data={data} onRefreshed={load} />
    <div className="valuation-summary-grid">{[
      {label:'通过当前估值核验',value:`${data.coverage.valued}/${data.coverage.total}`,note:'已检查股本、拆股与资料时效'},
      {label:'具备历史参照',value:String(data.coverage.referenced),note:'至少 24 个有效月末样本'},
      {label:'处于自身历史高位',value:String(high),note:'有效因子相对位置 ≥80；不等于做空信号'},
      {label:'资料需要补齐',value:String(data.coverage.total-data.coverage.valued),note:'保留空值与原因，不以零替代'},
    ].map(item=><section className="card valuation-summary" key={item.label}><p>{item.label}</p><strong className="num">{item.value}</strong><span>{item.note}</span></section>)}</div>
    <section className="valuation-context"><div className="eyebrow">READ THE CONTEXT</div><h3>相对位置，是参照，不是公允价值。</h3><p>当前倍数基于最近已披露年报；历史位置基于统一拆股口径的月末快照。亏损公司不计算 P/E，过期或无法核验的数据停止输出结论。</p></section>
    <section className="card valuation-workspace">
      <div className="valuation-workspace-heading"><div><p className="eyebrow">COMPANY WORKSPACE</p><h3>逐家公司，看清估值依据</h3></div><span>{companies.length} 家 · 点击行展开口径</span></div>
      <div className="valuation-controls"><div className="valuation-segments"><button type="button" aria-pressed={segment==='all'} onClick={()=>setSegment('all')}>全部板块</button>{data.segments.map(s=><button key={s.segment} type="button" aria-pressed={segment===s.segment} onClick={()=>setSegment(s.segment)}>{s.label}<small>{s.valuationCovered}/{s.companies}</small></button>)}</div>
        <div className="valuation-secondary-controls"><label><input type="checkbox" checked={onlyValued} onChange={e=>setOnlyValued(e.target.checked)} />只看可估值</label><label>排序<select value={sort} onChange={e=>setSort(e.target.value as typeof sort)}><option value="relativeScore">历史相对位置</option><option value="revenueGrowth">营收增长</option><option value="netMargin">净利率</option></select></label></div>
      </div>
      <div className="valuation-list-heading"><span>公司 / 产业位置</span><span>当前年报倍数</span><span>自身历史相对位置</span><span>增长 / 盈利质量</span><span>资料状态</span><span /></div>
      <div className="valuation-company-list">{companies.map(c=><div key={c.symbol} className="valuation-company" data-expanded={expanded===c.symbol}>
        <button type="button" className="valuation-company-row" aria-expanded={expanded===c.symbol} onClick={()=>setExpanded(expanded===c.symbol?null:c.symbol)}>
          <span className="valuation-company-name"><strong>{c.symbol}<small>{c.name}</small></strong><span>{c.role}</span></span>
          <span className="valuation-multiples"><strong className="num">{multiple(c.ps)}<small>P/S</small></strong><span className="num">{multiple(c.pe)}<small>P/E</small></span></span>
          <span className="valuation-history"><PositionBar value={c.relativeScore} /><span>{c.interpretation}</span></span>
          <span className="valuation-fundamentals"><strong className="num">{percent(c.revenueGrowth)}<small>营收同比</small></strong><span className="num">{percent(c.netMargin)}<small>净利率</small></span></span>
          <span className="valuation-state"><span data-state={c.valuationState}>{STATE[c.valuationState]}</span><small>{c.priceDate?`行情 ${c.priceDate.slice(5)}`:'待补行情'}</small></span><span className="valuation-chevron" aria-hidden="true">{expanded===c.symbol?'−':'+'}</span>
        </button>
        {expanded===c.symbol&&<CompanyDetail c={c} />}
      </div>)}</div>
      {!companies.length&&<p className="entity-signals-empty">当前筛选下没有符合条件的公司。</p>}
    </section>
    <details className="card valuation-methodology"><summary>计算方法与资料边界 <span>{data.model}</span></summary><ol>{data.methodology.map(item=><li key={item}>{item}</li>)}</ol></details>
    <LinkageCard />
  </div>
}
