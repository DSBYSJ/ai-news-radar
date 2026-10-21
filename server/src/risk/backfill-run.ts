/**
 * 风险回算 CLI（异步任务入口）
 *   node src/risk/backfill-run.ts --days=180 [--apply]
 */
import { getDb } from '../db.ts'
import { runBackfill } from './backfill.ts'

const apply = process.argv.includes('--apply')
const days = Math.max(7, Number(process.argv.find((a) => a.startsWith('--days='))?.slice(7) ?? 180))
const db = getDb()
console.log(`\n开始回算近 ${days} 天的风险日快照${apply ? '' : '（干跑）'}…`)
const r = await runBackfill(db, { days, apply })
console.log(`宏观历史写入 ${r.macroRows} 行`)
console.log(`日快照 ${r.snapshots} 天 | 耗时 ${r.ms}ms`)
console.log(`NFI 区间 ${r.nfiRange[0] ?? '—'} ~ ${r.nfiRange[1] ?? '—'} | CRS 区间 ${r.crsRange[0]} ~ ${r.crsRange[1]}`)
console.log(apply ? '已写入 risk_daily。' : '（干跑：未写入。加 --apply 生效）')
db.close()
