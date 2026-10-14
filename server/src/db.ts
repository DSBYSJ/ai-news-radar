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
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}
