import { useState } from 'react'
import type { EventRisk, RiskEvent, RiskReport } from '../../types.ts'

const LEVELS = { unknown: '覆盖有限', observe: '持续观察', quiet: '持续观察', watch: '值得关注', elevated: '重点关注', critical: '高强度预警' }
const EVIDENCE = { official: '官方来源', multiple: '多源报道', single: '单源报道', unconfirmed: '待核实' }
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
            <span className="event-evidence-grade">{EVIDENCE[event.confidence]}</span>
          </div>
          <p className="event-title">{event.title}</p>
          <div className="event-meta">
            <span>{event.category}</span><span>{event.sources} 个出版来源</span><span>首次收录 {date(event.firstSeen)}</span>
          </div>
        </div>
        <div className="event-intensity"><strong className="num">{event.score}</strong><span>事件强度</span></div>
      </div>
      <button type="button" className="event-expand" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起证据与计算依据 −' : '查看证据与计算依据 +'}
      </button>
      {expanded && (
        <div className="event-details">
          <p>{event.note}</p>
          <p>以最早直接报道为起点，半衰期 {event.halfLifeHours / 24} 天；转载去重，不重复累计。</p>
          <ul>
            {event.evidence.map(item => <li key={item.url}>
              <a href={item.url} target="_blank" rel="noreferrer">{item.title}<span aria-hidden="true"> ↗</span></a>
              <span>{item.source} · {date(item.publishedAt)}</span>
            </li>)}
          </ul>
        </div>
      )}
    </article>
  )
}

export default function EventRiskPanel({ data, assessment }: { data: EventRisk; assessment?: RiskReport['assessment'] }) {
  const level = assessment?.level ?? (data.status === 'quiet' ? 'observe' : data.status)
  const [showAll, setShowAll] = useState(false)
  const items = showAll ? data.events : data.events.slice(0, 3)
  return (
    <section className="event-risk-panel" data-level={level}>
      <div className="event-panel-heading">
        <div>
          <p className="eyebrow"><span className="signal-dot" /> LIVE EVENT INTELLIGENCE</p>
          <h3>先看正在发生的变化</h3>
          <p className="event-panel-sub">重大公司事件独立预警 · 不等待情感加工或宏观指标抬升</p>
        </div>
        <span className="risk-level-tag">{LEVELS[level]}</span>
      </div>
      <div className="risk-judgement">
        <div className="judgement-number"><span className="num">{data.stale ? '—' : data.score ?? '—'}</span><small>事件冲击 / 100</small></div>
        <div><h4>{assessment?.headline ?? '观察近 7 天重大事件'}</h4><p>{assessment?.detail ?? data.note}</p></div>
      </div>
      <div className="event-list">
        {items.map(event => <EventRow event={event} key={event.id} />)}
        {items.length === 0 && <p className="event-empty">{data.stale ? '采集覆盖缺失或超过 2 天未更新，暂不作正常判断。' : '近 7 天未检出符合当前规则的重大冲击。未检出不等于没有风险。'}</p>}
      </div>
      {data.events.length > 3 && <button type="button" className="event-expand" onClick={() => setShowAll(!showAll)}>{showAll ? '收起事件' : `查看其余 ${data.events.length - 3} 个事件 →`}</button>}
      {data.unconfirmed.length > 0 && <details className="unconfirmed-events"><summary>待核实消息 {data.unconfirmed.length} 条 · 未计入已发生事件强度</summary>{data.unconfirmed.map(event => <EventRow key={event.id} event={event} />)}</details>}
      <footer className="event-panel-footer"><span>过去 {data.windowDays} 天 · 检查 {data.scanned.toLocaleString()} 条原始记录</span><span>{data.latestAt ? `最近收录 ${date(data.latestAt)}` : '暂无采集数据'}</span></footer>
      <p className="risk-model-note">规则预警强度，未经回测校准；不代表股价跌幅或危机概率。不同观察线分别解读。</p>
    </section>
  )
}
