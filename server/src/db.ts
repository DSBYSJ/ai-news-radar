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
}

export function closeDb(): void {
  db?.close()
  db = null
}
