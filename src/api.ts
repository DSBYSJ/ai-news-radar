import type {
  ArticlesResponse,
  ArticleContent,
  AskResult,
  CategoryRatioPoint,
  CrossSourceResponse,
  DailyPoint,
  Edition,
  EntityItem,
  EntitySentimentResponse,
  ForecastResponse,
  GenerateSummaryResponse,
  Health,
  HotResponse,
  OverviewResponse,
  RiskReport,
  AliasRule,
  MappingRow,
  EntityDailySeries,
  CollectDebug,
  AiStatusDebug,
  PeriodReport,
  SentimentResponse,
  SourceItem,
  SummaryDetail,
  SummaryListItem,
  VelocityResponse,
} from './types.ts'

const BASE = '/api/news'

type Params = Record<string, string | number | undefined>

async function get<T>(path: string, params?: Params): Promise<T> {
  const url = new URL(`${BASE}${path}`, window.location.origin)
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== '') url.searchParams.set(k, String(v))
    }
  }
  const res = await fetch(url.toString(), { credentials: 'include' })
  if (!res.ok) throw new Error(`接口 ${path} 返回 ${res.status}`)
  return (await res.json()) as T
}

async function del<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`, { method: 'DELETE', credentials: 'include' })
  if (!res.ok) throw new Error(`接口 ${path} 返回 ${res.status}`)
  return (await res.json()) as T
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`接口 ${path} 返回 ${res.status}`)
  return (await res.json()) as T
}

export interface ArticleQuery {
  days?: number
  category?: string
  source?: string
  minScore?: number
  q?: string
  limit?: number
  offset?: number
  /** 1 = 连被判定为非 AI 的条目一起查（全局检索要能搜到全部） */
  includeOfftopic?: string
}

export const api = {
  health: () => get<Health>('/health'),
  sources: () => get<{ items: SourceItem[] }>('/sources'),
  articles: (q: ArticleQuery) => get<ArticlesResponse>('/articles', q as Params),
  articleContent: (id: number) => get<ArticleContent>(`/articles/${id}/content`),
  hot: (limit = 10, hours = 48) => get<HotResponse>('/hot', { limit, hours }),
  /** 概览首屏：1 次请求代替 health/velocity/cross/summaries/entities/sentiment 六个 */
  overview: () => get<OverviewResponse>('/overview'),
  // v0.24.0 实体别名 / 调试
  aliasList: () => get<{ items: AliasRule[] }>('/entities/aliases'),
  aliasSave: (alias: string, canonical: string, note = '') =>
    post<{ ok: boolean; items?: AliasRule[]; error?: string }>('/entities/aliases', { alias, canonical, note }),
  aliasDelete: (id: number) => del<{ ok: boolean; items?: AliasRule[] }>(`/entities/aliases?id=${id}`),
  entityMapping: (q = '', limit = 100) => get<{ items: MappingRow[] }>('/entities/mapping', { q, limit }),
  entitySeries: (names: string[], days = 30) => get<EntityDailySeries>('/entities/trend', { names: names.join(','), days }),
  realignStart: () => post<{ ok: boolean; jobId?: string }>('/entities/realign'),
  realignStatus: (id: string) => get<{ status: string; report?: unknown; error?: string }>(`/entities/realign/${id}`),
  collectDebug: (days = 7) => get<CollectDebug>('/debug/collect', { days }),
  aiStatus: (days = 14) => get<AiStatusDebug>('/debug/ai-status', { days }),

  /** 独立模块：AI 估值与危机风险（叙事指数 + 可选危机分） */
  risk: (days = 30) => get<RiskReport>('/risk', { days }),
  volume: (days: number) => get<{ days: number; points: DailyPoint[] }>('/trend/volume', { days }),
  category: (days: number) => get<{ days: number; points: CategoryRatioPoint[] }>('/trend/category', { days }),
  velocity: (days: number) => get<VelocityResponse>('/trend/velocity', { days }),
  cross: (days: number) => get<CrossSourceResponse>('/trend/cross', { days }),
  entities: (days: number, limit = 15) => get<{ days: number; items: EntityItem[] }>('/entities', { days, limit }),
  runCollect: () => post<unknown>('/collect'),
  runProcess: () => post<unknown>('/process'),
  forecast: (days = 30, horizon = 7) => get<ForecastResponse>('/forecast', { days, horizon }),
  ask: (question: string) => post<AskResult>('/ask', { question }),
  sentiment: (days = 30) => get<SentimentResponse>('/sentiment', { days }),
  entitySentiment: (entity: string, days = 30) =>
    get<EntitySentimentResponse>(`/sentiment/entity/${encodeURIComponent(entity)}`, { days }),
  summaries: (limit = 60) => get<{ items: SummaryListItem[] }>('/summaries', { limit }),
  summary: (date: string) => get<SummaryDetail>(`/summaries/${date}`),
  edition: (date?: string) => get<Edition>('/edition', { date }),
  period: (kind: 'week' | 'month', anchor?: string) => get<PeriodReport>('/period', { kind, anchor }),
  generateSummary: (date?: string, force = true) =>
    post<GenerateSummaryResponse>('/summaries/generate', { date, force }),
}
