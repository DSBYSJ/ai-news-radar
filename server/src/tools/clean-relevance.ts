/**
 * 回填 AI 相关性（纯库内、不调模型）
 *
 * 用途：ai_relevant 是 v0.19.0 才有的字段，历史条目默认 1（全放行）。
 * 这个脚本用关键词规则重算一遍，把历史里的手机/家电/汽车类新闻标记为 0。
 *
 *   node src/tools/clean-relevance.ts --days=180 --dry-run
 *   node src/tools/clean-relevance.ts --days=180
 */
import { judgeRelevance } from '../ai/relevance.ts'
import { config } from '../config.ts'
import { getDb } from '../db.ts'

const argv = process.argv.slice(2)
const days = Math.max(1, Number(argv.find((a) => a.startsWith('--days='))?.slice(7) ?? 180))
const dryRun = argv.includes('--dry-run')
const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)

const db = getDb()
const rows = db
  .prepare(
    `SELECT a.id, a.title, COALESCE(a.summary, '') AS summary
       FROM articles a
      WHERE date(a.published_at) >= ?`,
  )
  .all(cutoff) as unknown as { id: number; title: string; summary: string }[]

const update = db.prepare('UPDATE articles SET ai_relevant = ? WHERE id = ?')
let toOfftopic = 0
let toAi = 0
const samples: string[] = []

if (!dryRun) db.exec('BEGIN')
try {
  for (const r of rows) {
    // 标题里带了非 AI 的消费电子话题，且无任何 AI 强信号 → 判为非 AI
    const verdict = judgeRelevance(r.title, r.summary)
    const target = verdict.relevant ? 1 : 0
    const cur = (db.prepare('SELECT ai_relevant AS v FROM articles WHERE id = ?').get(r.id) as { v: number }).v
    if (Number(cur) === target) continue
    if (target === 0) {
      toOfftopic += 1
      if (samples.length < 8) samples.push(r.title.slice(0, 40))
    } else {
      toAi += 1
    }
    if (!dryRun) update.run(target, r.id)
  }
  if (!dryRun) db.exec('COMMIT')
} catch (err) {
  if (!dryRun) db.exec('ROLLBACK')
  console.error('失败，已回滚：', err)
  process.exit(1)
}

console.log(`扫描 ${rows.length} 条（近 ${days} 天，早于 ${cutoff} 的不处理）`)
console.log(`标记为非 AI：${toOfftopic} 条；恢复为 AI：${toAi} 条`)
if (samples.length > 0) {
  console.log('被判为非 AI 的样本：')
  for (const s of samples) console.log('  -', s)
}
if (dryRun) console.log('（--dry-run：没有写入）')
console.log(`数据库：${config.databasePath}`)
db.close()
