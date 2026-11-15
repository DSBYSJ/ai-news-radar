import type { MarketPressure, NfiResult } from '../../types.ts'

export function NarrativeSignals({data}:{data:NfiResult|null}) {
  if(!data)return <p className="measurement-empty">尚无可用观察数据</p>
  return <div className="measurement-observations">
    {data.factors.map(f=><div className="measurement-observation" key={f.key}>
      <div><span>{f.label}</span><small>{f.coverage}</small></div><strong className="num">{f.display??'资料不足'}</strong>
    </div>)}
    <details className="measurement-explanation"><summary>观察项的单位与边界</summary>{data.factors.map(f=><p key={f.key}><b>{f.label}：</b>{f.note}</p>)}</details>
  </div>
}

export function NarrativeAttribution({data}:{data:NfiResult|null}) {
  if(!data)return null
  return <div className="measurement-attribution">
    <p className="panel-description">融资与追逐措辞取并集，拆成三个互斥部分；相加还原报道占比。</p>
    {data.status!=='ready'?<p className="measurement-empty">{data.reasons?.join('；')||'样本不足，未计算'}</p>:<>
      <div className="measurement-partition-track" aria-label="资本叙事占比构成">{data.partitions?.map(p=><span key={p.key} data-kind={p.key} style={{width:`${p.contribution}%`}} />)}</div>
      <div className="measurement-partitions">{data.partitions?.map(p=><div key={p.key}><span>{p.label}</span><strong className="num">{p.contribution.toFixed(1)}<small>pp</small></strong></div>)}</div>
    </>}
    {data.sampling&&<p className="measurement-detail-note">原始 {data.sampling.rawArticles.toLocaleString()} 条 → 去重 {data.sampling.uniqueArticles.toLocaleString()} 条；{data.sampling.eligiblePublishers} 个合格出版源、{data.sampling.eligibleArticles.toLocaleString()} 条用于源内比例。样本少于 5 条的出版源退出本次占比计算。</p>}
    <p className="measurement-detail-note">{data.formula}</p>
  </div>
}

export function PressureAttribution({data}:{data?:MarketPressure}) {
  if(!data)return null
  return <section className="risk-panel analysis-panel pressure-attribution">
    <div className="panel-heading"><h3>市场压力，来自哪些变化</h3><span>{data.asOf??'暂无共同日期'} · V3</span></div>
    <p className="panel-description">信用与股市两组各占一半，组内等权。每项 25%；新闻、利率水平与倒挂不加分。</p>
    <div className="pressure-feature-grid">{data.factors.map(f=><article className="pressure-feature" key={f.key}>
      <div><h4>{f.label}</h4><span className="num">{f.value?.toFixed(2)} {f.unit}</span></div>
      <strong className="num">{f.score.toFixed(1)}<small>历史分位 /100</small></strong>
      <div className="pressure-feature-track"><span style={{width:`${f.score}%`}} /></div>
      <div className="pressure-delta"><span>较 {data.comparison?.date??'上一比较日'}</span><b className="num">{f.change===null?'—':`${f.change>=0?'+':''}${f.change.toFixed(2)} ${f.changeUnit}`}</b></div>
      <p>{f.referenceFrom} ~ {f.referenceUntil}<br />{f.observations} 个既往观测 · 当前不入基准</p>
      <a className="evidence-source-link" href={f.sourceUrl} target="_blank" rel="noreferrer">FRED 原始序列 ↗</a>
    </article>)}</div>
    {data.reasons.map(reason=><p className="measurement-empty" key={reason}>{reason}</p>)}
    <p className="measurement-detail-note">{data.formula} {data.note}</p>
    {data.comparison&&<p className="measurement-detail-note">变动比较使用同一套当前历史分布，比较 {data.comparison.date} 与 {data.asOf}；不会把滚动基准变化当成市场变化。实现波动率的差值为年化百分点。</p>}
  </section>
}
