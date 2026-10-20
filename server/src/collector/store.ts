import type { DatabaseSync } from 'node:sqlite'
import type { FeedItem } from './parse.ts'
import type { SeedSource } from './sources.ts'
import { normalizeUrl, titleFingerprint } from './fingerprint.ts'

/** 幂等写入源清单（已存在则更新元信息，不动 last_* 与 enabled 字段） */
export function seedSources(db: DatabaseSync, sources: SeedSource[]): void {
  const stmt = db.prepare(`
    INSERT INTO sources (id, name, url, kind, weight)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name   = excluded.name,
      url    = excluded.url,
      kind   = excluded.kind,
      weight = excluded.weight
  `)
  for (const s of sources) {
    stmt.run(s.id, s.name, s.url, s.kind, s.weight)
  }
}

/**
 * 落库原始条目。
 * 去重第一道关靠 UNIQUE(source_id, guid) + INSERT OR IGNORE，由数据库兜底。
 * 返回新增条数（被忽略的即重复条目）。
 */
export function insertRawItems(db: DatabaseSync, sourceId: string, items: FeedItem[], fetchedAt: Date): number {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO raw_items
      (source_id, guid, url, url_norm, title, summary, content, published_at, fingerprint, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)

  let inserted = 0
  for (const item of items) {
    // published 缺失或非法时退化为抓取时间（不丢数据）
    const publishedAt = item.publishedAt ?? fetchedAt
    const result = stmt.run(
      sourceId,
      item.guid,
      item.url,
      normalizeUrl(item.url),
      item.title,
      item.summary || null,
      item.content ?? null,
      publishedAt.toISOString(),
      titleFingerprint(item.title),
      fetchedAt.toISOString(),
    )
    inserted += Number(result.changes)
  }
  return inserted
}

/** 抓取成功：记录状态并重置失败计数 */
export function markSourceOk(db: DatabaseSync, sourceId: string, at: Date): void {
  db.prepare("UPDATE sources SET last_fetch_at = ?, last_status = 'ok', fail_streak = 0 WHERE id = ?").run(
    at.toISOString(),
    sourceId,
  )
}

/** 抓取失败：记录状态并累加失败计数（不抛错、不中断整轮） */
export function markSourceFail(db: DatabaseSync, sourceId: string, message: string, at: Date): void {
  db.prepare('UPDATE sources SET last_fetch_at = ?, last_status = ?, fail_streak = fail_streak + 1 WHERE id = ?').run(
    at.toISOString(),
    `error:${message.slice(0, 280)}`,
    sourceId,
  )
}
