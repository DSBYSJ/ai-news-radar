import type { DatabaseSync } from 'node:sqlite'
import { UNIVERSE } from '../market/universe.ts'
import { stripHtml } from '../collector/parse.ts'
import { normalizeUrl } from '../collector/fingerprint.ts'
import { isDigestTitle } from '../analytics/digest.ts'

/** 规则预警强度，未经收益/危机概率校准；与 NFI、CRS 分别呈现。 */
export const EVENT_MODEL = 'event-evidence-v2'
const DAY = 86_400_000
export type EventKind = 'leadership' | 'regulatory' | 'funding' | 'operations' | 'security'
export type EvidenceGrade = 'official' | 'multiple' | 'single' | 'unconfirmed'
export interface EventEvidence {
  title: string; url: string; source: string; publisher: string; publishedAt: string
  stance?: 'reported' | 'uncertain' | 'denied'
}
export interface RiskEvent {
  id: string; entity: string; symbol: string | null; kind: EventKind; category: string
  title: string; score: number; severity: number; confidence: EvidenceGrade
  sources: number; articles: number; firstSeen: string; lastSeen: string
  halfLifeHours: number; ageHours: number; decay: number; confidenceWeight: number
  evidence: EventEvidence[]; note: string
  disputed: boolean; verification: 'issuer_statement' | 'media_report' | 'unverified' | 'disputed'
  independentSources: number
}
export interface EventRisk {
  model: string; windowDays: number; score: number | null
  status: 'unknown' | 'quiet' | 'watch' | 'elevated' | 'critical'
  scanned: number; latestAt: string | null; stale: boolean
  events: RiskEvent[]; unconfirmed: RiskEvent[]; note: string
}

const FIRMS = [
  ...UNIVERSE.map(c => ({ id: c.symbol, name: c.name, symbol: c.symbol as string | null, aliases: [...c.aliases, c.symbol] })),
  { id: 'OpenAI', name: 'OpenAI', symbol: null, aliases: ['OpenAI'] },
  { id: 'Anthropic', name: 'Anthropic', symbol: null, aliases: ['Anthropic'] },
  { id: 'DeepSeek', name: 'DeepSeek', symbol: null, aliases: ['DeepSeek', '深度求索'] },
  { id: 'ByteDance', name: '字节跳动', symbol: null, aliases: ['ByteDance', '字节跳动'] },
  { id: 'Alibaba', name: '阿里巴巴', symbol: null, aliases: ['Alibaba', '阿里巴巴', '阿里云'] },
]
const LEADERS: Record<string, string[]> = {
  NVDA: ['黄仁勋', 'Jensen Huang', 'Jen-Hsun Huang'],
  OpenAI: ['Sam Altman', '山姆·奥特曼', '奥尔特曼'],
  Anthropic: ['Dario Amodei', '达里奥'],
  AMD: ['Lisa Su', '苏姿丰'],
}
const RULES: { kind: EventKind; category: string; severity: number; pattern: RegExp }[] = [
  { kind: 'leadership', category: '管理层变动', severity: 88, pattern: /辞职|辞去|卸任|离任|被罢免|被解雇|\bresign(?:s|ed|ation|ing)?\b|\bstep(?:s|ped|ping)? down\b|\boust(?:ed)?\b|\bfired\b|CEO transition/i },
  { kind: 'regulatory', category: '监管与供应限制', severity: 78, pattern: /出口禁令|出口管制|禁止出口|遭制裁|被制裁|反垄断调查|\bexport (?:ban|control|restriction)s?\b|\bsanction(?:s|ed)?\b|\bantitrust (?:probe|investigation|lawsuit)\b/i },
  { kind: 'funding', category: '资金与财务冲击', severity: 90, pattern: /申请破产|破产保护|债务违约|资金链断裂|财务造假|无法偿还|\bbankruptcy\b|\bdefaults? on\b|\baccounting fraud\b|\bliquidity crisis\b/i },
  { kind: 'operations', category: '业务中断', severity: 64, pattern: /大规模宕机|全球宕机|停止运营|被迫停产|重大召回|\bglobal outage\b|\bshuts? down operations\b|\bproduction halt\b|\bmajor recall\b/i },
  { kind: 'security', category: '安全事件', severity: 74, pattern: /数据泄露|遭黑客攻击|重大安全漏洞|\bdata breach\b|\bransomware attack\b|\bsecurity breach\b/i },
]
const UNCERTAIN = /传闻|据传|网传|或将|可能|考虑|拟辞|拟卸|疑似|如果|假如|一旦|是否|会不会|将辞|将卸|要求.{0,20}辞职|呼吁.{0,20}辞职|敦促.{0,20}辞职|[?？]|\brumou?r\b|\bmay\b|\bmight\b|\bcould\b|\bconsider(?:s|ing)?\b|\breportedly\b|\bif\b|\bwill (?:resign|step down)\b|\b(?:calls? for|demands?|urges?)\b.{0,35}\b(?:resign|resignation|step down)\b/i
const NEGATED = /(?:否认|并未|没有|不会|不打算|无意).{0,12}(?:辞职|辞去|卸任|离任|破产|违约|泄露|宕机|停产)|(?:辞职|离任|破产|泄露).{0,8}(?:不实|谣言|假消息)|\b(?:denies?|not|never|no plans? to)\b.{0,22}\b(?:resign|stepping down|bankruptcy|breach)/i
const ISSUER_HOSTS: Record<string,string[]> = {NVDA:['nvidia.com'],OpenAI:['openai.com'],Anthropic:['anthropic.com'],AMD:['amd.com'],MSFT:['microsoft.com'],AMZN:['aboutamazon.com'],TSM:['tsmc.com'],DeepSeek:['deepseek.com'],GOOGL:['abc.xyz','blog.google'],META:['about.fb.com']}

export function publisherOf(url: string, text = ''): string {
  // 同一原始媒体的多路 RSS/转载不构成多份独立证据。
  if (/路透社|\breuters\b/i.test(text)) return 'reuters.com'
  if (/彭博社|\bbloomberg\b/i.test(text)) return 'bloomberg.com'
  if (/美联社|associated press|\bAP News\b/i.test(text)) return 'apnews.com'
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') } catch { return '' }
}
function official(url: string, firmId: string): boolean {
  const parsed = new URL(url),host = parsed.hostname.toLowerCase()
  // User-hosted forums and a different issuer's site are not this company's announcement.
  if (/forum|community|developer/i.test(host.split('.')[0])) return false
  return (ISSUER_HOSTS[firmId]??[]).some(domain => host === domain || host.endsWith(`.${domain}`))
}
const aliasPatterns = new Map<string, RegExp>()
function hasAlias(text: string, alias: string): boolean {
  if (/^[\x00-\x7f]+$/.test(alias)) {
    let pattern = aliasPatterns.get(alias)
    if (!pattern) {
      const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      pattern = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i')
      aliasPatterns.set(alias, pattern)
    }
    return pattern.test(text)
  }
  return text.includes(alias)
}

export function eventRisk(db: DatabaseSync, opts: { now?: number } = {}): EventRisk {
  const now = opts.now ?? Date.now()
  const rows = db.prepare(`SELECT r.title, r.summary, r.url, r.published_at AS publishedAt, s.name AS source
    FROM raw_items r JOIN sources s ON s.id = r.source_id
    WHERE julianday(r.published_at) >= julianday(?) AND julianday(r.published_at) <= julianday(?)
      AND julianday(r.fetched_at) <= julianday(?) ORDER BY julianday(r.published_at) ASC, r.id ASC`)
    .all(new Date(now - 28 * DAY).toISOString(), new Date(now).toISOString(),new Date(now).toISOString()) as unknown as (Omit<EventEvidence, 'publisher'> & { summary: string | null })[]
  const groups = new Map<string, { firm: typeof FIRMS[number]; rule: typeof RULES[number]; rows: (EventEvidence & { uncertain: boolean;denied:boolean })[]; urls: Set<string>; severity: number; reported: Set<string>; official: boolean; titles:Set<string> }>()
  for (const row of rows) {
    try { if (!['https:', 'http:'].includes(new URL(row.url).protocol)) continue } catch { continue }
    const title = stripHtml(row.title)
    if (isDigestTitle(title) || /回顾|回忆录|周年回望|\bflashback\b/i.test(title)) continue
    if (/\b(?:who|that)\s+(?:fired|ousted|resigned)\b.{0,60}\b(?:says?|warns?|discusses?|reflects?|explains?)\b|(?:曾经|当年|几年前).{0,20}(?:辞职|离任|解雇)/i.test(title)) continue
    // 只取标题作事件触发器；避免摘要背景段把旧事件、引语或其他公司的事件误判为新事件。
    const segments = title.split(/[；;。!?！？]|\s[—–|]\s/).filter(Boolean)
    for (const segment of segments) {
      const denied=NEGATED.test(segment)
      const explicit = FIRMS.filter(f => f.aliases.some(alias => hasAlias(segment, alias)))
      const firms = explicit.length ? explicit : FIRMS.filter(f => (LEADERS[f.id] ?? []).some(alias => hasAlias(segment, alias)))
      const namedLeaders = FIRMS.filter(f => (LEADERS[f.id] ?? []).some(alias => hasAlias(segment, alias)))
      for (const firm of firms) for (const rule of RULES) {
        if (!rule.pattern.test(segment)) continue
        if (rule.kind === 'leadership' && namedLeaders.length && !namedLeaders.some(f => f.id === firm.id)) continue
        if (rule.kind === 'leadership' && !namedLeaders.length && firms.length > 1) {
          const roleAt = segment.search(/CEO|CFO|CTO|首席执行官|首席财务官|董事长|创始人|高管|掌门人|首席技术官/i)
          const distance = (f: typeof FIRMS[number]) => Math.min(...f.aliases.map(alias => {
            const at = segment.toLowerCase().indexOf(alias.toLowerCase())
            return at < 0 ? Infinity : Math.abs(at + alias.length - roleAt)
          }))
          if (firm.id !== [...firms].sort((a, b) => distance(a) - distance(b))[0].id) continue
        }
        // 人名、公司或管理职务必须在同一分句中；普通用户离职/产品“退役”不算领导层冲击。
        if (rule.kind === 'leadership' && !/CEO|CFO|CTO|首席执行官|首席财务官|董事长|创始人|高管|掌门人|首席技术官/i.test(segment) &&
          !(LEADERS[firm.id] ?? []).some(alias => hasAlias(segment, alias))) continue
        const departureTarget=rule.kind==='leadership'?segment.match(/(?:辞去|卸任)\s*([A-Za-z][A-Za-z0-9.-]*)\s*(?:董事|CEO|CFO|CTO)|\bresigns? from\s+([A-Za-z][A-Za-z0-9.-]*)\s+(?:board|CEO|CFO|CTO)/i):null
        if(departureTarget&&!firm.aliases.some(a=>hasAlias(departureTarget[1]??departureTarget[2],a)))continue
        const namedChief=namedLeaders.some(f=>f.id===firm.id)
        const subject=rule.kind==='leadership'?namedChief?'chief':/CFO|首席财务官/i.test(segment)?'cfo':/CTO|首席技术官/i.test(segment)?'cto':/CEO|首席执行官|董事长|掌门人/i.test(segment)?'chief':'other':''
        const id = `${firm.id}:${rule.kind}${subject?`:${subject}`:''}`
        const group = groups.get(id) ?? { firm, rule, rows: [], urls: new Set<string>(), severity: 0, reported: new Set<string>(), official: false,titles:new Set<string>() }
        const url = normalizeUrl(row.url)
        if (group.urls.has(url)) continue
        const publisher = publisherOf(row.url, `${title} ${stripHtml(row.summary ?? '').slice(0, 250)}`) || row.source
        const regulatoryDiscussion=rule.kind==='regulatory'&&!/新|宣布|出台|实施|启动|遭|被|正式|生效|禁止|限制|调查|诉讼|\b(?:bans?|restricts?|imposes?|announces?|launches?|opens?|faces?|facing|blocks?|targets?|sanctions?|investigates?|sues?)\b/i.test(segment)
        const unconfirmed = UNCERTAIN.test(segment)||regulatoryDiscussion
        const titleKey=title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu,'')
        const duplicateTitle=group.titles.has(titleKey)
        const evidence = { title, url: row.url, source: row.source, publisher, publishedAt: row.publishedAt, uncertain: unconfirmed,denied,
          stance:denied?'denied' as const:unconfirmed?'uncertain' as const:'reported' as const }
        group.urls.add(url)
        group.rows.push(evidence)
        const chief = /CEO|首席执行官|董事长|掌门人/i.test(segment) || (LEADERS[firm.id] ?? []).some(alias => hasAlias(segment, alias))
        const severity = rule.kind === 'leadership' && !chief ? 62 : rule.severity
        if(!unconfirmed&&!denied)group.severity = Math.max(group.severity, severity)
        if (!unconfirmed&&!denied&&!duplicateTitle) group.reported.add(publisher)
        if (!unconfirmed&&!denied && official(row.url,firm.id)) group.official = true
        if(!denied&&!unconfirmed)group.titles.add(titleKey)
        groups.set(id, group)
      }
    }
  }
  const result: RiskEvent[] = [...groups.entries()].filter(([,g])=>g.rows.some(r=>!r.denied)&&g.rows.some(r=>Date.parse(r.publishedAt)>=now-7*DAY)).map(([id, g]):RiskEvent => {
    const sources = new Set(g.rows.map(r => r.publisher)).size
    const disputed=g.rows.some(r=>r.denied)
    const confidence: EvidenceGrade = disputed?'unconfirmed':g.official ? 'official' : g.reported.size >= 2 ? 'multiple' : g.reported.size ? 'single' : 'unconfirmed'
    // Media source count measures breadth, not truth. Only the issuer's own statement changes weight.
    const confidenceWeight = disputed?0:g.official ? 1 : g.reported.size ? 0.65 : 0
    const firstSeen = (g.rows.find(r => !r.uncertain&&!r.denied) ?? g.rows.find(r=>!r.denied)!).publishedAt
    const lastSeen = g.rows[g.rows.length - 1].publishedAt
    const ageHours = Math.max(0, (now - Date.parse(firstSeen)) / 3_600_000)
    const halfLifeHours = 144
    const decay = Math.pow(0.5, ageHours / halfLifeHours)
    const score = Math.round(Math.min(confidence === 'unconfirmed' ? 35 : 100, g.severity * confidenceWeight * decay))
    // 优先展示官方、其次较早的直接报道，后续转载不能重置事件年龄。
    const evidence = [...g.rows].sort((a, b) => Number(b.denied)-Number(a.denied)||Number(a.uncertain) - Number(b.uncertain) || Number(official(b.url,g.firm.id)) - Number(official(a.url,g.firm.id)) || a.publishedAt.localeCompare(b.publishedAt))
      .filter((r, i, all) => all.findIndex(x => x.publisher === r.publisher&&x.stance===r.stance) === i).slice(0, 6)
      .map(({ uncertain: _uncertain,denied:_denied, ...item }) => item)
    return { id, entity: g.firm.name, symbol: g.firm.symbol, kind: g.rule.kind, category: g.rule.category,
      title: evidence.find(r=>r.stance!=='denied')?.title??evidence[0].title, score, severity: g.severity, confidence, sources, articles: g.rows.length,
      disputed,verification:disputed?'disputed':g.official?'issuer_statement':g.reported.size?'media_report':'unverified',independentSources:g.reported.size,
      firstSeen, lastSeen, halfLifeHours, ageHours: Math.round(ageHours), decay: Number(decay.toFixed(3)), confidenceWeight,
      evidence, note: `${disputed?'存在否认或相反报道，移至争议观察，不判断哪一方属实。':g.official?'命中该公司网站的直接表述，仍应打开原文核对语境。':'媒体标题命中，不等于独立事实核验；多源数量不增加可信度系数。'} 类型强度 ${g.severity} × 来源系数 ${confidenceWeight} × 时效 ${decay.toFixed(2)}。最早匹配报道回查 28 天，无法识别的转载仍可能残留。` }
  }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  const events = result.filter(e => e.confidence !== 'unconfirmed')
  const unconfirmed = result.filter(e => e.confidence === 'unconfirmed')
  const currentRows=rows.filter(r=>Date.parse(r.publishedAt)>=now-7*DAY)
  const latestAt = currentRows.at(-1)?.publishedAt ?? null
  const stale = latestAt === null || now - Date.parse(latestAt) > 2 * DAY
  const score = currentRows.length === 0 ? null : Math.max(0, ...events.map(e => e.score))
  return { model: EVENT_MODEL, windowDays: 7, score,
    status: score === null || stale ? 'unknown' : score >= 75 ? 'critical' : score >= 55 ? 'elevated' : score >= 30 ? 'watch' : 'quiet',
    scanned: currentRows.length, latestAt, stale, events: events.slice(0, 12), unconfirmed: unconfirmed.slice(0, 12),
    note: '近 7 天原始标题观察，回查 28 天确定最早匹配报道。报道不等于已核实事实；否认与传闻不计入活跃强度。总强度取最高事件，是规则排序，不是损失概率。' }
}
