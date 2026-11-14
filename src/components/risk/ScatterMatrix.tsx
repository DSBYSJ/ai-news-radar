import { useMemo, useState } from 'react'
import type { CSSProperties } from 'react'

interface Signal {
  entity: string; score: number; mentions: number; negativeShare: number
  heatChange: number | null; funding: number; reason?: string
}
interface Props { items: Signal[]; macroPressure: number | null; height?: number }

/** 用可排序清单代替重叠气泡。分数描述负面报道结构，不是企业违约概率。 */
export default function ScatterMatrix({ items, macroPressure }: Props) {
  const [sort, setSort] = useState<'score' | 'mentions'>('score')
  const rows = useMemo(() => [...items].sort((a,b) => b[sort] - a[sort] || b.mentions - a.mentions), [items, sort])
  if (!rows.length) return <p className="entity-signals-empty">当前没有达到样本门槛的实体负面信号。</p>
  return <div className="entity-signals">
    <div className="entity-signals-toolbar"><p>一行一个实体，先看强度，再看样本和变化。</p><div className="range-switch">
      <button type="button" aria-pressed={sort === 'score'} onClick={() => setSort('score')}>按强度</button>
      <button type="button" aria-pressed={sort === 'mentions'} onClick={() => setSort('mentions')}>按提及量</button>
    </div></div>
    <div className="entity-signal-head"><span>实体 / 主要信号</span><span>负面信号强度</span><span>负面占比 / 样本</span><span>提及变化</span></div>
    {rows.map((item,i) => <div className="entity-signal-row" key={item.entity}>
      <div className="entity-signal-name"><span className="entity-rank num">{String(i+1).padStart(2,'0')}</span><div><strong>{item.entity}</strong><p>{item.reason ?? '负面报道结构信号'}</p></div></div>
      <div className="entity-signal-meter" style={{'--signal-tone': item.score >= 70 ? 'var(--risk-critical)' : item.score >= 45 ? 'var(--risk-warn)' : 'var(--accent)'} as CSSProperties}>
        <div><span style={{width:`${Math.min(100,Math.max(0,item.score))}%`}} /></div><strong className="num">{item.score}<small>/100</small></strong>
      </div>
      <div className="entity-signal-sample"><strong className="num">{(item.negativeShare*100).toFixed(0)}%</strong><span>{item.mentions} 次提及</span></div>
      <div className="entity-signal-change"><strong className="num">{item.heatChange === null ? '—' : `${item.heatChange >= 0 ? '+' : ''}${Math.round(item.heatChange*100)}%`}</strong><span>{item.heatChange === null ? '基期不足' : '近 7 天较前 7 天'}</span></div>
    </div>)}
    <p className="entity-signals-note">强度 = 负面占比 × 70 + 近期负面升温 × 30；提及增加不直接等于风险增加。人物、机构和公司均可能出现，不将其混称为公司。宏观压力 {macroPressure ?? '未计算'} 分单独观察。</p>
  </div>
}
