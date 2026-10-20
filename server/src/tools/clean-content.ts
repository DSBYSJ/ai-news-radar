/**
 * 库内正文清洗（不联网）
 *
 * 用途：转换规则升级后（如 htmlToText 改为保留段落、支持转义 HTML），
 * 把**已经在库里**的正文按新规则重洗一遍 —— 不需要回填（那些已不在 feed 里的旧条目也能洗到）。
 *
 *   node src/tools/clean-content.ts --dry-run
 *   node src/tools/clean-content.ts
 */
import { DatabaseSync } from 'node:sqlite'
import { htmlToText } from '../collector/parse.ts'
import { config } from '../config.ts'
import { getDb } from '../db.ts'

const dryRun = process.argv.includes('--dry-run')
const db: DatabaseSync = getDb()

interface Row {
  id: number
  content: string
}

const rows = db.prepare('SELECT id, content FROM raw_items WHERE content IS NOT NULL').all() as unknown as Row[]
const update = db.prepare('UPDATE raw_items SET content = ? WHERE id = ?')

let changed = 0
let dirty = 0
let shrunk = 0

if (!dryRun) db.exec('BEGIN')
try {
  for (const row of rows) {
    const before = row.content
    const after = htmlToText(before)
    if (after === before) continue
    // 统计"洗掉标签"的情况，方便判断是否真的有必要跑
    if (/<[a-z][^>]*>/i.test(before)) dirty += 1
    if (after.length < before.length * 0.7) shrunk += 1
    if (after.length === 0) continue
    changed += 1
    if (!dryRun) update.run(after, row.id)
  }
  if (!dryRun) db.exec('COMMIT')
} catch (err) {
  if (!dryRun) db.exec('ROLLBACK')
  console.error('清洗失败，已回滚：', err)
  process.exit(1)
}

console.log(`库内正文：${rows.length} 条`)
console.log(`需要重写：${changed} 条（其中含 HTML 标签 ${dirty} 条，长度骤减 ${shrunk} 条）`)
if (dryRun) console.log('（--dry-run：没有写入）')
else console.log('已写入。')
console.log(`数据库：${config.databasePath}`)
db.close()
