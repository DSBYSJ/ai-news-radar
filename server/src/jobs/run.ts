import { closeDb } from '../db.ts'
import { runFullPipeline } from '../jobs.ts'

// CLI：npm run pipeline
const startedAt = Date.now()
const summary = await runFullPipeline()

console.log('')
console.log(`采集：抓到 ${summary.collect.totalFetched} 条 / 新增 ${summary.collect.totalInserted} 条`)
console.log(`加工：扫描 ${summary.process.scanned} 条 / 新入库 ${summary.process.classified} 条（模式 ${summary.process.mode}）`)
console.log(
  `事件：${summary.events.events} 个（跨源 ${summary.events.crossSourceEvents} 个，多条目 ${summary.events.multiArticleEvents} 个）`,
)
console.log(`突发：命中 ${summary.bursts.flagged} 条（14 天滑动基线，z ≥ 2.5）`)
console.log(
  `简报：${summary.summary.date} ${
    !summary.summary.ok ? `跳过（${summary.summary.reason}）` : summary.summary.skipped ? '已存在' : `已生成（${summary.summary.model}）`
  }`,
)
console.log(`总耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`)
console.log('')

closeDb()
