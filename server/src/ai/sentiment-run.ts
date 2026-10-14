import { closeDb } from '../db.ts'
import { runSentiment } from './sentiment.ts'

// CLI：npm run sentiment -- [--days=30] [--limit=500] [--no-ai]
const args = process.argv.slice(2)
const flag = (name: string): string | undefined => args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1]

const started = Date.now()
const result = await runSentiment({
  days: Number(flag('days') ?? 30),
  limit: Number(flag('limit') ?? 500),
  useAi: !args.includes('--no-ai'),
})

console.log('')
console.log(
  `情感判定完成：扫描 ${result.scanned} 条 / 更新 ${result.updated} 条（模式 ${result.mode}，耗时 ${((Date.now() - started) / 1000).toFixed(1)}s）`,
)
console.log('')

closeDb()
