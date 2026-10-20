import { readFileSync } from 'node:fs'
import path from 'node:path'

// 加载 server/.env（不存在时静默跳过 —— 本地无 .env 也能按默认值跑）
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, '../.env'))
} catch {
  // .env 不存在：使用下面的默认值
}

const rootDir = path.resolve(import.meta.dirname, '..')

// 版本号唯一来源：package.json（与骑行看板同约定）
const pkg = JSON.parse(readFileSync(path.join(rootDir, 'package.json'), 'utf8')) as { version: string }

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  host: process.env.HOST ?? '127.0.0.1',
  port: Number(process.env.PORT ?? 3001),
  databasePath: path.resolve(rootDir, process.env.DATABASE_PATH ?? './data/ai-news.db'),
  fetchUa: process.env.FETCH_UA ?? 'ai-news-radar/0.1 (personal feed reader)',
  /** 单源单轮最多入库多少条（防止 HN/IT之家 这类大流量源一次刷几百条） */
  maxItemsPerSource: Math.max(5, Number(process.env.MAX_ITEMS_PER_SOURCE ?? 50)),
  /** 只收最近 N 天发布的条目（挡住新源首次抓到的全量历史归档） */
  collectMaxAgeDays: Math.max(1, Number(process.env.COLLECT_MAX_AGE_DAYS ?? 3)),
  /** 失败退避：连续失败后，重试间隔 = min(backoffMax, backoffBase * 2^failStreak) */
  sourceBackoffBaseMin: Math.max(1, Number(process.env.SOURCE_BACKOFF_BASE_MIN ?? 10)),
  sourceBackoffMaxMin: Math.max(10, Number(process.env.SOURCE_BACKOFF_MAX_MIN ?? 360)),
  version: pkg.version,

  // DeepSeek（AI 加工；未配置 Key 时自动降级为启发式，不丢数据）
  deepseek: {
    apiKey: process.env.DEEPSEEK_API_KEY ?? '',
    model: process.env.DEEPSEEK_MODEL ?? 'deepseek-chat',
    baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com',
    timeoutMs: Number(process.env.DEEPSEEK_TIMEOUT_MS ?? 20_000),
  },
  aiEnabled: Boolean(process.env.DEEPSEEK_API_KEY),
  minScoreForDeep: Number(process.env.AI_MIN_SCORE_FOR_DEEP ?? 60),

  // 定时调度（分钟；0 = 关闭，本地开发默认关闭）
  scheduleIntervalMin: Number(process.env.SCHEDULE_INTERVAL_MIN ?? 0),
  scheduleRunOnStart: process.env.SCHEDULE_RUN_ON_START === 'true',
  /** 每天固定采集时间点（北京时间，逗号分隔）；留空则退回 SCHEDULE_INTERVAL_MIN 的间隔模式 */
  collectAt: process.env.COLLECT_AT ?? '07:00,10:00,13:00,17:00,21:00',
  /** 每日简报生成时刻（北京时间 HH:MM）；off 关闭。默认 23:00 生成当天 */
  summaryAt: process.env.SUMMARY_AT ?? '23:00',

  // 鉴权：与骑行看板共享 cd_session Cookie（未配置 JWT_SECRET 时不拦截，方便本地开发）
  jwtSecret: process.env.JWT_SECRET ?? '',
  allowedEmails: (process.env.ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
} as const
