import { closeDb } from '../db.ts'
import { runProcessing } from './pipeline.ts'

// CLI：npm run process -- --days=30 --limit=200 [--no-ai]
const args = process.argv.slice(2)
const flag = (name: string, fallback: number): number => {
  const hit = args.find((a) => a.startsWith(`--${name}=`))
  return hit ? Number(hit.split('=')[1]) : fallback
}
const useAi = !args.includes('--no-ai')

const startedAt = Date.now()
const summary = await runProcessing({
  sinceDays: flag('days', 30),
  limit: flag('limit', 500),
  useAi,
})

console.log('')
console.log(
  `加工完成：扫描 ${summary.scanned} 条 / 新入库 ${summary.classified} 条 / 深加工 ${summary.deepProcessed} 条` +
    `（模式 ${summary.mode}，AI 失败 ${summary.aiErrors} 条），耗时 ${((Date.now() - startedAt) / 1000).toFixed(1)}s`,
)
if (summary.aiErrors > 0 && summary.lastError) {
  console.log(`  AI 失败原因：${summary.lastError}`)
}
console.log('')

closeDb()
