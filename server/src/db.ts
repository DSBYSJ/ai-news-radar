import { mkdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { config } from './config.ts'

let db: DatabaseSync | null = null

/** 打开数据库并幂等建表（单例） */
export function getDb(): DatabaseSync {
  if (db) return db
  mkdirSync(path.dirname(config.databasePath), { recursive: true })
  db = new DatabaseSync(config.databasePath)
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA foreign_keys = ON;')
  db.exec(readFileSync(path.join(import.meta.dirname, 'schema.sql'), 'utf8'))
  migrate(db)
  migrateFundamentalVersions(db)
  return db
}

/** 结构迁移（幂等）：老库补新列（CREATE TABLE IF NOT EXISTS 不会更新已有表） */
/**
 * v0.41.0：company_fundamentals 从 PK(symbol, fiscal_end) 改为 PK(symbol, fiscal_end, filed_at)。
 * SQLite 不支持改主键，只能重建表。旧数据 filed_at 可能为空 → 退回 fiscal_end 并标 pit_reliable=0。
 */
function migrateFundamentalVersions(conn: DatabaseSync): void {
  const cols = conn.prepare('PRAGMA table_info(company_fundamentals)').all() as unknown as {
    name: string
    pk: number
  }[]
  if (cols.length === 0) return // 新库由 schema.sql 直接建成新版
  const pkCount = cols.filter((c) => c.pk > 0).length
  if (pkCount >= 3) return // 已是版本表

  conn.exec('BEGIN')
  try {
    conn.exec(`CREATE TABLE company_fundamentals_v2 (
      symbol TEXT NOT NULL, fiscal_end TEXT NOT NULL, filed_at TEXT NOT NULL,
      revenue REAL, net_income REAL, equity REAL, eps_diluted REAL, shares REAL,
      revenue_tag TEXT, pit_reliable INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL,
      PRIMARY KEY (symbol, fiscal_end, filed_at)
    )`)
    conn.exec(`INSERT INTO company_fundamentals_v2
        (symbol, fiscal_end, filed_at, revenue, net_income, equity, eps_diluted, shares, revenue_tag, pit_reliable, updated_at)
      SELECT symbol, fiscal_end, COALESCE(filed_at, fiscal_end), revenue, net_income, equity, eps_diluted, shares,
             revenue_tag,
             CASE WHEN filed_at IS NULL THEN 0 ELSE 1 END,
             updated_at
        FROM company_fundamentals`)
    conn.exec('DROP TABLE company_fundamentals')
    conn.exec('ALTER TABLE company_fundamentals_v2 RENAME TO company_fundamentals')
    conn.exec('COMMIT')
  } catch (err) {
    conn.exec('ROLLBACK')
    throw err
  }
}

function migrate(conn: DatabaseSync): void {
  const columns = conn.prepare('PRAGMA table_info(articles)').all() as unknown as { name: string }[]
  if (!columns.some((c) => c.name === 'sentiment')) {
    conn.exec('ALTER TABLE articles ADD COLUMN sentiment TEXT')
  }
  // v0.13.0：源提供全文时落库（仅自用、按天清理）
  const rawColumns = conn.prepare('PRAGMA table_info(raw_items)').all() as unknown as { name: string }[]
  if (!rawColumns.some((c) => c.name === 'content')) {
    conn.exec('ALTER TABLE raw_items ADD COLUMN content TEXT')
  }
  // v0.26.0：风险参数 / 宏观历史 / 风险日快照
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS risk_params (key TEXT PRIMARY KEY, params TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS macro_history (date TEXT NOT NULL, series TEXT NOT NULL, value REAL NOT NULL, PRIMARY KEY (date, series))`,
    `CREATE TABLE IF NOT EXISTS risk_daily (date TEXT PRIMARY KEY, nfi REAL, nfi_factors TEXT, crs REAL, crs_factors TEXT, divergences TEXT, created_at TEXT NOT NULL)`,
  ]) {
    conn.exec(ddl)
  }
  // v0.24.0：实体别名 / 底表映射 / 采集日志
  for (const ddl of [
    `CREATE TABLE IF NOT EXISTS entity_aliases (
       id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL UNIQUE, canonical TEXT NOT NULL,
       note TEXT, created_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS entity_mapping (
       raw TEXT PRIMARY KEY, canonical TEXT NOT NULL, source TEXT NOT NULL, updated_at TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS collect_log (
       id INTEGER PRIMARY KEY AUTOINCREMENT, source_id TEXT NOT NULL, ok INTEGER NOT NULL,
       fetched INTEGER DEFAULT 0, inserted INTEGER DEFAULT 0, ms INTEGER DEFAULT 0, error TEXT, at TEXT NOT NULL)`,
  ]) {
    conn.exec(ddl)
  }
  const artCols24 = conn.prepare('PRAGMA table_info(articles)').all() as unknown as { name: string }[]
  for (const [col, ddl] of [
    ['ai_status', 'ALTER TABLE articles ADD COLUMN ai_status TEXT'],
    ['ai_error', 'ALTER TABLE articles ADD COLUMN ai_error TEXT'],
    ['sentiment_keywords', 'ALTER TABLE articles ADD COLUMN sentiment_keywords TEXT'],
  ] as const) {
    if (!artCols24.some((c) => c.name === col)) conn.exec(ddl)
  }
  // v0.19.0：AI 相关性（非 AI 内容不进榜单/日报/列表）
  if (!columns.some((c) => c.name === 'ai_relevant')) {
    conn.exec('ALTER TABLE articles ADD COLUMN ai_relevant INTEGER DEFAULT 1')
  }
  // v0.17.0：连续失败计数，用于退避（失败源不再每轮空等 20s 超时）
  const srcColumns = conn.prepare('PRAGMA table_info(sources)').all() as unknown as { name: string }[]
  if (!srcColumns.some((c) => c.name === 'fail_streak')) {
    conn.exec('ALTER TABLE sources ADD COLUMN fail_streak INTEGER DEFAULT 0')
  }
}

export function closeDb(): void {
  db?.close()
  db = null
}
