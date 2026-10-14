import { getDb, closeDb } from '../db.ts'
import { rebuildEvents } from './events.ts'

// CLI：npm run clusters —— 独立运行事件聚类（输出 event_clusters 表）
const startedAt = Date.now()
const summary = await rebuildEvents()

console.log('')
console.log(
  `事件聚类完成：扫描 ${summary.scanned} 条 / 事件 ${summary.events} 个 / 跨源 ${summary.crossSourceEvents} 个 / 多条目 ${summary.multiArticleEvents} 个` +
    `（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
)
console.log('')

const db = getDb()
const top = db
  .prepare(
    `SELECT representative_title, source_count, article_count, sources_list, publish_date
     FROM event_clusters ORDER BY source_count DESC, article_count DESC LIMIT 6`,
  )
  .all() as unknown as { representative_title: string; source_count: number; article_count: number; sources_list: string; publish_date: string }[]

console.log('源数最高的几个事件：')
for (const r of top) {
  console.log(`  [${r.source_count}源/${r.article_count}条] ${r.publish_date} ${String(r.representative_title).slice(0, 46)}`)
  console.log(`      来源：${r.sources_list}`)
}
console.log('')

closeDb()
