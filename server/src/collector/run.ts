import { closeDb } from '../db.ts'
import { runCollect } from './index.ts'

// CLI 入口：npm run collect
const startedAt = Date.now()
const summary = await runCollect()

console.log('')
console.log(
  `采集完成：共抓到 ${summary.totalFetched} 条 / 新增入库 ${summary.totalInserted} 条，耗时 ${(
    (Date.now() - startedAt) / 1000
  ).toFixed(1)}s`,
)
console.log('')
for (const r of summary.sources) {
  if (r.ok) {
    console.log(`  ok    ${r.name.padEnd(18)} 抓到 ${r.fetched} 条 / 新增 ${r.inserted} / 去重跳过 ${r.skipped}  (${r.ms}ms)`)
  } else {
    console.log(`  FAIL  ${r.name.padEnd(18)} ${r.error}  (${r.ms}ms)`)
  }
}
console.log('')

// 全部源都失败才以非零码退出（部分成功属正常，单源失败不中断）
if (summary.sources.length > 0 && summary.sources.every((r) => !r.ok)) {
  process.exitCode = 1
}

closeDb()
