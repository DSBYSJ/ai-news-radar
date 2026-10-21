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
  /** 源是否提供全文（有才能站内阅读） */
  hasContent?: boolean
}

/** 单条正文（仅自用；未提供全文时 content 为空） */
export interface ArticleContent {
  id: number
  title: string
  url: string
  sourceName: string
  publishedAt: string
  hasContent: boolean
  chars: number
  content: string
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
  /** 两期都够数据才为 true；false 时 changePct 为 null */
  comparable: boolean
  /** 不可比的原因（可直接展示） */
  note: string | null
  thisWeekDays: number
  lastWeekDays: number
  thisWeekSources: number
  lastWeekSources: number
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
  /** 其中与 AI 相关、会进入榜单/日报/列表的条数 */
  aiArticles: number
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

// ---------- 结构化日报（v0.9.1：头条 / 分区 / 快讯） ----------
export interface EditionItem {
  id: number
  title: string
  tldr: string | null
  summary: string | null
  url: string
  category: string
  score: number | null
  sourceName: string
  /** 来源权重：3 = 官方/一手，2 = 媒体，1 = 聚合 */
  sourceWeight: number
  publishedAt: string
  eventKey: string | null
  /** 同一事件被几家独立源报道 */
  sourceCount: number
  sources: string[]
}

export interface EditionSection {
  category: string
  label: string
  items: EditionItem[]
}

export interface Edition {
  date: string
  headline: EditionItem | null
  sections: EditionSection[]
  flash: EditionItem[]
  brief: { title: string; content: string; model: string; updatedAt: string } | null
  stats: { total: number; crossSource: number; byCategory: Record<string, number> }
}

// ---------- 周报 / 月报 ----------
export interface PeriodReport {
  kind: 'week' | 'month'
  label: string
  start: string
  end: string
  /** 周期是否还没结束（本周只过了几天） */
  partial: boolean
  daysElapsed: number
  deltaNote: string | null
  totals: { articles: number; perDay: number; crossEvents: number; bursts: number; deltaPct: number | null }
  categories: { category: string; label: string; count: number; share: number }[]
  topEvents: { title: string; sourceCount: number; articleCount: number; category: string; date: string }[]
  topEntities: { name: string; count: number }[]
  bursts: { date: string; category: string; count: number; z: number }[]
  highlights: string[]
}

// ---------- AI 热点榜 ----------
export interface HotItem {
  rank: number
  title: string
  category: string
  eventKeys: string[]
  sources: number
  articles: number
  hot: number
  recent: number
  deltaPct: number | null
  isNew: boolean
  firstSeen: string
  lastSeen: string
  /** 近 24 小时逐小时新增（旧→新，24 个桶） */
  hourly: number[]
  /** 同一事件的其它报道（仅前 3 名有，用于大卡） */
  related: { id: number; title: string; url: string; sourceName: string }[]
  /** 参与报道的来源 + 各自最新一篇原文直链（item 8） */
  sourceLinks: { name: string; url: string }[]
  /** 跨天事件的时间线（单日事件为空数组；item 5） */
  timeline: { date: string; items: { title: string; sourceName: string; url: string }[] }[]
  topArticle: {
    id: number
    title: string
    url: string
    sourceName: string
    publishedAt: string
    tldr: string | null
    summary: string | null
  } | null
}

export interface HotResponse {
  hours: number
  updatedAt: string
  items: HotItem[]
}


// ---------- 概览首屏聚合（一次请求拿齐六份数据） ----------
export interface OverviewResponse {
  health: Health
  velocity: VelocityResponse
  cross: CrossSourceResponse
  summaries: { items: SummaryListItem[] }
  entities: { days: number; items: EntityItem[] }
  sentiment: SentimentResponse
}

// ---------- AI 估值与危机风险（独立模块） ----------
export interface RiskFactor {
  key: string
  label: string
  value: number | null
  score: number | null
  weight: number
  note: string
}

export interface NarrativeReport {
  windowDays: number
  articles: number
  classified: number
  nfi: number | null
  band: 'calm' | 'warm' | 'hot' | 'unknown'
  factors: RiskFactor[]
  observations: { key: string; label: string; value: string }[]
  latestDate: string | null
}

export interface MacroPoint {
  key: string
  label: string
  value: number
  asOf: string
  yearAgo: number | null
  avg200: number | null
  /** 52 周最高值（算回撤用） */
  high52w: number | null
  /** 历史序列（分位数 / Z-Score 用） */
  history: number[]
  source: string
}

export interface MacroSnapshot {
  available: boolean
  missing: string[]
  series: Record<string, MacroPoint>
  /** 收益率曲线是否倒挂（2Y > 10Y） */
  inversion: boolean | null
  notes: string[]
  fetchedAt: string
}

export interface CrisisAssessment {
  score: number
  level: 'low' | 'guarded' | 'elevated' | 'high'
  /** 情景参考区间（不是预测概率） */
  probability12m: { low: number; high: number; note: string; label?: string; scope?: string } | null
  /** v2 因子：带分位数、Z-Score 与贡献分（瀑布图用） */
  factors: RiskFactorV2[]
}

/** 诊断子指数（v0.28.0）：不参与总分，只解释"是哪一种风险" */
export interface SubIndex {
  score: number
  label: string
  question: string
  parts: { label: string; score: number; weight: number }[]
  note: string
}

/** 数据质量（v0.29.0）：状态标签 + 明确门槛，不再输出"可信度 XX 分" */
export type QualityStatus = 'sufficient' | 'partial' | 'insufficient' | 'stale'

export interface QualityDimension {
  key: string
  label: string
  value: string
  status: QualityStatus
  rule: string
}

export interface RiskQuality {
  status: QualityStatus
  headline: string
  dimensions: QualityDimension[]
  macro: {
    series: {
      key: string
      label: string
      asOf: string | null
      rows: number
      from: string | null
      to: string | null
      ok: boolean
      proxy?: string
    }[]
    staleDays: number | null
    missing: string[]
  }
  unavailable: string[]
  notes: string[]
}

/** 回测：事件级指标（v0.29.0） */
export interface BacktestEventDetail {
  label: string
  date: string
  hit: boolean
  leadDays: number | null
  maxScoreInWindow: number | null
}

export interface BacktestEventMetrics {
  event: string
  label: string
  samples: number
  positives: number
  baseRate: number
  auc: number
  aucInverted: number
  direction: 'correct' | 'inverted' | 'flat'
  fpr: number
  fdr: number
  alertsPerYear: number
  eventRecall: number
  eventsTotal: number
  eventsHit: number
  eventDetail: BacktestEventDetail[]
  medianLeadDays: number | null
  effectiveSamples: number
}

export interface BacktestBootstrap {
  blockLength: number
  lo: number | null
  hi: number | null
  valid: number
  requested: number
}

export interface BacktestAblation {
  name: string
  change: string
  testAuc: number
  eventRecall: number
  alertsPerYear: number
  deltaAuc: number
}

export interface BacktestBaseline {
  name: string
  threshold: number
  auc: number
  eventRecall: number
  alertsPerYear: number
  medianLeadDays: number | null
}

export interface BacktestSplit {
  name: string
  trainFrom: string
  trainTo: string
  testFrom: string
  testTo: string
  purgeCutoff: string
  trainSamples: number
  testSamples: number
  /** 落在训练期的事件（只用于选阈值，不参与评估） */
  eventsInTrain: string[]
  /** 落在测试期的事件（真正被检验的） */
  eventsInTest: string[]
  threshold: { value: number; rule: string; maxAlertsPerYear: number }
  events: Record<string, BacktestEventMetrics>
  /** 简单基线，按事件分开 */
  baselines: Record<'drawdown20' | 'systemic', BacktestBaseline[]>
  bootstrap: Record<string, BacktestBootstrap[]>
  ablation: BacktestAblation[]
}

export interface RiskBacktest {
  generatedAt: string
  positioning: string
  dataRange: { from: string; to: string }
  sampling: string
  splits: { main: BacktestSplit; aux: BacktestSplit }
  leakChecks: { name: string; ok: boolean; detail: string }[]
  caveats: string[]
  seriesCoverage: { series: string; rows: number; from: string; to: string }[]
}

export interface RiskReport {
  generatedAt: string
  windowDays: number
  narrative: NarrativeReport
  macro: MacroSnapshot
  crisis: CrisisAssessment | null
  disclaimer: string
  // ---- v0.26.0 新增（并行返回，旧字段不变）----
  /** NFI v2（FOMO + 非线性加速度） */
  nfi: NfiResult | null
  /** 瀑布图归因 */
  waterfall: { label: string; value: number; kind: 'base' | 'item' | 'total' }[] | null
  /** 三条诊断子指数（过热 / 当前压力 / 潜在脆弱），不参与总分 */
  subIndices?: { overheat: SubIndex; stress: SubIndex; fragility: SubIndex } | null
  /** 数据质量与可信度 */
  quality?: RiskQuality
  /** 背离预警 */
  divergences: Divergence[]
  /** 宏观背景下最脆弱的实体 */
  vulnerableEntities: VulnerableEntity[]
  /** 当前生效参数 */
  params: RiskParams
  /** 公式说明（tooltip 直接渲染） */
  formulas: { key: string; title: string; formula: string; detail: string }[]
}

export interface RiskFactorV2 {
  key: string
  label: string
  value: number | null
  percentile: number | null
  z: number | null
  score: number
  weight: number
  contribution: number
  note: string
}

export interface NfiFactor {
  key: string
  label: string
  value: number | null
  score: number | null
  weight: number
  note: string
}

export interface NfiResult {
  score: number | null
  band: 'calm' | 'warm' | 'hot' | 'unknown'
  factors: NfiFactor[]
  fomo: { score: number; hits: string[]; exclaimDensity: number; breadth?: number; depth?: number; articles?: number }
}

export interface Divergence {
  type: 'sentiment_price' | 'heat_funding' | 'narrative_macro'
  typeLabel: string
  severity: 'warning' | 'critical'
  title: string
  detail: string
  entity: string | null
  metrics: { label: string; value: string }[]
}

export interface VulnerableEntity {
  entity: string
  negative: number
  mentions: number
  negativeShare: number
  heatChange: number | null
  funding: number
  score: number
  reason: string
}

export interface RiskParams {
  nfi: { money: number; sentiment: number; concentration: number; acceleration: number; fomo: number }
  acceleration: { threshold: number; sharpness: number }
  crs: { nfi: number; rates: number; credit: number; index: number }
  steps: { oas: number; rates: number; sharpness: number }
  dynamic: { drawdown: number; boost: number }
  divergence: { optimisticSentiment: number; downDays: number; surgeRatio: number; fundingDropRatio: number }
  probability: { base: number; scale: number; band: number }
}

export interface RiskHistoryPoint {
  date: string
  nfi: number | null
  crs: number | null
}

// ---------- 实体别名 / 底表映射 / 调试（v0.24.0） ----------
export interface AliasRule {
  id: number
  alias: string
  canonical: string
  note: string | null
  created_at: string
}

export interface MappingRow {
  raw: string
  canonical: string
  source: string
  updated_at: string
  mentions: number
}

export interface EntityDailySeries {
  dates: string[]
  series: { name: string; values: number[] }[]
}

export interface CollectSourceStat {
  id: string
  name: string
  runs: number
  successRate: number | null
  avgMs: number | null
  maxMs: number | null
  lastAt: string | null
  lastStatus: string | null
  failStreak: number
}

export interface CollectDebug {
  days: number
  perSource: CollectSourceStat[]
  daily: { d: string; runs: number; fails: number }[]
  errors: { source_id: string; error: string | null; at: string }[]
}

export interface AiStatusDebug {
  days: number
  byDay: { d: string; ok: number; failed: number; timeout: number; heuristic: number }[]
  recent: { id: number; title: string; ai_status: string; ai_error: string | null; published_at: string; source_name: string }[]
}
