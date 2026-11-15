import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'

interface Signal {
  entity: string; score: number; mentions: number; negativeShare: number; classified:number;coverage:number;publishers:number;balancedShare:number|null;negativeChange:number|null
  heatChange: number | null; funding: number; reason?: string
}
interface Props { items: Signal[]; macroPressure: number | null; height?: number }

/** 用可排序清单代替重叠气泡。分数描述负面报道结构，不是企业违约概率。 */
export default function ScatterMatrix({ items }: Props) {
  const [sort, setSort] = useState<'score' | 'mentions'>('score')
  const rows = useMemo(() => [...items].sort((a,b) => b[sort] - a[sort] || b.mentions - a.mentions), [items, sort])
  if (!rows.length) return <p className="entity-signals-empty">当前没有达到样本门槛的实体负面信号。</p>
  return <div className="entity-signals">
    <div className="entity-signals-toolbar"><p>先看标注覆盖，再比较不同出版源的负面报道比例。</p><div className="range-switch">
      <button type="button" aria-pressed={sort === 'score'} onClick={() => setSort('score')}>按负面占比</button>
      <button type="button" aria-pressed={sort === 'mentions'} onClick={() => setSort('mentions')}>按提及量</button>
    </div></div>
    <div className="entity-signal-head"><span>实体 / 主要信号</span><span>来源均衡负面占比</span><span>标注样本 / 覆盖</span><span>负面比例变化</span></div>
    {rows.map((item,i) => <div className="entity-signal-row" key={item.entity}>
      <div className="entity-signal-name"><span className="entity-rank num">{String(i+1).padStart(2,'0')}</span><div><strong>{item.entity}</strong><p>{item.reason ?? '负面报道结构信号'}</p></div></div>
      <div className="entity-signal-meter" data-label="来源均衡负面占比" style={{'--signal-tone': 'var(--accent)'} as CSSProperties}>
        <div><span style={{width:`${Math.min(100,Math.max(0,item.score))}%`}} /></div><strong className="num">{item.balancedShare===null?'—':(item.balancedShare*100).toFixed(1)}<small>%</small></strong>
      </div>
      <div className="entity-signal-sample" data-label="已标注 / 全部报道"><strong className="num">{item.classified}/{item.mentions}</strong><span>覆盖 {(item.coverage*100).toFixed(0)}% · {item.publishers} 合格源</span></div>
      <div className="entity-signal-change" data-label="近 7 天负面比例变化"><strong className="num">{item.negativeChange === null ? '—' : `${item.negativeChange >= 0 ? '+' : ''}${(item.negativeChange*100).toFixed(1)}pp`}</strong><span>{item.negativeChange === null ? '可比来源样本不足' : '近 7 天较前 7 天'}</span></div>
    </div>)}
    <p className="entity-signals-note">URL 与源内标题去重，未知情绪不当中性。占比需至少 2 个合格源（各 3 条已标注报道），整体标注覆盖 ≥60%；变化只比较两期均达门槛的相同来源。情绪为机器标签，未经逐篇核实，不代表公司财务风险。</p>
  </div>
}
