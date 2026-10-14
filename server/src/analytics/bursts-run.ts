import { closeDb } from '../db.ts'
import { rebuildBursts } from './bursts.ts'

// CLI：npm run bursts —— 独立运行突发检测（输出 burst_detection 表）
const startedAt = Date.now()
const summary = await rebuildBursts({ days: 30 })

console.log('')
console.log(`突发检测完成：扫描 ${summary.scannedDays} 天，命中 ${summary.flagged} 条（耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s）`)
console.log('')

if (summary.flagged === 0) {
  console.log('  近 30 天没有 Z-score ≥ 2.5 的突发（属正常：日历效应未达异常阈值）')
} else {
  for (const r of summary.rows.slice(0, 15)) {
    console.log(
      `  ${r.date}  ${String(r.category).padEnd(16)} 文章 ${String(r.articleCount).padStart(3)} 条 / 基线 ${r.baselineMean}  z=${r.z}`,
    )
  }
}
console.log('')

closeDb()
