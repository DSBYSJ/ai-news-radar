/**
 * 正文回填（一次性/可重复执行）
 *
 * 背景：正文入库是 v0.13.0 才有的，之前抓的条目只有标题+摘要。
 * 这个脚本重新拉一遍各源 feed，按 (source_id, guid) 把 content 补进去。
 *
 *   node src/tools/backfill-content.ts --days=7
 *   node src/tools/backfill-content.ts --days=7 --dry-run
 *
 * 只更新 content 为空的条目；不新增条目、不改摘要、不触发 AI。
 */
import { getDb } from '../db.ts'
import { fetchText } from '../collector/fetch.ts'
import { parseFeed } from '../collector/parse.ts'
import { SEED_SOURCES } from '../collector/sources.ts'

const argv = process.argv.slice(2)
const days = Math.max(1, Number(argv.find((a) => a.startsWith('--days='))?.slice(7) ?? 7))
const dryRun = argv.includes('--dry-run')
const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

const db = getDb()
const sources = db.prepare('SELECT id, name, url, kind FROM sources WHERE enabled = 1').all() as unknown as {
  id: string
  name: string
  url: string
  kind: string
}[]

const update = db.prepare(
  `UPDATE raw_items SET content = ?
    WHERE source_id = ? AND guid = ? AND content IS NULL AND date(published_at) >= ?`,
)

let total = 0
for (const source of sources) {
  try {
    const res = await fetchText(source.url)
    const feed = parseFeed(res.body)
    let filled = 0
    for (const item of feed.items) {
      if (!item.content) continue
      if (dryRun) {
        const hit = db
          .prepare(
            `SELECT COUNT(*) AS n FROM raw_items
              WHERE source_id = ? AND guid = ? AND content IS NULL AND date(published_at) >= ?`,
          )
          .get(source.id, item.guid, cutoff) as { n: number }
        filled += Number(hit.n)
        continue
      }
      filled += Number(update.run(item.content, source.id, item.guid, cutoff).changes)
    }
    total += filled
    console.log(`${source.name.padEnd(22)} 带正文 ${feed.items.filter((i) => i.content).length} 条，${dryRun ? '可补' : '已补'} ${filled} 条`)
  } catch (err) {
    console.log(`${source.name.padEnd(22)} 失败：${err instanceof Error ? err.message.slice(0, 60) : String(err)}`)
  }
}

console.log(`\n合计${dryRun ? '可补' : '已补'} ${total} 条（近 ${days} 天，早于 ${cutoff} 的不处理）`)
if (dryRun) console.log('（--dry-run：没有写入。去掉该参数才真正回填）')

const size = db.prepare("SELECT COALESCE(SUM(length(content)),0) AS b, COUNT(*) AS n FROM raw_items WHERE content IS NOT NULL").get() as {
  b: number
  n: number
}
console.log(`当前库内正文：${size.n} 条，共 ${(Number(size.b) / 1024).toFixed(0)} KB`)
console.log(`可用源示例：${SEED_SOURCES.length} 个（仅用于自检，不影响回填）`)
