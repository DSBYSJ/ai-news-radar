/**
 * 实体归一化重算（异步 CLI，不阻塞接口）
 *
 *   node src/entities/run.ts            # 干跑：只看会怎么合并
 *   node src/entities/run.ts -- --apply # 写入 entity_mapping
 */
import { getDb } from '../db.ts'
import { realign } from './realign.ts'

const apply = process.argv.includes('--apply')
const db = getDb()
const report = realign(db, { apply })
console.log(`\n扫描提及 ${report.scanned} 次 / 原始实体 ${report.distinctRaw} 个 → 归一后 ${report.distinctCanonical} 个`)
console.log(`发生合并的分组 ${report.mergedGroups} 个（其中命中手工别名 ${report.ruleHits} 个，自动对齐 ${report.autoHits} 个）`)
if (report.samples.length > 0) {
  console.log('\n合并示例：')
  for (const s of report.samples.slice(0, 10)) {
    console.log(`  ${s.canonical}  ←  ${s.from.join('、')}`)
  }
}
console.log(apply ? '\n已写入 entity_mapping（mentions 原文未改动）。' : '\n（干跑：未写入。加 --apply 生效）')
db.close()
