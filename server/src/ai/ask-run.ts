import { closeDb } from '../db.ts'
import { askQuestion } from './ask.ts'

// CLI：npm run ask -- "本周 Agent 类文章有几篇？"
const question = process.argv.slice(2).join(' ').trim()
if (!question) {
  console.error('用法：npm run ask -- "你的问题"')
  process.exit(1)
}

const started = Date.now()
const result = await askQuestion(question)

console.log('')
console.log(`问题：${question}`)
console.log(`类型：${result.kind === 'stats' ? '统计（Text-to-SQL）' : '归因（向量检索 + 上下文）'} · 模式 ${result.mode}${result.note ? ` · ${result.note}` : ''}`)
console.log('-'.repeat(60))
console.log(result.answer)
if (result.sql) console.log(`\nSQL：\n${result.sql}`)
if (result.sources.length > 0) {
  console.log('\n引用来源：')
  for (const s of result.sources) {
    console.log(`  [${s.index}] ${s.title}  —— ${s.sourceName} ${s.date}（相似度 ${s.similarity}）\n      ${s.url}`)
  }
}
console.log(`\n耗时 ${((Date.now() - started) / 1000).toFixed(1)}s\n`)

closeDb()