import { useState } from 'react'
import type { EventRisk, RiskEvent, RiskReport } from '../../types.ts'

const LEVELS = { unknown: '覆盖有限', observe: '持续观察', quiet: '持续观察', watch: '值得关注', elevated: '重点关注', critical: '优先核查' }
const EVIDENCE = { official: '公司网站表述', multiple: '多出版域报道', single: '单源报道', unconfirmed: '待核实' }
const date = (value: string) => new Date(value).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })

function EventRow({ event }: { event: RiskEvent }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <article className="event-row">
      <div className="event-row-leading">
        <span className="event-monogram">{event.symbol?.slice(0, 2) ?? event.entity.slice(0, 2)}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <strong className="event-entity">{event.entity}</strong>
            {event.symbol && <span className="event-symbol num">{event.symbol}</span>}
            <span className="event-evidence-grade">{event.disputed?'存在争议':EVIDENCE[event.confidence]}</span>
          </div>
          <p className="event-title">{event.title}</p><p className="event-verification">{event.verification==='issuer_statement'?'公司网站直接表述 · 请核对原文语境':event.disputed?'存在相反表述 · 暂停计分，等待核实':'媒体报道线索 · 尚未独立核实事实'}</p>
          <div className="event-meta">
            <span>{event.category}</span><span>{event.sources} 个出版来源</span><span>最早匹配报道 {date(event.firstSeen)}</span>
          </div>
        </div>
        <div className="event-intensity"><strong className="num">{event.score}</strong><span>规则关注度</span></div>
      </div>
      <button type="button" className="event-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起证据与计算依据 −' : '查看证据与计算依据 +'}
      </button>
      {expanded && (
        <div className="event-details">
          <p>{event.note}</p>
          <p>回查 28 天内最早匹配报道，半衰期 {event.halfLifeHours / 24} 天；转载去重，不重复累计。</p>
          <ul>
            {event.evidence.map(item => <li key={item.url}>
              <a href={item.url} target="_blank" rel="noreferrer">{item.title}<span aria-hidden="true"> ↗</span></a>
              <span>{item.stance==='denied'?'否认 / 相反表述 · ':''}{item.publisher} · {date(item.publishedAt)}</span>
            </li>)}
          </ul>
        </div>
      )}
    </article>
  )
}

export default function EventRiskPanel({ data }: { data: EventRisk; assessment?: RiskReport['assessment'] }) {
  const level = data.status === 'quiet' ? 'observe' : data.status
  const [showAll, setShowAll] = useState(false)
  const items = showAll ? data.events : data.events.slice(0, 3)
  return (
    <section className="event-risk-panel" data-level={level}>
      <div className="event-panel-heading">
        <div>
          <p className="eyebrow"><span className="signal-dot" /> EVENT EVIDENCE</p>
          <h3>报道线索，与证据一起看</h3>
          <p className="event-panel-sub">原始标题筛查 · 来源不等于背书 · 争议消息单列</p>
        </div>
        <span className="risk-level-tag">{LEVELS[level]}</span>
      </div>
      <div className="risk-judgement">
        <div className="judgement-number"><span className="num">{data.stale ? '—' : data.score ?? '—'}</span><small>规则关注度 / 100</small></div>
        <div><h4>{data.events.length?`近 7 天有 ${data.events.length} 组待关注报道`:'已覆盖报道暂无较强触发'}</h4><p>{data.note}</p></div>
      </div>
      <div className="event-list">
        {items.map(event => <EventRow event={event} key={event.id} />)}
        {items.length === 0 && <p className="event-empty">{data.stale ? '采集覆盖缺失或超过 2 天未更新，暂不作正常判断。' : '近 7 天未检出符合当前规则的重大冲击。未检出不等于没有风险。'}</p>}
      </div>
      {data.events.length > 3 && <button type="button" className="event-expand" onClick={() => setShowAll(!showAll)}>{showAll ? '收起事件' : `查看其余 ${data.events.length - 3} 个事件 →`}</button>}
      {data.unconfirmed.length > 0 && <details className="unconfirmed-events"><summary>传闻 / 争议 {data.unconfirmed.length} 组 · 不计入关注度</summary>{data.unconfirmed.map(event => <EventRow key={event.id} event={event} />)}</details>}
      <footer className="event-panel-footer"><span>过去 {data.windowDays} 天 · 检查 {data.scanned.toLocaleString()} 条原始记录</span><span>{data.latestAt ? `最新报道 ${date(data.latestAt)}` : '暂无采集数据'}</span></footer>
      <p className="risk-model-note">来源类型、事件类别与时间衰减只用于安排核查顺序；未经预测校准，多家转载不会增加事实可信度。</p>
    </section>
  )
}
