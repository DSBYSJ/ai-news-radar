import { closeDb } from '../db.ts'
import { generateDailySummary, yesterdayUtc } from './summary.ts'

// CLI：npm run summary -- [--date=YYYY-MM-DD|today|yesterday] [--backfill=N（从昨天往前 N 天）] [--force]
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]
const force = args.includes('--force')
const backfill = Number(flag('backfill') ?? 0)

const results = []
if (backfill > 0) {
  // 从「昨天」往回 N 天；不生成今天 —— 今天的数据还没收完，交给每日自动生成
  for (let i = 1; i <= backfill; i++) {
    const date = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)
    results.push(await generateDailySummary({ date, force }))
  }
} else {
  const raw = flag('date') ?? 'yesterday'
  const date = raw === 'today' ? new Date().toISOString().slice(0, 10) : raw === 'yesterday' ? yesterdayUtc() : raw
  results.push(await generateDailySummary({ date, force }))
}

console.log('')
for (const r of results) {
  if (!r.ok) console.log(`-  ${r.date} 跳过：${r.reason ?? '未知'}`)
  else if (r.skipped) console.log(`=  ${r.date} 已存在，跳过（${r.model}）`)
  else console.log(`+  ${r.date} 已生成（${r.model}）`)
}
console.log('')

closeDb()
