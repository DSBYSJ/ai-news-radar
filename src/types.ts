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

export interface GenerateSummaryResponse {
  ok: boolean
  date: string
  skipped: boolean
  model: string
  reason?: string
  summary: SummaryDetail | null
}
