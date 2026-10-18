export interface Article {
  id: number
  title: string
  tldr: string | null
  summary: string | null
  url: string
  category: string
  categoryLabel: string
  score: number | null
  entities: string[]
  publishedAt: string
  sourceId: string
  sourceName: string
  eventKey: string | null
  sourceCount: number | null
}

export interface ArticlesResponse {
  total: number
  limit: number
  offset: number
  items: Article[]
}

export interface DailyPoint {
  date: string
  value: number
}

export interface CategoryRatioPoint {
  date: string
  total: number
  ratios: Record<string, number>
}

export interface VelocityPoint {
  date: string
  count: number
  ma7: number | null
}

export interface VelocityResponse {
  days: number
  points: VelocityPoint[]
  thisWeekAvg: number
  lastWeekAvg: number
  changePct: number | null
}

export interface CrossSourcePoint {
  date: string
  avgSources: number
  maxSources: number
  eventCount: number
}

export interface CrossSourceEvent {
  eventKey: string
  title: string
  category: string
  sourceCount: number
  articleCount: number
  date: string
  /** 全部来源名（悬浮提示展示"源列表"） */
  sources: string[]
}

export interface Burst {
  date: string
  category: string
  count: number
  baseline: number
  z: number
}

export interface CrossSourceResponse {
  days: number
  points: CrossSourcePoint[]
  topEvents: CrossSourceEvent[]
  /** 按日期分组的事件（图表悬浮提示用） */
  dayEvents: Record<string, CrossSourceEvent[]>
  bursts: Burst[]
}

export interface Health {
  ok: boolean
  service: string
  version: string
  sources: number
  rawItems: number
  articles: number
  events: number
  aiEnabled: boolean
  authEnabled: boolean
  /** 定时策略（北京时间）：采集时间点 "07:00,10:00,..."、简报时刻 "23:00"（旧后端可能没有） */
  collectAt?: string
  summaryAt?: string
  /** 库里最新一条成品的日期（UTC YYYY-MM-DD）；没有数据为 null。旧后端可能没有 */
  latestDate?: string | null
  time: string
}

export interface SourceItem {
  id: string
  name: string
  url: string
  kind: string
  weight: number
  enabled: number
  last_fetch_at: string | null
  last_status: string | null
}

export interface EntityItem {
  entity: string
  count: number
}

export interface DailyStats {
  total: number
  byCategory: Record<string, number>
  crossSource: number
  prevTotal: number
  deltaPct: number | null
  topSources: { name: string; count: number }[]
}

export interface SummaryListItem {
  date: string
  title: string
  model: string
  stats: DailyStats | null
  created_at: string
  updated_at: string
}

export interface SummaryHighlight {
  title: string
  url: string
  sourceName: string
  category: string
  categoryLabel: string
  sourceCount: number | null
  score: number | null
}

export interface SummaryDetail extends SummaryListItem {
  content: string
  highlights: SummaryHighlight[]
}

export interface ForecastPoint {
  date: string
  value: number
  lo: number
  hi: number
}

export interface ForecastResponse {
  days: number
  horizon: number
  history: { date: string; value: number }[]
  forecast: ForecastPoint[]
  summary: { changePct: number | null; direction: 'up' | 'down' | 'flat'; message: string }
}

export type SentimentKey = 'positive' | 'neutral' | 'negative'

export interface SentimentDay {
  date: string
  total: number
  classified: number
  counts: Record<SentimentKey, number>
  ratios: Record<SentimentKey, number>
}

export interface SentimentAlert {
  date: string
  entity: string
  negativeCount: number
  baseline: number
  z: number
}

export interface EntitySentimentBrief {
  entity: string
  count: number
  negative: number
  negShare: number
}

export interface SentimentResponse {
  days: number
  byDay: SentimentDay[]
  alerts: SentimentAlert[]
  entities: EntitySentimentBrief[]
}

export interface EntitySentimentPoint {
  date: string
  count: number
  negative: number
  negRatio: number
  ma7: number | null
}

export interface EntitySentimentResponse {
  days: number
  entity: string
  points: EntitySentimentPoint[]
  total: number
  negative: number
}

export interface AskSource {
  index: number
  title: string
  url: string
  sourceName: string
  date: string
  snippet: string
  similarity: number
}

export interface AskResult {
  kind: 'stats' | 'attribution'
  answer: string
  sources: AskSource[]
  cited?: number[]
  sql?: string
  mode: 'ai' | 'fallback'
  note?: string
}

export interface GenerateSummaryResponse {
  ok: boolean
  date: string
  skipped: boolean
  model: string
  reason?: string
  summary: SummaryDetail | null
}
