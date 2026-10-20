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
  return db
}

/** 结构迁移（幂等）：老库补新列（CREATE TABLE IF NOT EXISTS 不会更新已有表） */
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
